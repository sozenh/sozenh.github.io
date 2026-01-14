---
title: "深入理解 kube-scheduler(3) - 核心数据结构设计"
date: 2026-01-14T18:00:00+08:00
draft: false
tags: ["kubernetes", "源码解析", "kube-scheduler"]
summary: "深入剖析 kube-scheduler 的核心数据结构：SchedulingQueue、Cache 和 Snapshot"
---

# 深入理解 kube-scheduler(3) - 核心数据结构设计

## 目录
- [1. 概述](#1-概述)
- [2. SchedulingQueue 调度队列](#2-schedulingqueue-调度队列)
- [3. Cache 调度缓存](#3-cache-调度缓存)
- [4. Snapshot 快照机制](#4-snapshot-快照机制)
- [5. NodeInfo 节点信息聚合](#5-nodeinfo-节点信息聚合)
- [6. 设计思想总结](#6-设计思想总结)

---

## 1. 概述

kube-scheduler 的性能高度依赖于其核心数据结构的设计。本文将深入分析三个核心组件:

1. **SchedulingQueue**: 三队列设计的高效调度队列
2. **Cache**: 基于 Assume 机制的增量缓存
3. **Snapshot**: 一致性保证的快照机制

这些数据结构共同支撑了调度器的高性能、高并发和一致性。

### 1.1 数据结构关系图

```
┌────────────────────────────────────────────────────────────┐
│                    kube-scheduler 数据架构                  │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌─────────────────┐        ┌─────────────────┐            │
│  │ SchedulingQueue │ ───▶   │      Cache      │            │
│  │                 │        │                 │            │
│  │ - activeQ       │        │ - NodeInfo Map  │            │
│  │ - backoffQ      │        │ - Assumed Pods  │            │
│  │ - unschedulable │        │ - Pod States    │            │
│  └─────────────────┘        └────────┬────────┘            │
│                                      │                     │
│                                      ▼                     │
│                             ┌─────────────────┐            │
│                             │    Snapshot     │            │
│                             │                 │            │
│                             │ - NodeInfo Map  │            │
│                             │ - NodeInfo List │            │
│                             │ - Generation    │            │
│                             └─────────────────┘            │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

## 2. SchedulingQueue 调度队列

### 2.1 设计目标

SchedulingQueue 需要解决以下问题:

1. **优先级调度**: 高优先级 Pod 优先调度
2. **失败重试**: 调度失败的 Pod 需要退避重试
3. **避免无效调度**: 暂时无法调度的 Pod 不应频繁重试
4. **事件驱动**: 集群变化时快速响应

### 2.2 三队列架构

**位置**: `pkg/scheduler/internal/queue/scheduling_queue.go:126-173`

```go
type PriorityQueue struct {
    *nominator

    stop  chan struct{}
    clock util.Clock

    podInitialBackoffDuration time.Duration
    podMaxBackoffDuration     time.Duration
    podMaxInUnschedulablePodsDuration time.Duration

    cond sync.Cond

    // activeQ 存储正在考虑进行调度的 Pod
    activeQ *heap.Heap

    // podBackoffQ 存储从 unschedulablePods 移出的 Pod，当它们的退避周期结束后，这些 Pod 将移至 activeQ。
    podBackoffQ *heap.Heap

    // unschedulablePods 存储已经尝试过调度但目前被确定为无法调度的 Pod
    unschedulablePods *UnschedulablePods

    schedulingCycle  int64  // 调度周期序列号，当一个 Pod 被弹出时，该序列号会递增
    moveRequestCycle int64  // 缓存收到移动请求时的调度周期序列号。如果在收到移动请求时正在尝试调度某个 Pod，并且该 Pod 在该调度周期或之前的周期内被标记为不可调度，则会将其重新放回 activeQueue 中

    closed bool
    nsLister listersv1.NamespaceLister
	clusterEventMap map[framework.ClusterEvent]sets.String
}
```

**三队列设计图**:

```
┌────────────────────────────────────────────────────────────┐
│                   SchedulingQueue 三队列                   │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌────────────────┐                                        │
│  │   activeQ      │  ← 调度器从这里 Pop Pod                 │
│  │   (优先队列)    │     - 高优先级 Pod 在头部                │
│  │                │     - 所有准备调度的 Pod                 │
│  │   Pod A (P1)   │                                        │
│  │   Pod B (P2)   │                                        │
│  │   Pod C (P3)   │                                        │
│  └────────┬───────┘                                        │
│           │                                                │
│           │ AddUnschedulableIfNotPresent                   │
│           │ (调度失败)                                      │
│           ▼                                                │
│  ┌────────────────┐                                        │
│  │ unschedulable  │  ← 暂时无法调度的 Pod                    │
│  │   Pods         │     - 存储失败原因                      │
│  │                │     - 等待集群事件触发                   │
│  │ Pod X (Filter) │                                        │
│  │ Pod Y (Score)  │                                        │
│  └────────┬───────┘                                        │
│           │                                                │
│           │ MovePodsToActiveOrBackoffQueue                 │
│           │ (集群变化/超时)                                 │
│           ▼                                                │
│  ┌────────────────┐                                        │
│  │  backoffQ      │  ← 需要退避的 Pod                       │
│  │  (退避队列)     │     - 按退避完成时间排序                 │
│  │                │     - 定时 flush 到 activeQ             │
│  │ Pod Z (2s后)   │                                        │
│  │ Pod W (5s后)   │                                        │
│  └────────┬───────┘                                        │
│           │                                                │
│           │ flushBackoffQCompleted                         │
│           │ (定时: 1秒)                                     │
│           ▼                                                │
│      回到 activeQ                                          │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 2.3 activeQ: 优先队列

**数据结构**: 基于 `heap.Heap` 实现的优先队列

```go
// 位置: pkg/scheduler/internal/heap/heap.go
type data struct {
    items map[string]*heapItem  // key -> {obj, index}
    queue []string               // 按 key 的堆有序数组
    keyFunc KeyFunc              // 生成 key 的函数
    lessFunc lessFunc            // 比较函数
}
```

**特点**:
- **堆结构**: O(log n) 的插入和删除
- **优先级排序**: 通过 `lessFunc` 定义排序规则
- **快速查找**: 通过 `items` map 实现 O(1) 查找

**默认排序规则**:

```go
// pkg/scheduler/framework/plugins/priority/sorting.go
func Less(podInfo1, podInfo2 *framework.QueuedPodInfo) bool {
    p1 := podInfo1.Pod
    p2 := podInfo2.Pod

    // 1. 比较 priority
    if util.GetPodPriority(p1) != util.GetPodPriority(p2) {
        return util.GetPodPriority(p1) > util.GetPodPriority(p2)
    }

    // 2. 比较 QoS
    if kubetypes.GetPodQOS(p1) != kubetypes.GetPodQOS(p2) {
        return kubetypes.GetPodQOS(p1) > kubetypes.GetPodQOS(p2)
    }

    // 3. 比较创建时间
    return p1.CreationTimestamp.Before(&p2.CreationTimestamp)
}
```

**设计优势**:
1. **公平性**: 同优先级的 Pod 按创建时间排序
2. **QoS 保证**: GuaranteedPod > BurstablePod > BestEffortPod
3. **性能**: 堆结构保证高效操作

### 2.4 backoffQ: 退避队列

**作用**: 存储需要退避的 Pod,避免频繁重试

**退避时间计算**: `pkg/scheduler/internal/queue/scheduling_queue.go:756-775`

```go
// calculateBackoffDuration 计算退避时长
func (p *PriorityQueue) calculateBackoffDuration(podInfo *framework.QueuedPodInfo) time.Duration {
    duration := p.podInitialBackoffDuration  // 默认 1s
    for i := 1; i < podInfo.Attempts; i++ {
        // 指数退避: 1s, 2s, 4s, 8s, 10s(max)
        if duration > p.podMaxBackoffDuration-duration {
            return p.podMaxBackoffDuration
        }
        duration += duration
    }
    return duration
}
```

**退避时长示例**:

```
Attempts | Backoff Duration
---------+------------------
   1     |   1s
   2     |   2s
   3     |   4s
   4     |   8s
   5+    |   10s (max)
```

**定时刷新**: `pkg/scheduler/internal/queue/scheduling_queue.go:428-455`

```go
// flushBackoffQCompleted 将完成退避的 Pod 移到 activeQ
// 每 1 秒执行一次
func (p *PriorityQueue) flushBackoffQCompleted() {
    p.lock.Lock()
    defer p.lock.Unlock()

    for {
        rawPodInfo := p.podBackoffQ.Peek()
        if rawPodInfo == nil {
            break
        }
        pod := rawPodInfo.(*framework.QueuedPodInfo).Pod
        boTime := p.getBackoffTime(rawPodInfo.(*framework.QueuedPodInfo))

        // 如果还未到退避时间,停止
        if boTime.After(p.clock.Now()) {
            break
        }

        // 移到 activeQ
        p.podBackoffQ.Pop()
        p.activeQ.Add(rawPodInfo)
        metrics.SchedulerQueueIncomingPods.WithLabelValues("active", BackoffComplete).Inc()
    }
}
```

### 2.5 unschedulablePods: 不可调度队列

**数据结构**: `pkg/scheduler/internal/queue/scheduling_queue.go:785-792`

```go
type UnschedulablePods struct {
    podInfoMap map[string]*framework.QueuedPodInfo
    keyFunc    func(*v1.Pod) string
    metricRecorder metrics.MetricRecorder
}
```

**存储信息**:

```go
type QueuedPodInfo struct {
    *PodInfo
    // Pod 加入队列的时间戳
    Timestamp time.Time
    // Pod 第一次尝试调度的时间戳
    InitialAttemptTimestamp time.Time
    // 导致 Pod 不可调度的插件集合
    UnschedulablePlugins sets.String
    // 尝试调度次数
    Attempts int
}
```

**超时机制**: `pkg/scheduler/internal/queue/scheduling_queue.go:459-475`

```go
// flushUnschedulablePodsLeftover 将在 unschedulablePods 中停留过久的 Pod 移到 backoffQ 或 activeQ
// 默认: 5 分钟
func (p *PriorityQueue) flushUnschedulablePodsLeftover() {
    p.lock.Lock()
    defer p.lock.Unlock()

    var podsToMove []*framework.QueuedPodInfo
    currentTime := p.clock.Now()

    for _, pInfo := range p.unschedulablePods.podInfoMap {
        // 如果超过最大停留时间
        if currentTime.Sub(pInfo.Timestamp) > p.podMaxInUnschedulablePodsDuration {
            podsToMove = append(podsToMove, pInfo)
        }
    }

    if len(podsToMove) > 0 {
        p.movePodsToActiveOrBackoffQueue(podsToMove, UnschedulableTimeout)
    }
}
```

**为什么要三队列?**

| 队列 | 作用 | 为什么需要 |
|------|------|-----------|
| **activeQ** | 存储可调度的 Pod | 调度器只需要关注这个队列,避免浪费资源 |
| **backoffQ** | 存储需要退避的 Pod | 避免频繁重试失败的 Pod,减轻调度压力 |
| **unschedulablePods** | 存储暂时不可调度的 Pod | 避免重复调度明显不可调度的 Pod |

**设计优势**:

1. **性能优化**:
   - activeQ 中都是可以尝试调度的 Pod
   - unschedulablePods 中的 Pod 不参与调度,减少无效计算

2. **用户体验**:
   - 退避机制避免 Pod 饥饿
   - 高优先级 Pod 优先调度

3. **事件驱动**:
   - 集群变化时快速响应
   - 只唤醒可能变得可调度的 Pod

---

## 3. Cache 调度缓存

### 3.1 设计目标

Cache 需要解决:

1. **性能**: 避免每次调度都查询 API Server
2. **一致性**: 调度过程中的状态一致性
3. **假设机制**: 提前假设 Pod 已调度,加速调度流程

### 3.2 Pod 状态机

**状态转换表**:

| 当前状态    | 事件     | 下一状态    | 说明               |
|---------|--------|---------|------------------|
| Initial | Assume | Assumed | 调度器假定 Pod 已调度    |
| Initial | Add    | Added   | Pod 已经被其他调度器调度   |
| Assumed | Add    | Added   | 收到 API Server 确认 |
| Assumed | Forget | Initial | 实际绑定失败，取消 assume |
| Assumed | Expire | Expired | TTL 到期,自动移除      |
| Expired | Add    | Added   | 过期后收到 Add,重新添加   |
| Added   | Update | Added   | Pod 更新           |
| Added   | Remove | Deleted | Pod 删除           |

**状态转换图**:

```
    +-----------------------------------------------+  +----+
    |                                               |  |    |
   Add                                              |  |  Update
    +                                               v  v    |
    Initial +---Assume---> Assumed +---Add---+---> Added <--+
    ^                      +     +           |       +
    |                      |     |          Add      |
    |                   Forget  Expire       |      Remove
    |                      |     |           +       |
    +----------------------+     +--------> Expired  +----> Deleted

注:
- Initial, Expired, Deleted 状态不在缓存中
- Assumed 状态的 Pod 会被计入节点资源使用，TTL 过期后自动移除
```

### 3.3 Cache 核心结构

**位置**: `pkg/scheduler/internal/cache/cache.go:56-75`

```go
type cacheImpl struct {
    stop   <-chan struct{}
    ttl    time.Duration
    period time.Duration
    
    mu sync.RWMutex
    
    // assumedPods 是假设 Pod 的集合
    // 这些 Pod 已被调度器假定调度到某节点,但尚未收到 API Server 的确认
    assumedPods sets.String
    
    // podStates 存储所有的 Pods 信息
    podStates map[string]*podState
    
    // nodes 存储所有的 Nodes 信息
    // 使用双向链表+树形结构存储,最近更新的节点在头部
    nodeTree *nodeTree
    headNode *nodeInfoListItem
    nodes map[string]*nodeInfoListItem
    
    // imageStates 维护镜像状态，用于判断 Pod 所需镜像在哪些 node 上已有缓存
    imageStates map[string]*imageState
}

type podState struct {
    pod *v1.Pod
    // assumed Pod 的过期时间
    deadline *time.Time
    bindingFinished bool
}

type imageState struct {
    // 镜像大小
    size int64
    // 该镜像存在于哪些 node
    nodes sets.String
}

// 双向链表结构
type nodeInfoListItem struct {
    next *nodeInfoListItem
    prev *nodeInfoListItem
    info *framework.NodeInfo
}

type NodeInfo struct {
    node *v1.Node
    
    // 运行在该节点上的 Pods 列表
    Pods []*PodInfo
    PodsWithAffinity []*PodInfo
    PodsWithRequiredAntiAffinity []*PodInfo
    
    // 端口分配情况
    UsedPorts map[string]map[ProtocolPort]struct{}
    
    // 剩余可分配的资源总量
    Allocatable *Resource
    // 运行在该节点上的所有 Pod 的请求资源总量，包含 assumed pod
    Requested *Resource
    // Total requested resources of all pods on this node with a minimum value
    // applied to each container's CPU and memory requests. This does not reflect
    // the actual resource requests for this node, but is used to avoid scheduling
    // many zero-request pods onto one node.
    NonZeroRequested *Resource
    
    // 该节点存在的所有镜像信息列表
    ImageStates map[string]*ImageStateSummary
    
    // 该节点存在的所有PVC信息列表，同时映射包含其被使用的Pod数量
    PVCRefCounts map[string]int
    
    // Whenever NodeInfo changes, generation is bumped.
    // This is used to avoid cloning it if the object didn't change.
    Generation int64
}

type Cache interface {
    Dump() *Dump
    NodeCount() int
    PodCount() (int, error)
    GetPod(pod *v1.Pod) (*v1.Pod, error)
    UpdateSnapshot(nodeSnapshot *Snapshot) error
    
    // 调度器会调用的方法，assume 机制，用于内部模拟真实环境
    AssumePod(pod *v1.Pod) error
    ForgetPod(pod *v1.Pod) error
    FinishBinding(pod *v1.Pod) error
    IsAssumedPod(pod *v1.Pod) (bool, error)
    
    // event 事件触发时会调用的方法，反应真实环境
    AddPod(pod *v1.Pod) error
    UpdatePod(oldPod, newPod *v1.Pod) error
    RemovePod(pod *v1.Pod) error

    AddNode(node *v1.Node) *framework.NodeInfo
    UpdateNode(oldNode, newNode *v1.Node) *framework.NodeInfo
    RemoveNode(node *v1.Node) error
}

```

**设计要点**:

1. **读写锁**: 支持并发读取
2. **双向链表**: 最近更新的节点在头部,优化 Snapshot 更新
3. **TTL 机制**: assumed Pod 自动过期


### 3.4 Assume 机制

**问题**: 调度器为 Pod 选择节点后,需要等待批准，以及 API Server 更新 Pod 的 `spec.nodeName`,这个延迟影响性能。

**解决方案**: Assume 机制

```
┌─────────────────────────────────────────────────────────────┐
│                    Assume 机制流程                           │
└─────────────────────────────────────────────────────────────┘

T0: 调度器为 Pod 选择节点 node-1
    │
    ▼
T1: Cache.AssumePod(pod, "node-1")
    │
    ├─▶ 将 Pod 添加到 assumedPods 集合
    ├─▶ 更新 NodeInfo,扣除节点资源
    ├─▶ 设置 deadline (当前时间 + TTL)
    │
    ▼
T2: 继续调度其他 Pod
    │  (此时看到的 node-1 已经考虑了 Pod 的资源占用)
    ▼
T3: 异步绑定 Pod 到 API Server
    │  (不等待 API Server 响应)
    ▼
T4: API Server 更新成功,触发 Informer 事件
    │
    ├─▶ Cache.AddPod(pod)  ← 收到 Add 事件
    ├─▶ 从 assumedPods 移除
    └─▶ 清除 deadline
```

**AssumePod 实现**: `pkg/scheduler/internal/cache/cache.go:350-363`

```go
func (cache *cacheImpl) AssumePod(pod *v1.Pod) error {
    key, err := framework.GetPodPod(pod)
    if err != nil {
        return err
    }

    cache.mu.Lock()
    defer cache.mu.Unlock()

    // 检查 Pod 是否已存在
    if _, ok := cache.podStates[key]; ok {
        return fmt.Errorf("pod %v is in the cache, so can't be assumed", key)
    }

    // 添加 Pod (assume=true)
    return cache.addPod(pod, true)
}

func (cache *cacheImpl) addPod(pod *v1.Pod, assumePod bool) error {
    key, err := framework.GetPodKey(pod)
    if err != nil {
        return err
    }

    // 获取或创建节点
    n, ok := cache.nodes[pod.Spec.NodeName]
    if !ok {
        n = newNodeInfoListItem(framework.NewNodeInfo())
        cache.nodes[pod.Spec.NodeName] = n
    }

    // 更新 NodeInfo
    n.info.AddPod(pod)
    cache.moveNodeInfoToHead(pod.Spec.NodeName)

    // 创建 podState
    ps := &podState{
        pod: pod,
    }
    cache.podStates[key] = ps

    if assumePod {
        cache.assumedPods.Insert(key)
    }
    return nil
}
```

**FinishBinding 实现**: `pkg/scheduler/internal/cache/cache.go:365-387`

```go
func (cache *cacheImpl) FinishBinding(pod *v1.Pod) error {
    return cache.finishBinding(pod, time.Now())
}

func (cache *cacheImpl) finishBinding(pod *v1.Pod, now time.Time) error {
    key, err := framework.GetPodKey(pod)
    if err != nil {
        return err
    }

    cache.mu.RLock()
    defer cache.mu.RUnlock()

    currState, ok := cache.podStates[key]
    if ok && cache.assumedPods.Has(key) {
        // 设置过期时间
        dl := now.Add(cache.ttl)
        currState.bindingFinished = true
        currState.deadline = &dl
    }
    return nil
}
```

**AddPod (确认)**: `pkg/scheduler/internal/cache/cache.go:470-502`

```go
func (cache *cacheImpl) AddPod(pod *v1.Pod) error {
    key, err := framework.GetPodKey(pod)
    if err != nil {
        return err
    }

    cache.mu.Lock()
    defer cache.mu.Unlock()

    currState, ok := cache.podStates[key]
    switch {
    case ok && cache.assumedPods.Has(key):
        // 确认 assumed Pod
        if currState.pod.Spec.NodeName != pod.Spec.NodeName {
            // 调度到了不同节点
            if err = cache.updatePod(currState.pod, pod); err != nil {
                klog.ErrorS(err, "Error occurred while updating pod")
            }
        } else {
            // 正常确认
            delete(cache.assumedPods, key)
            cache.podStates[key].deadline = nil
            cache.podStates[key].pod = pod
        }
    case !ok:
        // Pod 已过期,重新添加
        if err = cache.addPod(pod, false); err != nil {
            klog.ErrorS(err, "Error occurred while adding pod")
        }
    default:
        return fmt.Errorf("pod %v was already in added state", key)
    }
    return nil
}
```

### 3.5 过期清理机制

**位置**: `pkg/scheduler/internal/cache/cache.go:704-738`

```go
func (cache *cacheImpl) cleanupAssumedPods(now time.Time) {
    cache.mu.Lock()
    defer cache.mu.Unlock()
    defer cache.updateMetrics()

    // 遍历所有 assumed Pods
    for key := range cache.assumedPods {
        ps, ok := cache.podStates[key]
        if !ok {
            klog.ErrorS(nil, "Key found in assumed set but not in podStates")
            os.Exit(1)
        }

        // 只有绑定完成才能过期
        if !ps.bindingFinished {
            klog.V(5).InfoS("Could not expire cache for pod as binding is still in progress", "pod", klog.KObj(ps.pod))
            continue
        }

        // 检查是否过期
        if now.After(*ps.deadline) {
            klog.InfoS("Pod expired", "pod", klog.KObj(ps.pod))
            if err := cache.removePod(ps.pod); err != nil {
                klog.ErrorS(err, "ExpirePod failed", "pod", klog.KObj(ps.pod))
            }
        }
    }
}
```

**为什么需要 TTL?**

1. **防止资源泄漏**: 绑定失败时自动清理
2. **网络问题**: API Server 事件丢失时自动恢复
3. **异常情况**: 调度器崩溃后重启,旧 assumed Pod 自动过期

**为什么需要 bindingFinished?**

```
场景: Pod 正在绑定中

T0: AssumePod(pod, node-1)
    └─▶ assumedPods.Insert(key)
    └─▶ deadline = nil (还未设置)

T1: 异步开始绑定
    └─▶ 调用 Bind 插件
    └─▶ 发送请求到 API Server

T2: 定时检查过期
    └─▶ bindingFinished = false
    └─▶ 跳过过期检查 (不能在绑定中过期)

T3: 绑定完成
    └─▶ FinishBinding(pod)
    └─▶ bindingFinished = true
    └─▶ deadline = now + TTL

T4: 下次检查
    └─▶ 如果还没收到 Add 事件,可以过期
```

---

## 4. Snapshot 快照机制

### 4.1 为什么需要 Snapshot?

**问题**: 调度过程中集群状态可能变化

```
场景: 没有 Snapshot

T0: 开始调度 Pod A
    │
    ├─▶ Filter: 检查 node-1 (有足够资源) ✓
    │
    ├─▶ 【此时 node-1 上调度了 Pod B,资源不足】
    │
    ├─▶ Score: node-1 仍然显示有资源
    │
    └─▶ 选择 node-1
    └─▶ 但实际 node-1 已经资源不足! ✗
```

**解决方案**: Snapshot

```
场景: 使用 Snapshot

T0: UpdateSnapshot()
    │─▶ 创建调度时刻的节点状态快照
    │─▶ 整个调度周期使用快照
    │
    ▼
T1: 开始调度 Pod A
    │
    ├─▶ Filter: 检查快照中的 node-1 ✓
    │
    ├─▶ 【node-1 状态变化,但快照不变】
    │
    ├─▶ Score: 使用快照中的 node-1
    │
    └─▶ 选择 node-1
    └─▶ 基于一致的状态做决策 ✓
```

### 4.2 Snapshot 结构

**位置**: `pkg/scheduler/internal/cache/snapshot.go:29-40`

```go
type Snapshot struct {
    // nodeInfoMap 是节点名称到 NodeInfo 的映射
    nodeInfoMap map[string]*framework.NodeInfo

    // nodeInfoList 是节点列表(按 nodeTree 顺序)
    nodeInfoList []*framework.NodeInfo

    // 有 Pod 声明亲和性的节点列表
    havePodsWithAffinityNodeInfoList []*framework.NodeInfo

    // 有 Pod 声明必需反亲和性的节点列表
    havePodsWithRequiredAntiAffinityNodeInfoList []*framework.NodeInfo

    // 世代号,用于增量更新
    generation int64
}
```

### 4.3 增量更新机制

**位置**: `pkg/scheduler/internal/cache/cache.go:197-276`

**关键设计**: 双向链表 + Generation

```go
// Cache 中维护双向链表,最近更新的节点在头部
type nodeInfoListItem struct {
    info *framework.NodeInfo
    next *nodeInfoListItem
    prev *nodeInfoListItem
}

type cacheImpl struct {
    nodes    map[string]*nodeInfoListItem
    headNode *nodeInfoListItem  // 指向最近更新的节点
}
```

**UpdateSnapshot 流程**:

```
┌─────────────────────────────────────────────────────────────┐
│              Snapshot 增量更新流程                            │
└─────────────────────────────────────────────────────────────┘

Cache (实际状态)                    Snapshot (快照)
═══════════════                   ══════════════
headNode ──▶ Node1 (Gen=10)       generation=8
             Node2 (Gen=9)        Node1 (Gen=9)
             Node3 (Gen=8)        Node2 (Gen=8)
                                  Node3 (Gen=7)

UpdateSnapshot():
    1. 获取 snapshot.generation = 8

    2. 从 headNode 遍历链表:
       - Node1 (Gen=10 > 8) ✓ 更新
       - Node2 (Gen=9 > 8)  ✓ 更新
       - Node3 (Gen=8 <= 8) ✗ 停止

    3. 更新后的 Snapshot:
       generation = 10
       Node1 (Gen=10)
       Node2 (Gen=9)
       Node3 (Gen=8)  (未变,保持原样)
```

**代码实现**:

```go
func (cache *cacheImpl) UpdateSnapshot(nodeSnapshot *Snapshot) error {
    cache.mu.Lock()
    defer cache.mu.Unlock()

    // 获取快照的当前世代号
    snapshotGeneration := nodeSnapshot.generation

    // 标记是否需要重建列表
    updateAllLists := false
    updateNodesHavePodsWithAffinity := false
    updateNodesHavePodsWithRequiredAntiAffinity := false

    // 从 headNode 开始遍历,只更新有变化的节点
    for node := cache.headNode; node != nil; node = node.next {
        // 如果节点的 Generation <= snapshotGeneration,停止
        if node.info.Generation <= snapshotGeneration {
            break
        }

        if np := node.info.Node(); np != nil {
            existing, ok := nodeSnapshot.nodeInfoMap[np.Name]
            if !ok {
                // 新增节点,需要重建列表
                updateAllLists = true
                existing = &framework.NodeInfo{}
                nodeSnapshot.nodeInfoMap[np.Name] = existing
            }

            clone := node.info.Clone()

            // 检查是否需要更新亲和性列表
            if (len(existing.PodsWithAffinity) > 0) != (len(clone.PodsWithAffinity) > 0) {
                updateNodesHavePodsWithAffinity = true
            }

            // 更新 NodeInfo
            *existing = *clone
        }
    }

    // 更新世代号
    if cache.headNode != nil {
        nodeSnapshot.generation = cache.headNode.info.Generation
    }

    // 根据标记更新列表
    if updateAllLists || updateNodesHavePodsWithAffinity {
        cache.updateNodeInfoSnapshotList(nodeSnapshot, updateAllLists)
    }

    return nil
}
```

**性能分析**:

| 操作 | 全量更新 | 增量更新 |
|------|---------|---------|
| **时间复杂度** | O(N) | O(M), M=变化节点数 |
| **空间复杂度** | O(N) | O(N) |
| **适用场景** | 变化较多 | 变化较少 |

**调度器场景**:
- 每次调度只影响少量节点(1-2个)
- 大部分节点状态不变
- **增量更新优势明显**

### 4.4 一致性保证

**Snapshot 更新时机**:

```go
// pkg/scheduler/scheduler.go
func (sched *Scheduler) scheduleOne(ctx context.Context) {
    // 1. 更新 Snapshot
    if err := sched.Cache.UpdateSnapshot(sched.nodeInfoSnapshot); err != nil {
        return
    }

    // 2. 获取 Framework
    fwk, err := sched.frameworkForPod(pod)

    // 3. 开始调度(整个周期使用同一个 Snapshot)
    state := framework.NewCycleState()
    scheduleResult, err := sched.SchedulePod(ctx, fwk, state, pod)
    ...
}
```

**一致性保证**:

1. **调度周期内一致性**:
   - Snapshot 在调度开始时更新
   - 整个调度周期使用同一个 Snapshot
   - 不会看到中间状态变化

2. **跨周期一致性**:
   - 每个 Pod 调度都更新 Snapshot
   - 保证看到最新状态

3. **并发控制**:
   - Cache 使用读写锁
   - Snapshot 更新获取写锁
   - 调度读操作获取读锁

---

## 5. NodeInfo 节点信息聚合

### 5.1 NodeInfo 结构

**位置**: `pkg/scheduler/framework/types.go`

```go
type NodeInfo struct {
    // 节点对象
    node *v1.Node

    // Pod 列表
    Pods []*v1.Pod

    // 按状态分类的 Pod
    PodsWithAffinity             []*v1.Pod
    PodsWithRequiredAntiAffinity []*v1.Pod

    // 资源使用情况
    Allocatable *framework.Resource
    Requested   *framework.Resource
    Used        *framework.Resource

    // 镜像状态
    ImageStates map[string]*ImageStateSummary

    // Generation,用于 Snapshot 增量更新
    Generation int64
}
```

### 5.2 信息聚合

**AddPod 流程**:

```go
func (ni *NodeInfo) AddPod(pod *v1.Pod) error {
    ni.Pods = append(ni.Pods, pod)

    // 更新资源请求
    ni.Requested.MilliCPU += request.MilliCPU
    ni.Requested.Memory += request.Memory
    ...

    // 分类 Pod
    if pod.Spec.Affinity != nil {
        if pod.Spec.Affinity.PodAffinity != nil {
            ni.PodsWithAffinity = append(ni.PodsWithAffinity, pod)
        }
        if pod.Spec.Affinity.PodAntiAffinity != nil {
            ni.PodsWithRequiredAntiAffinity = append(ni.PodsWithRequiredAntiAffinity, pod)
        }
    }

    // 更新 Generation
    ni.Generation++

    return nil
}
```

**RemovePod 流程**:

```go
func (ni *NodeInfo) RemovePod(pod *v1.Pod) error {
    // 从 Pods 列表移除
    for i, p := range ni.Pods {
        if p.UID == pod.UID {
            ni.Pods = append(ni.Pods[:i], ni.Pods[i+1:]...)
            break
        }
    }

    // 恢复资源请求
    ni.Requested.MilliCPU -= request.MilliCPU
    ni.Requested.Memory -= request.Memory
    ...

    // 从分类列表移除
    ni.updatePodLists()

    // 更新 Generation
    ni.Generation++

    return nil
}
```

---

## 6. 设计思想总结

### 6.1 核心设计原则

#### 1. 分而治之 (Divide and Conquer)

**三队列设计**:

```
问题: 所有 Pod 混在一起?

解决: 按状态分类
- activeQ: 可调度
- backoffQ: 等待退避
- unschedulable: 不可调度

好处:
- 减少无效调度
- 提高调度效率
- 优化用户体验
```

#### 2. 增量更新 (Incremental Update)

**Snapshot 增量更新**:

```
问题: 每次全量更新开销大

解决: 使用 Generation + 双向链表
- 只更新有变化的节点
- 未变化的节点复用

好处:
- O(M) vs O(N), M << N
- 减少内存分配
- 降低 CPU 开销
```

#### 3. 假设机制 (Assume Mechanism)

**Assume-Confirm 模式**:

```
问题: 等待 API Server 影响性能

解决: 提前假设,异步确认
- Assume: 立即更新缓存
- Bind: 异步绑定
- Add: 确认或纠正

好处:
- 不阻塞调度流程
- 提高吞吐量
- 保持一致性
```

#### 4. 快照隔离 (Snapshot Isolation)

**调度周期隔离**:

```
问题: 调度过程中状态变化

解决: 每次调度使用独立快照
- UpdateSnapshot 开始
- 调度使用快照
- 下次调度更新快照

好处:
- 保证一致性
- 避免竞态条件
- 简化调度逻辑
```

### 6.2 性能优化技巧

#### 1. 数据结构选择

| 数据结构      | 场景   | 复杂度               |
|-----------|------|-------------------|
| **Heap**  | 优先队列 | O(log n) Push/Pop |
| **Map**   | 快速查找 | O(1) Get/Delete   |
| **双向链表**  | 增量更新 | O(1) Move to Head |
| **Slice** | 顺序遍历 | O(n) 遍历           |

#### 2. 锁粒度控制

```go
// 读写锁
type cacheImpl struct {
    mu sync.RWMutex
}

// 读操作(频繁)
cache.mu.RLock()
defer cache.mu.RUnlock()

// 写操作(较少)
cache.mu.Lock()
defer cache.mu.Unlock()
```

#### 3. 批量操作

```go
// 批量移动 Pod
func (p *PriorityQueue) movePodsToActiveOrBackoffQueue(
    podInfoList []*framework.QueuedPodInfo,
    event framework.ClusterEvent,
) {
    // 收集所有 Pod
    // 一次性添加
    // 一次性广播
}
```

### 6.3 可靠性保证

#### 1. TTL 过期

```
Assumed Pod → TTL → 自动过期

防止:
- 资源泄漏
- 状态不一致
- 绑定失败
```

#### 2. 状态检查

```go
// 检查 Pod 是否可添加
if currState.pod.Spec.NodeName != pod.Spec.NodeName {
    return fmt.Errorf("pod was added to different node")
}
```

#### 3. Metrics 监控

```go
metrics.CacheSize.WithLabelValues("assumed_pods").Set(float64(len(cache.assumedPods)))
metrics.CacheSize.WithLabelValues("pods").Set(float64(len(cache.podStates)))
```

### 6.4 架构优势

| 特性 | 实现 | 优势 |
|------|------|------|
| **高性能** | 三队列 + 增量更新 + Assume | 减少无效调度,提高吞吐量 |
| **高并发** | 读写锁 + Snapshot Clone | 支持并发调度,保证一致性 |
| **可扩展** | 接口抽象 + 插件机制 | 易于扩展新功能 |
| **容错性** | TTL + 状态检查 | 自动恢复,防止资源泄漏 |

---

## 总结

kube-scheduler 的核心数据结构体现了精妙的系统设计:

1. **SchedulingQueue**: 三队列设计优化调度效率
2. **Cache**: Assume 机制平衡性能与一致性
3. **Snapshot**: 增量更新 + 快照隔离保证一致性
4. **NodeInfo**: 信息聚合 + Clone 机制支持并发

这些设计思想不仅适用于调度器,也值得在其他分布式系统中借鉴。
