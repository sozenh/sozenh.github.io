---
title: "深入理解 kube-scheduler(2)-调度流程完全解析"
date: 2026-01-14T15:00:00+08:00
draft: false
tags: ["kubernetes", "源码解析", "kube-scheduler"]
summary: "从源码层面深入走读 kube-scheduler 的核心调度流程"
---

# 深入理解 kube-scheduler(2) - 调度流程完全解析

## 目录
- [1. 概述](#1-概述)
- [2. 调度流程全景图](#2-调度流程全景图)
- [3. 核心数据结构](#3-核心数据结构)
- [4. scheduleOne 代码走读](#4-scheduleone-代码走读)
- [5. 关键机制深度分析(持续补充中)](#5-关键机制深度分析)

---

## 1. 概述

`scheduleOne` 是 Kubernetes Scheduler 的**核心调度函数**,负责将单个 Pod 从队列中取出并完成整个调度流程。理解 `scheduleOne` 是掌握调度器工作原理的关键。

### 1.1 调度流程在 Scheduler 中的位置

```
┌──────────────────────────────────────────┐
│              kube-scheduler              │
├──────────────────────────────────────────┤
│  Run()                                   │
│   │                                      │
│   └── wait.Until(scheduleOne)  ← 循环调用 │
│        │                                 │
│        └──► scheduleOne(ctx)             │
└──────────────────────────────────────────┘
```

### 1.2 调度成功的定义

**Pod 调度成功的标志**:
1. `spec.nodeName` 被设置为选中的节点名
2. Pod 的 `.status.phase` 变为 `Running`
3. Pod 实际运行在目标节点上

**调度流程的输出**:

- API Server 中 Pod 对象的 `spec.nodeName` 字段被更新
- Kubelet 监听到 Pod 分配事件,开始在节点上创建容器

---

## 2. 调度流程全景图

### 2.1 完整时间线

```
T0: scheduleOne 开始
    │
    ├─▶ 从队列弹出 Pod
    │
    ├─▶ 根据 schedulerName 选择对应的 Framework
    │
    ├─▶ 创建 CycleState (数据传递容器)
    │
T1: 调度阶段
    │
    ├─▶ SchedulePod()
    │    │
    │    ├─▶ UpdateSnapshot: 确保调度流程中看到的环境信息保持一致
    │    │
    │    ├─▶ FindNodesThatFitPod: 找到合适的节点
    │    │    │
    │    │    │─▶ PreFilter(扩展点2): 预处理 Pod 信息
    │    │    │─▶ EvaluateNominatedNode: 评估抢占节点，如果有
    │    │    │─▶ Filter(扩展点3): 过滤掉不符合条件的节点
    │    │    └─▶ Extender.Filter: HTTP 层面的扩展点，多语言+动态加载
    │    │
    │    ├─▶ PrioritizeNodes: 为所有合适的节点打分
    │    │    │
    │    │    │─▶ PreScore(扩展点5): 打分前的预处理
    │    │    │─▶ Score(扩展点6): 为节点打分
    │    │    │─▶ NormalizeScore(扩展点7): 归一化分数到统一范围
    │    │    └─▶ Extender.Prioritize: HTTP 层面的扩展点，多语言+动态加载
    │    │
    │    └─▶ SelectHost: 选择最高分节点
    │
    ├─▶ PostFilter(扩展点4): 如果调度流程失败,调用 PostFilter 尝试抢占，下次调度时优先评估抢占节点
    │
T2: 假定阶段
    │
    ├─▶ Cache.AssumePod(pod, nodeName): 一旦为 Pod 找到合适的节点，则假定其已经调度成功，并更新 NodeInfo 的资源使用量，无需等待 apiServer 相应从而提高调度效率
    │
T3: 预留阶段
    │
    ├─▶ RunReservePluginsReserve(扩展点8): 为 Pod 所需资源做预留处理 (如 PV 绑定)
    │
T4: 许可阶段
    │
    ├─▶ RunPermitPlugins(扩展点9): 检查当前调度是否需要等待被许可，如果返回 Wait 则在后续绑定节点需要等待许可
    │
T5: 激活相关 Pod
    │
    ├─▶ Activate(podsToActivate)
    │    └─▶ 将因抢占等待的 Pod 重新加入队列
    │
T6: 绑定阶段 [异步执行]
    │
    └─▶ 启动 Goroutine
         │
         ├─▶ WaitOnPermit: 等待被许可，如果有
         ├─▶ PreBind(扩展点10): 绑定前的准备工作
         ├─▶ Bind(扩展点11): 将 Pod 绑定到节点，通常需要与 APIServer 交互
         ├─▶ PostBind(扩展点12): 绑定后的清理工作
         ├─▶ Cache.FinishBinding: 将假定缓存中的 Pod 标记为完成
         └─▶ Activate(podsToActivate): 将调度过程中检测到需要激活的 Pod 重新加入队列

```

---

## 3. 核心数据结构

### 3.1 ScheduleResult

**用途**: 调度算法的返回值,包含选中节点和统计信息

```go
type ScheduleResult struct {
    SuggestedHost string // SuggestedHost 是推荐的节点名
	FeasibleNodes int    // FeasibleNodes 是通过 Filter 的节点数量
    EvaluatedNodes int   // EvaluatedNodes 是评估过的节点数量，包括 Filter 和 Score 阶段
}
```

### 3.2 CycleState

**用途**: 在插件间传递上下文，避免重复计算

```go
type CycleState struct {
    storage sync.Map    // storage is keyed with StateKey, and valued with StateData.
    recordPluginMetrics bool
}

type StateKey string

type StateData interface {
    Clone() StateData
}
```

---

## 4. scheduleOne 代码走读


**位置**: `pkg/scheduler/schedule_one.go:66-265`

```go
func (sched *Scheduler) scheduleOne(ctx context.Context) {
    // ===== 步骤 1: 从队列获取 Pod =====
    podInfo := sched.NextPod()
    if podInfo == nil || podInfo.Pod == nil {
        return
    }
    pod := podInfo.Pod

    // ===== 步骤 2: 根据 schedulerName 选择对应的 Framework =====
    fwk, err := sched.frameworkForPod(pod)
    if err != nil {
        return
    }

    // ===== 步骤 3: 创建 CycleState (插件间数据传递容器) =====
    state := framework.NewCycleState()
    state.SetRecordPluginMetrics(rand.Intn(100) < pluginMetricsSamplePercent)

    // 初始化 podsToActivate,用于存储抢占相关需要激活的 Pod
    podsToActivate := framework.NewPodsToActivate()
    state.Write(framework.PodsToActivateKey, podsToActivate)

    // 创建调度上下文
    schedulingCycleCtx, cancel := context.WithCancel(ctx)
    defer cancel()

    // ===== 步骤 4: 执行调度算法,返回选中的节点 =====
    scheduleResult, err := sched.SchedulePod(schedulingCycleCtx, fwk, state, pod)

    if err != nil {
        // ===== 调度失败: 尝试抢占,然后加入 unschedulableQ =====
        var nominatingInfo *framework.NominatingInfo

        if fitError, ok := err.(*framework.FitError); ok {
            // 尝试抢占 (运行 PostFilter 插件)
            if fwk.HasPostFilterPlugins() {
                result, status := fwk.RunPostFilterPlugins(ctx, state, pod, fitError.Diagnosis.NodeToStatusMap)
                if result != nil {
                    nominatingInfo = result.NominatingInfo
                }
            }
        }

        sched.handleSchedulingFailure(fwk, podInfo, err, reason, nominatingInfo)
        return
    }

    // ===== 步骤 5: Assume (假定 Pod 已调度到节点) =====
    assumedPodInfo := podInfo.DeepCopy()
    assumedPod := assumedPodInfo.Pod

    // 立即更新 Cache,无需等待 API Server 响应
    err = sched.assume(assumedPod, scheduleResult.SuggestedHost)
    if err != nil {
        // Assume 失败: 撤销并重新调度
        sched.handleSchedulingFailure(fwk, assumedPodInfo, err, SchedulerError, clearNominatedNode)
        return
    }

    // ===== 步骤 6: Reserve (预留资源) =====
    sts := fwk.RunReservePluginsReserve(schedulingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
    if !sts.IsSuccess() {
        // Reserve 失败: 触发 Unreserve + ForgetPod
        fwk.RunReservePluginsUnreserve(schedulingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
        sched.Cache.ForgetPod(assumedPod)
        sched.handleSchedulingFailure(fwk, assumedPodInfo, sts.AsError(), SchedulerError, clearNominatedNode)
        return
    }

    // ===== 步骤 7: Permit (许可) =====
    runPermitStatus := fwk.RunPermitPlugins(schedulingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)

    if runPermitStatus.Code() != framework.Wait && !runPermitStatus.IsSuccess() {
        // Permit 拒绝: 触发 Unreserve + ForgetPod
        fwk.RunReservePluginsUnreserve(schedulingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
        sched.Cache.ForgetPod(assumedPod)
        sched.handleSchedulingFailure(fwk, assumedPodInfo, runPermitStatus.AsError(), reason, clearNominatedNode)
        return
    }

    // ===== 步骤 8: 激活相关 Pod =====
    // 将抢占相关需要重新调度的 Pod 加入队列
    if len(podsToActivate.Map) != 0 {
        sched.SchedulingQueue.Activate(podsToActivate.Map)
        podsToActivate.Map = make(map[string]*v1.Pod)
    }

    // ===== 步骤 9: 异步绑定 (启动 Goroutine) =====
    go func() {
        bindingCycleCtx, cancel := context.WithCancel(ctx)
        defer cancel()

        // 等待 Permit 批准 (如果返回了 Wait)
        waitOnPermitStatus := fwk.WaitOnPermit(bindingCycleCtx, assumedPod)
        if !waitOnPermitStatus.IsSuccess() {
            // WaitOnPermit 失败: 触发 Unreserve + ForgetPod
            fwk.RunReservePluginsUnreserve(bindingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
            sched.Cache.ForgetPod(assumedPod)
            sched.handleSchedulingFailure(fwk, assumedPodInfo, waitOnPermitStatus.AsError(), SchedulerError, clearNominatedNode)
            return
        }

        // 运行 PreBind 插件
        preBindStatus := fwk.RunPreBindPlugins(bindingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
        if !preBindStatus.IsSuccess() {
            // PreBind 失败: 触发 Unreserve + ForgetPod
            fwk.RunReservePluginsUnreserve(bindingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
            sched.Cache.ForgetPod(assumedPod)
            sched.handleSchedulingFailure(fwk, assumedPodInfo, preBindStatus.AsError(), SchedulerError, clearNominatedNode)
            return
        }

        // 执行 Bind (调用 API Server 更新 Pod.spec.nodeName)
        err := sched.bind(bindingCycleCtx, fwk, assumedPod, scheduleResult.SuggestedHost, state)
        if err != nil {
            // Bind 失败: 触发 Unreserve + ForgetPod
            fwk.RunReservePluginsUnreserve(bindingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
            sched.Cache.ForgetPod(assumedPod)
            sched.handleSchedulingFailure(fwk, assumedPodInfo, fmt.Errorf("binding rejected: %w", err), SchedulerError, clearNominatedNode)
            return
        }

        // 运行 PostBind 插件
        fwk.RunPostBindPlugins(bindingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
    }()
}
```

### 4.2 步骤解析

#### 步骤 1: 从队列获取 Pod

```go
podInfo := sched.NextPod()
```

**作用**: 从调度队列中取出优先级最高的 Pod

**特点**:
- 如果队列为空,会**阻塞等待**
- 返回 `*QueuedPodInfo`,包含 Pod 和元数据(Attempts, UnschedulablePlugins 等)

---

#### 步骤 2: 选择对应的 Framework

```go
fwk, err := sched.frameworkForPod(pod)
```

**作用**: 根据 Pod 的 `spec.schedulerName` 选择对应的调度配置(Profile)

---

#### 步骤 3: 创建 CycleState

```go
state := framework.NewCycleState()
podsToActivate := framework.NewPodsToActivate()
state.Write(framework.PodsToActivateKey, podsToActivate)
```

**作用**: 创建插件间数据传递的容器

**CycleState 用途**:
- PreFilter 插件写入预计算的数据
- Filter/Score 插件读取这些数据,避免重复计算
- 存储因抢占需要激活的 Pod 列表

---

#### 步骤 4: 执行调度算法

```go
scheduleResult, err := sched.SchedulePod(schedulingCycleCtx, fwk, state, pod)
```

**作用**: 运行完整的调度流程,返回选中的节点

**内部流程**:
1. **PreFilter**: 预处理,可返回需要检查的节点子集
2. **Filter**: 过滤不符合条件的节点
3. **findNodesThatPassExtenders**: Extender 进一步过滤
4. **PostFilter**: 如果失败,尝试抢占
5. **PreScore + Score + NormalizeScore**: 为节点打分
6. **selectHost**: 选择得分最高的节点

**返回**:
- `ScheduleResult{SuggestedHost, EvaluatedNodes, FeasibleNodes}`
- 如果失败,返回 `error` (类型为 `*framework.FitError`)

---

#### 步骤 5: Assume (假定)

```go
err = sched.assume(assumedPod, scheduleResult.SuggestedHost)
```

**作用**: 乐观并发控制,立即更新 Cache,无需等待 API Server

**为什么要 Assume?**
- 提升性能: 下一个 Pod 调度时能看到已占用的资源
- 避免"资源超发": 如果不立即更新 Cache,多个 Pod 可能被调度到同一个节点

**Assume 流程**:
```
Cache.AssumePod(pod)
  ├─▶ 添加到 assumedPods 集合
  ├─▶ 设置 bindingFinished = false
  ├─▶ 计算过期时间 (15 分钟)
  └─▶ 更新 NodeInfo 的资源使用量
```

**如果 Bind 失败**:
- 调用 `Cache.ForgetPod(pod)` 撤销 Assume
- Pod 重新调度

---

#### 步骤 6: Reserve (预留)

```go
sts := fwk.RunReservePluginsReserve(schedulingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
```

**作用**: 在绑定前预留资源 (如 PV 绑定)

**特点**:
- **同步执行**
- 如果失败,触发 `Unreserve` 撤销预留

**失败处理**:

```go
if !sts.IsSuccess() {
    // 1. 触发 Unreserve (清理预留状态)
    fwk.RunReservePluginsUnreserve(schedulingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)

    // 2. 撤销 Assume
    sched.Cache.ForgetPod(assumedPod)

    // 3. 处理调度失败
    sched.handleSchedulingFailure(...)
}
```

---

#### 步骤 7: Permit (许可)

```go
runPermitStatus := fwk.RunPermitPlugins(schedulingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
```

**作用**: 可能阻塞等待外部批准 (如人工审批、资源准备)

**返回值处理**:
- `Success`: 立即继续
- `Wait`: 在异步绑定阶段等待批准
- `Unschedulable/Error`: 拒绝,触发 Unreserve

**特点**:
- **同步执行** (不是异步!)
- 如果返回 `Wait`,不会在这里等待,而是在后续的异步绑定阶段等待

**为什么不在同步阶段等待 Wait?**
- 避免阻塞调度流程
- 允许多个 Pod 同时处于 Waiting 状态

---

#### 步骤 8: 激活相关 Pod

```go
if len(podsToActivate.Map) != 0 {
    sched.SchedulingQueue.Activate(podsToActivate.Map)
}
```

**作用**: 将因抢占等待的 Pod 重新加入队列

**时机**:
- 在 Permit 之后、异步绑定之前执行
- 抢占成功后,被抢占的 Pod 需要重新调度

**podsToActivate 来源**:
- PostFilter 插件 (抢占插件) 写入 CycleState
- 包含因抢占而被停止的 Pod

---

#### 步骤 9: 异步绑定

```go
go func() {
    // 1. 等待 Permit 批准 (如果返回了 Wait)
    waitOnPermitStatus := fwk.WaitOnPermit(bindingCycleCtx, assumedPod)

    // 2. 运行 PreBind 插件
    preBindStatus := fwk.RunPreBindPlugins(bindingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)

    // 3. 执行 Bind (调用 API Server)
    err := sched.bind(bindingCycleCtx, fwk, assumedPod, scheduleResult.SuggestedHost, state)

    // 4. 运行 PostBind 插件
    fwk.RunPostBindPlugins(bindingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
}()
```

**为什么异步执行?**

- **提升吞吐量**: Bind 需要调用 API Server,可能耗时 100ms+
- **不阻塞调度**: 一个 Pod 绑定时,可以同时调度下一个 Pod

**Bind 的作用**:
- 调用 API Server 更新 Pod 的 `spec.nodeName`，真正将 Pod 分配到节点上


---

## 5. 关键机制深度分析

### 5.1 snapshot

**调度决策基于一个一致性快照，而不是实时状态**

- 在每轮调度开始前，创建一致性快照，确保该轮调度用**同一份状态**
- 避免：调度过程中状态变化导致不一致 或 多次 List / Watch 抖动，确保最终一致即可

### 5.2 Permit 插件

**Permit 插件可以实现"审批制调度"**

> Permit 插件的使用场景：
>
> 1. 资源准备：如存储卷动态创建或网络策略配置
> 2. 人工审批：生产环境部署需要审批，关键业务调度需要人工确认
> 3. 协调其他系统：等待外部系统确认或者配额分配

### 5.3 Assume 与异步绑定

**什么是 Assume?**

Assume 是一个**临时状态**,表示调度器假定 Pod 已经在节点上,但实际上 API Server 的 Pod 对象还没有更新。

**为什么需要 Assume?**

> 问题: 如果 Bind 之前不 Assume,会发生什么?
> 场景1：
>
> 1. SchedulePod 选择 Node-A，不 Assume,直接 Bind；
> 2. 由于 Bind 是异步的，还没完成，此时下一个 Pod 开始调度；
> 3. 由于 Cache 中没有更新 Node-A 的资源, 第二个 Pod 也调度到 Node-A：结果: Node-A 超发
>
> 场景2：
>
> 1. SchedulePod 选择 Node-A，不 Assume,直接 Bind；但是将 bind 改为同步；
> 2. 由于 apiServer 响应速度慢，或者当前节点需要等待 Permit，绑定耗时大大增加；结果：Pod 调度缓慢
>
> 解决方案：异步绑定 + Assume 机制
>
> 1. 一旦 SchedulePod 完成 node 选择，则立即假定 Pod 已经绑定到该节点，同时更新节点的资源占用信息；
> 2. 下一个 Pod 调度时,会看到 Node-A 资源已占用，解决超发问题；
> 3. 一旦异步绑定完成，对 Assume 进行确认；如果失败则撤销 Assume；保证最终一致性；

### 5.4 节点采样算法

**当集群节点数量很大时,不需要对所有节点评分**

```go
// numFeasibleNodesToFind 用于决定本次调度过程中需要评估（filter + score）的节点数量。
// 该逻辑用于在调度性能（延迟）和调度质量之间做权衡。
func (sched *Scheduler) numFeasibleNodesToFind(numAllNodes int32) (numNodes int32) {

	// 情况 1：
	// 1. 集群节点数本身就很少，此时全量遍历代价可以接受
	// 2. 用户显式配置 percentageOfNodesToScore >= 100，要求全量打分
	// 在这两种情况下，直接评估所有节点
	if numAllNodes < minFeasibleNodesToFind || sched.percentageOfNodesToScore >= 100 {
		return numAllNodes
	}

	// 计算本次调度需要评估的节点百分比
	// 优先使用用户配置的 percentageOfNodesToScore，如果未配置或配置为非正数，则使用自适应策略
	adaptivePercentage := sched.percentageOfNodesToScore
	if adaptivePercentage <= 0 {

		// 以 50% 作为基准百分比，随着集群规模增大，逐步降低需要评估的节点比例
        // 以避免在大规模集群中产生 O(N) 的调度开销。
		basePercentageOfNodesToScore := int32(50)
		adaptivePercentage = basePercentageOfNodesToScore - numAllNodes/125

		// 设置最小百分比下限，防止评估节点过少，导致调度质量明显下降（例如错过更优节点）
		if adaptivePercentage < minFeasibleNodesPercentageToFind {
			adaptivePercentage = minFeasibleNodesPercentageToFind
		}
	}

	// 将百分比换算为需要评估的节点数量
	numNodes = numAllNodes * adaptivePercentage / 100

	// 最终兜底：
	// 无论百分比计算结果如何，至少保证评估 minFeasibleNodesToFind 个节点
	if numNodes < minFeasibleNodesToFind {
		return minFeasibleNodesToFind
	}

	return numNodes
}
```

