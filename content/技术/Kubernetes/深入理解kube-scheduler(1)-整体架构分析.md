---
title: "深入理解 kube-scheduler(1) - 整体架构与扩展机制"
date: 2026-01-14T18:00:00+08:00
draft: false
tags: ["kubernetes", "源码解析", "kube-scheduler"]
summary: "从源码层面深入分析 kube-scheduler 的整体架构设计、核心组件和扩展机制"
---

# 深入理解 kube-scheduler(1) - 整体架构与扩展机制

## 目录
- [1. 概述](#1-概述)
- [2. 核心数据结构](#2-核心数据结构)
- [3. 创建与启动流程](#3-创建与启动流程)
- [4. Profile 调度配置](#4-profile-调度配置)
- [5. Framework 插件框架](#5-framework-插件框架)
- [6. Extender 扩展机制](#6-extender-扩展机制)
- [7. 扩展点总结](#7-扩展点总结)

---

## 1. 概述

kube-scheduler 是 Kubernetes 的核心组件之一,负责将 Pod 调度到合适的节点上。它采用**高度可扩展的架构设计**,通过 Profile 和 Framework 机制支持灵活的调度策略,并通过 Extender 机制支持外部扩展。

### 1.1 核心职责

kube-scheduler 的核心职责包括:

1. **监听未调度的 Pod**: 从 API Server watch 未调度的 Pod
2. **选择合适的节点**: 通过一系列调度算法为 Pod 选择最佳节点
3. **绑定 Pod 到节点**: 将调度决策更新到 API Server

### 1.2 架构设计原则

- **可扩展性**: 通过插件框架支持自定义调度逻辑
- **多调度器支持**: 通过 Profile 机制支持同时运行多个调度器
- **高性能**: 并行调度、缓存优化、采样算法
- **容错性**: 支持多实例部署和 Leader 选举

---

## 2. 核心数据结构

### 2.1 Scheduler 结构体

**位置**: `pkg/scheduler/scheduler.go:64-102`

```go
type Scheduler struct {
    // Cache 提供了调度器缓存,包含 podInfo 与 nodeInfo
    // 它是调度器和集群状态之间的桥梁,提供快速的节点信息查询
    Cache internalcache.Cache

	// SchedulingQueue 是调度队列,存储待调度的 Pod，包含三个队列
	// - activeQ 存储正在考虑进行调度的 Pod
	// - unschedulablePods 存储已经尝试过调度但目前被确定为无法调度的 Pod
	// - backoffQ 存储从 unschedulablePods 移出的 Pod，当它们的退避周期结束后，这些 Pod 将移至 activeQ
	SchedulingQueue internalqueue.SchedulingQueue

    // Profiles 允许多调度器配置
	// 存储调度配置的映射表,key 是 scheduler name，一个 Profile 包含一套完整的插件配置
    Profiles profile.Map

    // Extenders 是外部调度扩展器的列表
    // 它们通过 HTTP 协议与调度器交互,支持多语言实现和动态加载
    Extenders []framework.Extender

    // NextPod 是一个函数,从调度队列中获取下一个待调度的 Pod
    // 它会阻塞直到有可用的 Pod
    NextPod func() *framework.QueuedPodInfo

    // Error 是错误处理函数,当调度失败时被调用
    Error func(*framework.QueuedPodInfo, error)

    // SchedulePod 是核心调度函数,负责为 Pod 选择节点
    SchedulePod func(ctx context.Context, fwk framework.Framework, state *framework.CycleState, pod *v1.Pod) (ScheduleResult, error)

    // StopEverything 用于停止调度器
    StopEverything <-chan struct{}

    // client 是 Kubernetes 客户端,用于与 API Server 交互
    client clientset.Interface

    // nodeInfoSnapshot 是节点信息快照
    // 在每次调度周期开始时更新,保证调度过程中看到的一致性
    nodeInfoSnapshot *internalcache.Snapshot

    // nextStartNodeIndex 是下次调度开始的节点索引
    // 用于实现节点轮询,避免每次都从同一个节点开始评估
    nextStartNodeIndex int

    // percentageOfNodesToScore 控制在调度过程中评估多少比例的节点
    // 用于在大规模集群中提升性能
    percentageOfNodesToScore int32
}
```

**设计要点**:

1. **多调度器**: `Profiles` 字段支持同时运行多个调度器配置
2. **HTTP扩展**: `Extenders` 支持外部扩展,不修改核心代码即可扩展功能
3. **缓存机制**: `Cache` 和 `nodeInfoSnapshot` 分离了缓存和快照,优化性能
4. **高效调度**: `SchedulingQueue` 中利用三个队列实现更高效的调度方案，最大限度地避免了无效的调度重复
5. **公平调度**: `nextStartNodeIndex` 用于实现节点轮询,避免每次都从同一个节点开始评估
6. **节点采样**： 利用 `percentageOfNodesToScore` 控制在调度过程中评估多少比例的节点，在大规模集群中提升性能
7. **函数字段**: `NextPod`、`Error`、`SchedulePod` 使用函数类型,方便测试和扩展

### 2.2 Framework 接口

**位置**: `pkg/scheduler/framework/interface.go:493-569`

Framework 是调度框架的核心接口,负责管理所有调度插件:

```go
type Framework interface {
    Handle
    
	// ProfileName 返回该 Profile 的名称
	ProfileName() string

	// 检查是否有特定类型的插件
	HasFilterPlugins() bool
	HasPostFilterPlugins() bool
	HasScorePlugins() bool

    // ListPlugins 返回所有插件的配置
    ListPlugins() *config.Plugins

    // SetPodNominator 设置 Pod 提名器
    SetPodNominator(nominator PodNominator)

	// QueueSortFunc 返回用于对调度队列中的 Pod 进行排序的函数
	QueueSortFunc() LessFunc

    // 下面是各个扩展点的运行函数
    RunPreFilterPlugins(ctx context.Context, state *CycleState, pod *v1.Pod) (*PreFilterResult, *Status)
    RunPostFilterPlugins(ctx context.Context, state *CycleState, pod *v1.Pod, filteredNodeStatusMap NodeToStatusMap) (*PostFilterResult, *Status)

    RunPreBindPlugins(ctx context.Context, state *CycleState, pod *v1.Pod, nodeName string) *Status
    RunBindPlugins(ctx context.Context, state *CycleState, pod *v1.Pod, nodeName string) *Status
    RunPostBindPlugins(ctx context.Context, state *CycleState, pod *v1.Pod, nodeName string)

    RunReservePluginsReserve(ctx context.Context, state *CycleState, pod *v1.Pod, nodeName string) *Status
    RunReservePluginsUnreserve(ctx context.Context, state *CycleState, pod *v1.Pod, nodeName string)

    WaitOnPermit(ctx context.Context, pod *v1.Pod) *Status
    RunPermitPlugins(ctx context.Context, state *CycleState, pod *v1.Pod, nodeName string) *Status
}
```

### 2.3 FrameworkImpl 实现结构

**位置**: `pkg/scheduler/framework/runtime/framework.go:73-102`

```go
type frameworkImpl struct {
    // registry 是插件注册表,存储所有可用的插件工厂函数
    registry Registry

    // snapshotSharedLister 是节点信息的快照列表器
    snapshotSharedLister framework.SharedLister

    // waitingPods 存储正在等待许可的 Pod
    waitingPods *waitingPodsMap

    // scorePluginWeight 存储每个 Score 插件的权重
    scorePluginWeight map[string]int

    // 下面是各个扩展点的插件列表
    queueSortPlugins  []framework.QueueSortPlugin
    preFilterPlugins  []framework.PreFilterPlugin
    filterPlugins     []framework.FilterPlugin
    postFilterPlugins []framework.PostFilterPlugin
    preScorePlugins   []framework.PreScorePlugin
    scorePlugins      []framework.ScorePlugin
    preBindPlugins    []framework.PreBindPlugin
    bindPlugins       []framework.BindPlugin
    postBindPlugins   []framework.PostBindPlugin
    permitPlugins     []framework.PermitPlugin
    reservePlugins    []framework.ReservePlugin

    // 客户端和配置
    clientSet       clientset.Interface
    kubeConfig      *restclient.Config
    eventRecorder   events.EventRecorder
    informerFactory informers.SharedInformerFactory

    metricsRecorder *metricsRecorder
    profileName     string

    extenders   []framework.Extender
    PodNominator framework.PodNominator

    parallelizer parallelize.Parallelizer
}
```

---

## 3. 创建与启动流程

### 3.1 整体流程图

```
┌──────────────────────────────────────────────────────────────┐
│                     kube-scheduler 启动流程                   │
└──────────────────────────────────────────────────────────────┘

main()
  │
  └─▶ app.NewSchedulerCommand()
       │
       └─▶ runCommand()
            │
            ├─▶ Setup()          ← 创建 Scheduler 实例
            │    │
            │    ├─▶ 加载配置文件
            │    ├─▶ 创建 InformerFactory
            │    ├─▶ 构建 Profile Map
            │    └─▶ scheduler.New()
            │         │
            │         ├─▶ 初始化插件注册表
            │         ├─▶ 创建 Extender
            │         ├─▶ 创建 Framework (Profile)
            │         ├─▶ 创建调度队列
            │         └─▶ 创建 Scheduler 对象
            │
            └─▶ Run()             ← 启动调度器
                 │
                 ├─▶ 启动 Informer
                 ├─▶ 等待 Cache 同步
                 ├─▶ 启动 Leader 选举 (如果启用)
                 └─▶ sched.Run()  ← 开始调度循环
                      │
                      └─▶ wait.Until(scheduleOne)
```

### 3.2 Scheduler 创建详解

**位置**: `pkg/scheduler/scheduler.go:234-334`

```go
func New(client clientset.Interface,
    informerFactory informers.SharedInformerFactory,
    dynInformerFactory dynamicinformer.DynamicSharedInformerFactory,
    recorderFactory profile.RecorderFactory,
    stopCh <-chan struct{},
    opts ...Option) (*Scheduler, error) {

    // 步骤 1: 应用选项
    options := defaultSchedulerOptions
    for _, opt := range opts {
        opt(&options)
    }

    // 步骤 2: 如果没有指定 Profile,使用默认配置
    if options.applyDefaultProfile {
        var versionedCfg v1beta3.KubeSchedulerConfiguration
        scheme.Scheme.Default(&versionedCfg)
        cfg := schedulerapi.KubeSchedulerConfiguration{}
        scheme.Scheme.Convert(&versionedCfg, &cfg, nil)
        options.profiles = cfg.Profiles
    }

    // 步骤 3: 创建插件注册表
    registry := frameworkplugins.NewInTreeRegistry()
    if err := registry.Merge(options.frameworkOutOfTreeRegistry); err != nil {
        return nil, err
    }

    // 步骤 4: 构建 Extenders
    extenders, err := buildExtenders(options.extenders, options.profiles)
    if err != nil {
        return nil, fmt.Errorf("couldn't build extenders: %w", err)
    }

    // 步骤 5: 创建 Profile Map
    snapshot := internalcache.NewEmptySnapshot()
    clusterEventMap := make(map[framework.ClusterEvent]sets.String)

    profiles, err := profile.NewMap(options.profiles, registry, recorderFactory,
        frameworkruntime.WithComponentConfigVersion(options.componentConfigVersion),
        frameworkruntime.WithClientSet(client),
        frameworkruntime.WithKubeConfig(options.kubeConfig),
        frameworkruntime.WithInformerFactory(informerFactory),
        frameworkruntime.WithSnapshotSharedLister(snapshot),
        frameworkruntime.WithCaptureProfile(frameworkruntime.CaptureProfile(options.frameworkCapturer)),
        frameworkruntime.WithClusterEventMap(clusterEventMap),
        frameworkruntime.WithParallelism(int(options.parallelism)),
        frameworkruntime.WithExtenders(extenders),
    )
    if err != nil {
        return nil, fmt.Errorf("initializing profiles: %v", err)
    }

    // 步骤 6: 创建调度队列
    podQueue := internalqueue.NewSchedulingQueue(
        profiles[options.profiles[0].SchedulerName].QueueSortFunc(),
        informerFactory,
        internalqueue.WithPodInitialBackoffDuration(time.Duration(options.podInitialBackoffSeconds)*time.Second),
        internalqueue.WithPodMaxBackoffDuration(time.Duration(options.podMaxBackoffSeconds)*time.Second),
        internalqueue.WithPodLister(podLister),
        internalqueue.WithClusterEventMap(clusterEventMap),
        internalqueue.WithPodMaxInUnschedulablePodsDuration(options.podMaxInUnschedulablePodsDuration),
    )

    // 步骤 7: 创建 Scheduler 对象
    sched := newScheduler(
        schedulerCache,
        extenders,
        internalqueue.MakeNextPodFunc(podQueue),
        MakeDefaultErrorFunc(client, podLister, podQueue, schedulerCache),
        stopEverything,
        podQueue,
        profiles,
        client,
        snapshot,
        options.percentageOfNodesToScore,
    )

    // 步骤 8: 添加事件处理器
    addAllEventHandlers(sched, informerFactory, dynInformerFactory, unionedGVKs(clusterEventMap))

    return sched, nil
}
```

**关键步骤解析**:

1. **选项模式**: 使用 Option 模式灵活配置 Scheduler
2. **插件注册表**: 合并内置插件和自定义插件
3. **Profile 创建**: 每个对应一个调度器配置
4. **事件处理**: 注册 Pod/Node 等资源的 Watch 处理器

### 3.3 Scheduler 启动流程

**位置**: `pkg/scheduler/scheduler.go:337-341`

```go
func (sched *Scheduler) Run(ctx context.Context) {
    // 启动调度队列
    sched.SchedulingQueue.Run()

    // 启动调度循环
    wait.UntilWithContext(ctx, sched.scheduleOne, 0)

    // 关闭调度队列
    sched.SchedulingQueue.Close()
}
```

**位置**: `cmd/kube-scheduler/app/server.go:145-236`

```go
func Run(ctx context.Context, cc *schedulerserverconfig.CompletedConfig, sched *scheduler.Scheduler) error {
    // 步骤 1: 启动健康检查服务
    if cc.SecureServing != nil {
        handler := buildHandlerChain(...)
        cc.SecureServing.Serve(handler, 0, ctx.Done())
    }

    // 步骤 2: 启动 Informer
    cc.InformerFactory.Start(ctx.Done())
    if cc.DynInformerFactory != nil {
        cc.DynInformerFactory.Start(ctx.Done())
    }

    // 步骤 3: 等待 Cache 同步
    cc.InformerFactory.WaitForCacheSync(ctx.Done())
    if cc.DynInformerFactory != nil {
        cc.DynInformerFactory.WaitForCacheSync(ctx.Done())
    }

    // 步骤 4: 配置 Leader 选举
    if cc.LeaderElection != nil {
        cc.LeaderElection.Callbacks = leaderelection.LeaderCallbacks{
            OnStartedLeading: func(ctx context.Context) {
                close(waitingForLeader)
                sched.Run(ctx)  // 当选 Leader 后启动调度
            },
            OnStoppedLeading: func() {
                // 失去 Leader 权后的处理
            },
        }
        leaderElector, err := leaderelection.NewLeaderElector(*cc.LeaderElection)
        leaderElector.Run(ctx)
    } else {
        // 未启用 Leader 选举,直接启动
        close(waitingForLeader)
        sched.Run(ctx)
    }

    return fmt.Errorf("finished without leader elect")
}
```

---

## 4. Profile 调度配置

### 4.1 Profile 概念

**Profile** 是调度器的配置实例,每个 Profile 包含:
- **SchedulerName**: 调度器名称,Pod 的 `spec.schedulerName` 字段匹配该名称
- **Plugins**: 插件配置,指定哪些插件启用/禁用
- **PluginConfig**: 插件参数配置

**多调度器场景**:

```
Pod1 (schedulerName: "default-scheduler")  →  Profile "default-scheduler"
Pod2 (schedulerName: "gpu-scheduler")      →  Profile "gpu-scheduler"
Pod3 (schedulerName: "custom-scheduler")   →  Profile "custom-scheduler"
```

### 4.2 Profile 结构定义

**位置**: `pkg/scheduler/apis/config/types.go:101-122`

```go
type KubeSchedulerProfile struct {
    // SchedulerName 是该 Profile 的名称
    // Pod 的 spec.schedulerName 必须匹配这个名称才能使用该 Profile
    SchedulerName string

    // Plugins 指定要启用或禁用的插件集合
    // Enabled: 在默认插件基础上额外启用的插件
    // Disabled: 禁用的默认插件
    Plugins *Plugins

    // PluginConfig 是每个插件的自定义参数
    // 如果省略某个插件的配置,则使用默认配置
    PluginConfig []PluginConfig
}
```

### 4.3 Plugins 配置结构

**位置**: `pkg/scheduler/apis/config/types.go:124-167`

```go
type Plugins struct {
    // QueueSort: 队列排序插件 (只能有一个)
    QueueSort PluginSet

    // PreFilter: 预过滤插件
    PreFilter PluginSet

    // Filter: 过滤插件
    Filter PluginSet

    // PostFilter: 后过滤插件 (调度失败时执行)
    PostFilter PluginSet

    // PreScore: 预打分插件
    PreScore PluginSet

    // Score: 打分插件
    Score PluginSet

    // Reserve: 预留插件
    Reserve PluginSet

    // Permit: 许可插件
    Permit PluginSet

    // PreBind: 预绑定插件
    PreBind PluginSet

    // Bind: 绑定插件
    Bind PluginSet

    // PostBind: 后绑定插件
    PostBind PluginSet

    // MultiPoint: 多点插件 (一次性配置多个扩展点)
    MultiPoint PluginSet
}

type PluginSet struct {
    // Enabled: 启用的插件列表
    Enabled []Plugin

    // Disabled: 禁用的插件列表
    // 使用 ["*"] 禁用所有默认插件
    Disabled []Plugin
}

type Plugin struct {
    // Name: 插件名称
    Name string

    // Weight: 权重 (仅用于 Score 插件)
    Weight int32
}
```

### 4.4 Profile 创建流程

**位置**: `pkg/scheduler/profile/profile.go:47-64`

```go
func NewMap(cfgs []config.KubeSchedulerProfile, r frameworkruntime.Registry, recorderFact RecorderFactory,
    opts ...frameworkruntime.Option) (Map, error) {

    m := make(Map)
    v := cfgValidator{m: m}

    // 为每个配置创建一个 Profile
    for _, cfg := range cfgs {
        p, err := newProfile(cfg, r, recorderFact, opts...)
        if err != nil {
            return nil, fmt.Errorf("creating profile for scheduler name %s: %v", cfg.SchedulerName, err)
        }

        // 验证配置
        if err := v.validate(cfg, p); err != nil {
            return nil, err
        }

        m[cfg.SchedulerName] = p
    }
    return m, nil
}

func newProfile(cfg config.KubeSchedulerProfile, r frameworkruntime.Registry, recorderFact RecorderFactory,
    opts ...frameworkruntime.Option) (framework.Framework, error) {

    recorder := recorderFact(cfg.SchedulerName)
    opts = append(opts, frameworkruntime.WithEventRecorder(recorder))
    return frameworkruntime.NewFramework(r, &cfg, opts...)
}
```

### 4.5 Profile 配置示例

```yaml
apiVersion: kubescheduler.config.k8s.io/v1beta3
kind: KubeSchedulerConfiguration
profiles:
  # 默认调度器配置
  - schedulerName: default-scheduler
    plugins:
      queueSort:
        enabled:
          - name: PrioritySort
      filter:
        enabled:
          - name: NodeUnschedulable
          - name: NodeName
          - name: NodePorts
          - name: NodeResourcesFit
      score:
        enabled:
          - name: NodeResourcesFit
            weight: 1
          - name: NodeAffinity
            weight: 1
    pluginConfig:
      - name: NodeResourcesFit
        args:
          mode: Least

  # GPU 专用调度器配置
  - schedulerName: gpu-scheduler
    plugins:
      filter:
        enabled:
          - name: NodeUnschedulable
          - name: NodeName
          - name: NodeResourcesFit
          - name: GPUResources
      score:
        enabled:
          - name: NodeResourcesFit
            weight: 1
          - name: GPUAllocatable
            weight: 10
    pluginConfig:
      - name: GPUResources
        args:
          resource: nvidia.com/gpu
```

---

## 5. Framework 插件框架

### 5.1 Framework 架构设计

Framework 是 kube-scheduler 的**核心抽象层**,负责:

1. **插件生命周期管理**: 初始化、配置、销毁
2. **扩展点调用**: 按顺序调用各个扩展点的插件
3. **状态管理**: 维护调度周期状态 (CycleState)
4. **并发控制**: 控制插件执行的并行度

**架构图**:

```
┌─────────────────────────────────────────────────────────────┐
│                      Framework                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │ QueueSort   │  │ PreFilter   │  │  Filter     │          │
│  │  Plugins    │  │  Plugins    │  │  Plugins    │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │ PostFilter  │  │ PreScore    │  │   Score     │          │
│  │  Plugins    │  │  Plugins    │  │  Plugins    │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │  Reserve    │  │  Permit     │  │   Bind      │          │
│  │  Plugins    │  │  Plugins    │  │  Plugins    │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐                           │
│  │  PreBind    │  │ PostBind    │                           │
│  │  Plugins    │  │  Plugins    │                           │
│  └─────────────┘  └─────────────┘                           │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                     Handle Interface                        │
│  - ClientSet()                                              │
│  - SharedInformerFactory()                                  │
│  - EventRecorder()                                          │
│  - SnapshotSharedLister()                                   │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Framework 初始化流程

**位置**: `pkg/scheduler/framework/runtime/framework.go:248-371`

```go
func NewFramework(r Registry, profile *config.KubeSchedulerProfile, opts ...Option) (framework.Framework, error) {
    // 步骤 1: 应用选项
    options := defaultFrameworkOptions()
    for _, opt := range opts {
        opt(&options)
    }

    // 步骤 2: 创建 frameworkImpl 实例
    f := &frameworkImpl{
        registry:             r,
        snapshotSharedLister: options.snapshotSharedLister,
        scorePluginWeight:    make(map[string]int),
        waitingPods:          newWaitingPodsMap(),
        clientSet:            options.clientSet,
        kubeConfig:           options.kubeConfig,
        eventRecorder:        options.eventRecorder,
        informerFactory:      options.informerFactory,
        metricsRecorder:      options.metricsRecorder,
        extenders:            options.extenders,
        PodNominator:         options.podNominator,
        parallelizer:         options.parallelizer,
    }

    // 步骤 3: 获取需要的插件列表
    pg := f.pluginsNeeded(profile.Plugins)

    // 步骤 4: 构建插件配置映射
    pluginConfig := make(map[string]runtime.Object, len(profile.PluginConfig))
    for i := range profile.PluginConfig {
        name := profile.PluginConfig[i].Name
        pluginConfig[name] = profile.PluginConfig[i].Args
    }

    // 步骤 5: 初始化插件
    pluginsMap := make(map[string]framework.Plugin)
    for name, factory := range r {
        if _, ok := pg[name]; !ok {
            continue  // 跳过不需要的插件
        }

        args := pluginConfig[name]
        p, err := factory(args, f)  // 调用插件工厂函数
        if err != nil {
            return nil, fmt.Errorf("initializing plugin %q: %w", name, err)
        }
        pluginsMap[name] = p

        // 更新集群事件映射
        fillEventToPluginMap(p, options.clusterEventMap)
    }

    // 步骤 6: 初始化各个扩展点的插件列表
    for _, e := range f.getExtensionPoints(profile.Plugins) {
        if err := updatePluginList(e.slicePtr, *e.plugins, pluginsMap); err != nil {
            return nil, err
        }
    }

    // 步骤 7: 展开 MultiPoint 插件
    if len(profile.Plugins.MultiPoint.Enabled) > 0 {
        if err := f.expandMultiPointPlugins(profile, pluginsMap); err != nil {
            return nil, err
        }
    }

    // 步骤 8: 验证配置
    if len(f.queueSortPlugins) != 1 {
        return nil, fmt.Errorf("one queue sort plugin required")
    }

    // 步骤 9: 初始化 Score 插件权重
    if err := getScoreWeights(f, pluginsMap, append(profile.Plugins.Score.Enabled, profile.Plugins.MultiPoint.Enabled...)); err != nil {
        return nil, err
    }

    return f, nil
}
```

**关键步骤解析**:

1. **延迟初始化**: 只初始化配置中启用的插件
2. **插件配置**: 每个插件可以接收自定义参数
3. **MultiPoint 展开**: 将配置在 MultiPoint 的插件展开到各个扩展点
4. **权重验证**: 确保 Score 插件的权重配置正确

### 5.3 扩展点 (Extension Points)

Framework 定义了**11 个扩展点**,覆盖调度流程的各个阶段:

#### 5.3.1 QueueSort (队列排序)

**接口**: `pkg/scheduler/framework/interface.go:302-309`

```go
type QueueSortPlugin interface {
    Plugin
    // Less 定义排序规则
    // 返回 true 表示 podInfo1 应该排在 podInfo2 前面
    Less(*QueuedPodInfo, *QueuedPodInfo) bool
}
```

**特点**:
- **只能有一个** QueueSort 插件启用
- 决定 Pod 从队列中弹出的顺序
- 通常按优先级、创建时间排序

**默认插件**: `PrioritySort`

#### 5.3.2 PreFilter (预过滤)

**接口**: `pkg/scheduler/framework/interface.go:336-352`

```go
type PreFilterPlugin interface {
    Plugin
    // PreFilter 在调度周期开始时调用
    // 可以返回需要检查的节点子集,优化后续过滤性能
    PreFilter(ctx context.Context, state *CycleState, p *v1.Pod) (*PreFilterResult, *Status)

    // PreFilterExtensions 返回增量更新接口
    PreFilterExtensions() PreFilterExtensions
}
```

**用途**:
- 预处理 Pod 信息
- 缩小节点搜索范围
- 为后续插件准备数据

**默认插件**: `NodeResourcesFit`, `NodePorts`, `NodeAffinity` 等

#### 5.3.3 Filter (过滤)

**接口**: `pkg/scheduler/framework/interface.go:354-375`

```go
type FilterPlugin interface {
    Plugin
    // Filter 检查节点是否能运行该 Pod
    // 返回 Success 表示节点合适
    // 返回 Unschedulable 表示节点不合适
    // 返回 Error 表示内部错误
    Filter(ctx context.Context, state *CycleState, pod *v1.Pod, nodeInfo *NodeInfo) *Status
}
```

**特点**:
- **并行执行**: 所有节点可以并行过滤
- **短路机制**: 一个插件失败即可拒绝节点

**默认插件**: `NodeUnschedulable`, `NodeName`, `NodePorts`, `NodeResourcesFit` 等

#### 5.3.4 PostFilter (后过滤)

**接口**: `pkg/scheduler/framework/interface.go:377-392`

```go
type PostFilterPlugin interface {
    Plugin
    // PostFilter 在没有找到合适节点时调用
    // 可以尝试抢占 (Preemption) 等机制使 Pod 可调度
    PostFilter(ctx context.Context, state *CycleState, pod *v1.Pod, filteredNodeStatusMap NodeToStatusMap) (*PostFilterResult, *Status)
}
```

**用途**:
- 抢占逻辑
- 调整 Pod 需求
- 生成诊断信息

**默认插件**: `DefaultPreemption`

#### 5.3.5 PreScore (预打分)

**接口**: `pkg/scheduler/framework/interface.go:394-404`

```go
type PreScorePlugin interface {
    Plugin
    // PreScore 在打分前调用,可以做一些准备工作
    // 可以访问通过 Filter 的所有节点
    PreScore(ctx context.Context, state *CycleState, pod *v1.Pod, nodes []*v1.Node) *Status
}
```

**用途**:
- 预计算共享数据
- 初始化打分状态

**默认插件**: `InterPodAffinity`, `NodeResourcesFit` 等

#### 5.3.6 Score (打分)

**接口**: `pkg/scheduler/framework/interface.go:414-425`

```go
type ScorePlugin interface {
    Plugin
    // Score 为节点打分,返回 0-100 的分数
    Score(ctx context.Context, state *CycleState, p *v1.Pod, nodeName string) (int64, *Status)

    // ScoreExtensions 返回归一化接口
    ScoreExtensions() ScoreExtensions
}
```

**特点**:
- **并行执行**: 所有节点可以并行打分
- **权重支持**: 每个插件有权重,最终分数 = Σ(插件分数 × 权重)

**默认插件**: `NodeResourcesFit`, `NodeAffinity`, `TaintToleration` 等

#### 5.3.7 Reserve (预留)

**接口**: `pkg/scheduler/framework/interface.go:427-445`

```go
type ReservePlugin interface {
    Plugin
    // Reserve 为 Pod 预留资源
    // 如果失败,会调用 Unreserve 撤销
    Reserve(ctx context.Context, state *CycleState, p *v1.Pod, nodeName string) *Status

    // Unreserve 撤销预留
    // 必须是幂等的,可能被多次调用
    Unreserve(ctx context.Context, state *CycleState, p *v1.Pod, nodeName string)
}
```

**用途**:
- PV 绑定
- 资源预留

**默认插件**: `VolumeBinding`

#### 5.3.8 Permit (许可)

**接口**: `pkg/scheduler/framework/interface.go:467-478`

```go
type PermitPlugin interface {
    Plugin
    // Permit 可以延迟或拒绝 Pod 绑定
    // 返回 (Success, 0): 立即继续
    // 返回 (Wait, timeout): 等待批准
    // 返回 (Unschedulable, 0): 拒绝绑定
    Permit(ctx context.Context, state *CycleState, p *v1.Pod, nodeName string) (*Status, time.Duration)
}
```

**用途**:
- 人工审批
- 等待外部资源准备

**默认插件**: 无 (需要自定义)

#### 5.3.9 PreBind (预绑定)

**接口**: `pkg/scheduler/framework/interface.go:447-454`

```go
type PreBindPlugin interface {
    Plugin
    // PreBind 在绑定前执行准备工作
    PreBind(ctx context.Context, state *CycleState, p *v1.Pod, nodeName string) *Status
}
```

**用途**:
- 执行存储卷挂载前的操作
- 配置网络

**默认插件**: `VolumeBinding`

#### 5.3.10 Bind (绑定)

**接口**: `pkg/scheduler/framework/interface.go:480-491`

```go
type BindPlugin interface {
    Plugin
    // Bind 将 Pod 绑定到节点
    // 返回 Skip 表示跳过,让下一个 Bind 插件处理
    // 返回 Success 表示绑定成功
    // 返回 Error 表示绑定失败
    Bind(ctx context.Context, state *CycleState, p *v1.Pod, nodeName string) *Status
}
```

**特点**:
- **短路机制**: 第一个不返回 Skip 的插件处理绑定

**默认插件**: `DefaultBinder`

#### 5.3.11 PostBind (后绑定)

**接口**: `pkg/scheduler/framework/interface.go:456-465`

```go
type PostBindPlugin interface {
    Plugin
    // PostBind 在绑定成功后执行清理工作
    PostBind(ctx context.Context, state *CycleState, p *v1.Pod, nodeName string)
}
```

**用途**:
- 清理临时状态
- 记录绑定信息

**默认插件**: 无

### 5.4 插件配置示例

```yaml
apiVersion: kubescheduler.config.k8s.io/v1beta3
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: default-scheduler
    plugins:
      queueSort:
        enabled:
          - name: PrioritySort
      preFilter:
        enabled:
          - name: NodeResourcesFit
          - name: NodePorts
          - name: NodeAffinity
      filter:
        enabled:
          - name: NodeUnschedulable
          - name: NodeName
          - name: NodePorts
          - name: NodeResourcesFit
          - name: NodeAffinity
      preScore:
        enabled:
          - name: NodeResourcesFit
          - name: InterPodAffinity
      score:
        enabled:
          - name: NodeResourcesFit
            weight: 2
          - name: NodeAffinity
            weight: 1
          - name: TaintToleration
            weight: 1
      reserve:
        enabled:
          - name: VolumeBinding
      preBind:
        enabled:
          - name: VolumeBinding
      bind:
        enabled:
          - name: DefaultBinder
    pluginConfig:
      - name: NodeResourcesFit
        args:
          mode: Least  # Most 或 Least
      - name: VolumeBinding
        args:
          bindTimeoutSeconds: 30
```

---

## 6. Extender 扩展机制

### 6.1 Extender 概念

**Extender** 是 kube-scheduler 的**外部扩展机制**,通过 HTTP 协议与调度器通信。

**与 Framework Plugin 的区别**:

| 特性 | Framework Plugin | Extender |
|------|------------------|----------|
| **实现语言** | Go | 任意语言 (通过 HTTP) |
| **部署方式** | 编译进调度器 | 独立服务 |
| **配置方式** | 代码配置 | HTTP URL |
| **性能** | 高 (进程内调用) | 低 (网络通信) |
| **灵活性** | 中 | 高 (独立升级) |
| **扩展点** | 11 个 | Filter, Prioritize, Bind, Preempt |

### 6.2 Extender 结构定义

**配置结构**: `pkg/scheduler/apis/config/types.go:198-?`

```go
type Extender struct {
    // URLPrefix 是 Extender 服务的 URL 前缀
    // 例如: http://my-scheduler-extender:8080
    URLPrefix string

    // FilterVerb 是过滤操作的 HTTP 路径
    // 例如: /filter
    FilterVerb string

    // PrioritizeVerb 是打分操作的 HTTP 路径
    // 例如: /prioritize
    PrioritizeVerb string

    // PreemptVerb 是抢占操作的 HTTP 路径
    PreemptVerb string

    // BindVerb 是绑定操作的 HTTP 路径
    // 如果为空,表示不处理绑定
    BindVerb string

    // Weight 是打分权重 (仅用于 Prioritize)
    Weight int64

    // ManagedResources 是该 Extender 管理的资源列表
    // 如果 Pod 请求了这些资源,会调用该 Extender
    ManagedResources []ExtenderManagedResource

    // Ignorable 决定了当 Extender 不可用时是否失败
    // 如果为 true,Extender 错误会被忽略
    Ignorable bool

    // HTTPTimeout 是 HTTP 请求超时时间
    HTTPTimeout metav1.Duration

    // NodeCacheCapable 表示 Extender 是否维护节点缓存
    // 如果为 true,调度器只发送节点名称
    NodeCacheCapable bool

    // TLSConfig 是 HTTPS 配置
    TLSConfig *ExtenderTLSConfig
}

type ExtenderManagedResource struct {
    // Name 是资源名称
    // 例如: nvidia.com/gpu
    Name string

    // IgnoredByScheduler 表示调度器是否忽略该资源
    IgnoredByScheduler bool
}
```

### 6.3 HTTPExtender 实现

**位置**: `pkg/scheduler/extender.go:42-53`

```go
type HTTPExtender struct {
    extenderURL      string
    preemptVerb      string
    filterVerb       string
    prioritizeVerb   string
    bindVerb         string
    weight           int64
    client           *http.Client
    nodeCacheCapable bool
    managedResources sets.String
    ignorable        bool
}
```

### 6.4 Extender 接口实现

**位置**: `pkg/scheduler/framework/extender.go:29-78`

```go
type Extender interface {
    // Name 返回 Extender 的标识
    Name() string

    // IsIgnorable 返回 Extender 是否可忽略
    IsIgnorable() bool

    // SupportsPreemption 返回是否支持抢占
    SupportsPreemption() bool

    // ProcessPreemption 执行抢占逻辑
    ProcessPreemption(
        pod *v1.Pod,
        nodeNameToVictims map[string]*extenderv1.Victims,
        nodeInfos framework.NodeInfoLister,
    ) (map[string]*extenderv1.Victims, error)

    // Filter 过滤节点
    Filter(
        pod *v1.Pod,
        nodes []*v1.Node,
    ) (filteredList []*v1.Node, failedNodes, failedAndUnresolvableNodes extenderv1.FailedNodesMap, err error)

    // Prioritize 为节点打分
    Prioritize(pod *v1.Pod, nodes []*v1.Node) (*extenderv1.HostPriorityList, int64, error)

    // Bind 绑定 Pod
    Bind(binding *v1.Binding) error

    // IsBinder 返回是否处理绑定
    IsBinder() bool

    // IsInterested 返回是否对 Pod 感兴趣
    IsInterested(pod *v1.Pod) bool
}
```

### 6.5 Extender 调用流程

#### 6.5.1 Filter 调用

**位置**: `pkg/scheduler/extender.go:272-342`

```go
func (h *HTTPExtender) Filter(
    pod *v1.Pod,
    nodes []*v1.Node,
) (filteredList []*v1.Node, failedNodes, failedAndUnresolvableNodes extenderv1.FailedNodesMap, err error) {

    // 准备参数
    args := &extenderv1.ExtenderArgs{
        Pod: pod,
    }

    if h.nodeCacheCapable {
        // Extender 有节点缓存,只发送节点名称
        nodeNameSlice := make([]string, 0, len(nodes))
        for _, node := range nodes {
            nodeNameSlice = append(nodeNameSlice, node.Name)
        }
        args.NodeNames = &nodeNameSlice
    } else {
        // 发送完整的节点信息
        nodeList := &v1.NodeList{}
        for _, node := range nodes {
            nodeList.Items = append(nodeList.Items, *node)
        }
        args.Nodes = nodeList
    }

    // 发送 HTTP 请求
    var result extenderv1.ExtenderFilterResult
    if err := h.send(h.filterVerb, args, &result); err != nil {
        return nil, nil, nil, err
    }

    // 处理返回结果
    nodeResult := make([]*v1.Node, 0)
    if h.nodeCacheCapable && result.NodeNames != nil {
        // 根据返回的节点名称构建节点列表
        fromNodeName := make(map[string]*v1.Node)
        for _, n := range nodes {
            fromNodeName[n.Name] = n
        }
        for _, nodeName := range *result.NodeNames {
            if n, ok := fromNodeName[nodeName]; ok {
                nodeResult = append(nodeResult, n)
            }
        }
    } else if result.Nodes != nil {
        // 直接使用返回的节点列表
        for i := range result.Nodes.Items {
            nodeResult = append(nodeResult, &result.Nodes.Items[i])
        }
    }

    return nodeResult, result.FailedNodes, result.FailedAndUnresolvableNodes, nil
}
```

#### 6.5.2 Prioritize 调用

**位置**: `pkg/scheduler/extender.go:344-386`

```go
func (h *HTTPExtender) Prioritize(pod *v1.Pod, nodes []*v1.Node) (*extenderv1.HostPriorityList, int64, error) {
    // 准备参数
    args := &extenderv1.ExtenderArgs{
        Pod: pod,
    }

    if h.nodeCacheCapable {
        nodeNameSlice := make([]string, 0, len(nodes))
        for _, node := range nodes {
            nodeNameSlice = append(nodeNameSlice, node.Name)
        }
        args.NodeNames = &nodeNameSlice
    } else {
        nodeList := &v1.NodeList{}
        for _, node := range nodes {
            nodeList.Items = append(nodeList.Items, *node)
        }
        args.Nodes = nodeList
    }

    // 发送 HTTP 请求
    var result extenderv1.HostPriorityList
    if err := h.send(h.prioritizeVerb, args, &result); err != nil {
        return nil, 0, err
    }

    return &result, h.weight, nil
}
```

#### 6.5.3 Bind 调用

**位置**: `pkg/scheduler/extender.go:388-408`

```go
func (h *HTTPExtender) Bind(binding *v1.Binding) error {
    var result extenderv1.ExtenderBindingResult
    if !h.IsBinder() {
        return fmt.Errorf("unexpected empty bindVerb in extender")
    }

    req := &extenderv1.ExtenderBindingArgs{
        PodName:      binding.Name,
        PodNamespace: binding.Namespace,
        PodUID:       binding.UID,
        Node:         binding.Target.Name,
    }

    if err := h.send(h.bindVerb, req, &result); err != nil {
        return err
    }

    if result.Error != "" {
        return fmt.Errorf(result.Error)
    }
    return nil
}
```

### 6.6 Extender 配置示例

```yaml
apiVersion: kubescheduler.config.k8s.io/v1beta3
kind: KubeSchedulerConfiguration
extenders:
  # GPU 资源 Extender
  - urlPrefix: "http://gpu-scheduler-extender:8080"
    filterVerb: "/filter"
    prioritizeVerb: "/prioritize"
    weight: 10
    enableHTTPS: false
    nodeCacheCapable: true
    ignorable: false
    managedResources:
      - name: nvidia.com/gpu
        ignoredByScheduler: false
    httpTimeout: 5s

  # 网络策略 Extender
  - urlPrefix: "https://network-policy-scheduler:8443"
    filterVerb: "/filter"
    bindVerb: "/bind"
    weight: 5
    enableHTTPS: true
    tlsConfig:
      insecure: false
      certFile: /etc/kubernetes/scheduler/extender-client.crt
      keyFile: /etc/kubernetes/scheduler/extender-client.key
      caFile: /etc/kubernetes/scheduler/extender-ca.crt
    nodeCacheCapable: false
    ignorable: true
    httpTimeout: 10s
```

### 6.7 Extender HTTP API 规范

#### 6.7.1 Filter API

**请求**:

```json
POST /filter
Content-Type: application/json

{
  "pod": {
    "metadata": {
      "name": "my-pod",
      "namespace": "default"
    },
    "spec": {
      "containers": [...]
    }
  },
  "nodes": {
    "items": [
      {
        "metadata": {"name": "node-1"},
        "status": {...}
      }
    ]
  },
  "nodeNames": ["node-1", "node-2"]
}
```

**响应**:

```json
{
  "nodes": {
    "items": [
      {
        "metadata": {"name": "node-1"}
      }
    ]
  },
  "nodeNames": ["node-1"],
  "failedNodes": {
    "node-2": "Insufficient gpu"
  },
  "failedAndUnresolvableNodes": {
    "node-3": "Network policy violation"
  },
  "error": ""
}
```

#### 6.7.2 Prioritize API

**请求**:

```json
POST /prioritize
Content-Type: application/json

{
  "pod": {...},
  "nodes": {...},
  "nodeNames": ["node-1", "node-2"]
}
```

**响应**:

```json
[
  {
    "host": "node-1",
    "score": 95
  },
  {
    "host": "node-2",
    "score": 80
  }
]
```

#### 6.7.3 Bind API

**请求**:

```json
POST /bind
Content-Type: application/json

{
  "podName": "my-pod",
  "podNamespace": "default",
  "podUID": "12345",
  "node": "node-1"
}
```

**响应**:

```json
{
  "error": ""
}
```

---

## 7. 扩展点总结

### 7.1 扩展方式对比

| 扩展方式 | 实现复杂度 | 性能 | 灵活性 | 适用场景 |
|---------|----------|------|--------|----------|
| **Framework Plugin** | 中 | 高 | 中 | 内置调度逻辑 |
| **Extender** | 低 | 中 | 高 | 外部系统集成 |
| **多 Profile** | 低 | 高 | 高 | 多调度策略 |

### 7.2 扩展点一览表

| 扩展点 | Plugin | Extender | 用途 | 默认插件 |
|-------|--------|----------|------|----------|
| **QueueSort** | ✓ | ✗ | 队列排序 | PrioritySort |
| **PreFilter** | ✓ | ✗ | 预处理 | NodeResourcesFit, NodePorts |
| **Filter** | ✓ | ✓ | 节点过滤 | NodeUnschedulable, NodeName |
| **PostFilter** | ✓ | ✗ | 调度后处理 | DefaultPreemption |
| **PreScore** | ✓ | ✗ | 打分预处理 | InterPodAffinity |
| **Score** | ✓ | ✓ | 节点打分 | NodeResourcesFit, NodeAffinity |
| **Reserve** | ✓ | ✗ | 资源预留 | VolumeBinding |
| **Permit** | ✓ | ✗ | 绑定许可 | 无 |
| **PreBind** | ✓ | ✗ | 绑定前准备 | VolumeBinding |
| **Bind** | ✓ | ✓ | Pod 绑定 | DefaultBinder |
| **PostBind** | ✓ | ✗ | 绑定后清理 | 无 |
| **Preempt** | ✗ | ✓ | 抢占 | 无 |

### 7.3 如何选择扩展方式

**使用 Framework Plugin 当**:
- 需要高性能
- 实现 Go 代码
- 需要访问调度器内部状态
- 需要与内置插件紧密集成

**使用 Extender 当**:
- 需要使用非 Go 语言实现
- 需要独立部署和升级
- 需要与外部系统集成
- 不在意轻微的性能损耗

**使用多 Profile 当**:
- 需要支持多种调度策略
- 不同类型的 Pod 需要不同的调度逻辑
- 需要隔离不同业务线的调度配置

### 7.4 最佳实践

1. **优先使用内置插件**: 内置插件经过充分测试,性能优化好
2. **合理配置 Score 权重**: 避免某个插件权重过大导致其他插件失效
3. **Extender 用于集成**: Extender 适合与外部系统集成,如云平台、监控系统
4. **MultiPoint 简化配置**: 使用 MultiPoint 可以简化插件配置
5. **测试扩展点**: 编写单元测试和集成测试,确保扩展逻辑正确

---

## 总结

kube-scheduler 通过精心设计的架构实现了高度可扩展的调度框架:

1. **核心组件**: Scheduler、Framework、Profile 各司其职
2. **插件框架**: 11 个扩展点覆盖调度全流程
3. **扩展机制**: Framework Plugin + Extender + Multi Profile 支持各种定制需求
4. **性能优化**: 并行执行、缓存机制、采样算法

理解这些架构设计,对于深入掌握 Kubernetes 调度原理和进行二次开发都至关重要。
