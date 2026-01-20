---
title: "深入理解 kube-proxy(1)-整体架构与启动流程"
date: 2026-01-19T18:00:00+08:00
draft: false
tags: ["kubernetes", "源码解析", "kube-proxy"]
summary: "从源码层面深入分析 kube-proxy 的整体架构、启动流程和核心设计思想"
---

# 深入理解 kube-proxy(1) - 整体架构与启动流程

---

## 1. 概述

kube-proxy 是 Kubernetes 集群中运行在每个节点上的网络代理,它负责实现 Service 的负载均衡和网络代理功能。

### 1.1 在 Kubernetes 中的位置

```
┌─────────────────────────────────────────────────────────────┐
│                    Kubernetes 集群架构                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌────────────┐                                             │
│  │ API Server │                                             │
│  └─────┬──────┘                                             │
│        │                                                    │
│        │ watch Services/Endpoints/Nodes                     │
│        ▼                                                    │
│  ┌─────────────────────────────────────────────┐            │
│  │             每个 Node                       │            │
│  │  ┌──────────────────────────────────────┐   │            │
│  │  │         kube-proxy                   │   │            │
│  │  │  - 监听 Service/Endpoint 变化         │   │            │
│  │  │  - 更新代理规则(iptables/ipvs)        │   │            │
│  │  │  - 实现负载均衡                       │   │            │
│  │  └──────────────────────────────────────┘   │            │
│  │                                             │            │
│  │  ┌──────────┐      ┌──────────────┐         │            │
│  │  │ iptables │      │     IPVS     │         │            │
│  │  │   规则    │      │    虚拟服务器 │         │            │
│  │  └──────────┘      └──────────────┘         │            │
│  └─────────────────────────────────────────────┘            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 核心功能

1. **Service 发现**: 监听 API Server 的 Service 和 Endpoint 变化
2. **负载均衡**: 实现四层(TCP/UDP/SCTP)负载均衡
3. **代理规则**: 维护 iptables 或 IPVS 规则
4. **健康检查**: 支持服务的健康检查
5. **会话亲和**: 支持 ClientIP 会话保持

---

## 2. 核心职责与工作原理

### 2.1 Service 流量代理流程

```
Client Pod
    │
    │ 请求: Service ClusterIP:Port
    ▼
Service ClusterIP (虚拟IP)
    │
    ▼
┌─────────────────────┐
│  kube-proxy规则      │
│  (iptables/ipvs)    │
└──────────┬──────────┘
           │
           ├─▶ Pod1 (Backend 1)
           │
           ├─▶ Pod2 (Backend 2)
           │
           └─▶ Pod3 (Backend 3)
```

### 2.2 三种代理模式对比

| 特性              | userspace    | iptables     | ipvs         |
|-----------------|--------------|--------------|--------------|
| **性能**          | 低(用户态)       | 中            | 高            |
| **复杂度**         | 简单           | 中            | 复杂           |
| **支持协议**        | TCP/UDP/SCTP | TCP/UDP/SCTP | TCP/UDP/SCTP |
| **负载均衡算法**      | RoundRobin   | 随机           | 多种           |
| **会话亲和**        | 支持           | 支持           | 支持           |
| **状态**          | 已废弃          | 默认(Linux)    | 推荐高性能        |
| **iptables规则数** | 少            | 多(线性增长)      | 少            |

> **注意**: iptables 和 IPVS 模式的详细实现原理将在后续文章中深入解析。

---

## 3. 整体架构设计

### 3.1 架构图

```
┌────────────────────────────────────┐
│  API Server                        │
│  Watch/List Service/Endpoint/Node  │  
└──────┬─────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│              SharedInformerFactory                           │
│  ┌──────────────────┬───────────────────┬─────────────────┐  │
│  │ ServiceInformer  │ EndpointsInformer │ NodeInformer    │  │
│  └────────┬─────────┴────────┬──────────┴───────┬─────────┘  │
│           ▼                  ▼                  ▼            │
│  ┌──────────────────┬───────────────────┬─────────────────┐  │
│  │  ServiceConfig   │ EndpointsConfig   │ NodeConfig      │  │
│  │──────────────────┴───────────────────┴─────────────────│  │
│  │  - 注册 EventHandler (即 Proxier)                       │  │
│  │  - 维护变更队列 (serviceChanges/endpointsChanges)        │  │
│  └────────────────────────┬───────────────────────────────┘  │
└───────────────────────────│──────────────────────────────────┘
                            │ 调用 EventHandler 方法
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                    Provider Interface                        │
│                    (Proxier 实现)                            │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ EventHandler 方法 (由 Config 调用):                     │  │
│  │  - OnNodeAdd(node)            ─┐                       │  │
│  │  - OnNodeUpdate(old, new)      │ 检查 node CIRDs       │  │
│  │  - OnNodeDelete(node)         ─┘                       │  │
│  │  - OnServiceAdd(service)       │                       │  │
│  │  - OnServiceUpdate(old, new)   │ 更新 serviceChanges   │  │
│  │  - OnServiceDelete(service)   ─┘                       │  │
│  │  - OnEndpointsAdd(ep)          │                       │  │
│  │  - OnEndpointsUpdate(old, new) │ 更新 endpointsChanges │  │
│  │  - OnEndpointsDelete(ep)      ─┘                       │  │
│  │                                                        │  │
│  │  同步方法:                                              │  │
│  │  - SyncLoop()  ←─ 由 BoundedFrequencyRunner 调用        │  │
│  └────────────────────────┬───────────────────────────────┘  │
└───────────────────────────│──────────────────────────────────┘
                            │ 触发同步
                            ▼
┌──────────────────────────────────────────────────────────────┐
│              BoundedFrequencyRunner (syncRunner)             │
│  - 控制同步频率: minSyncPeriod (1s) ~ syncPeriod (30s)        │
│  - 调用 syncProxyRules()                                     │
└───────────────────────────┬──────────────────────────────────┘
                            │ 执行同步
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                    syncProxyRules()                          │
│  1. 更新 serviceMap ← serviceChanges                         │
│  2. 更新 endpointsMap ← endpointsChanges                     │
│  3. 生成 iptables/IPVS 规则                                   │
│  4. 应用规则到内核                                             │
└───────────────────────────┬──────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                    Proxier Implementation                    │
│  ┌────────────────────┐  ┌────────────────────┐              │
│  │  iptables Proxier  │  │   IPVS Proxier     │              │
│  │  - serviceMap      │  │  - serviceMap      │              │
│  │  - endpointsMap    │  │  - endpointsMap    │              │
│  │  - iptables 接口    │  │  - ipvs 接口       │              │
│  └─────────┬──────────┘  └─────────┬──────────┘              │
└────────────┼──────────────────────┼──────────────────────────┘
             │                      │
             ▼                      ▼
┌────────────────────┐    ┌─────────────────┐
│   iptables (内核)  │    │  IPVS (内核)     │
│   netfilter 框架   │    │  netlink 接口    │
└────────────────────┘    └─────────────────┘


事件流向关键步骤:
────────────────────────────────────────────────────────────────────

1️⃣ API Server 对象变化
   ↓
2️⃣ SharedInformerFactory 监听到变化
   ↓
3️⃣ ServiceConfig/EndpointsConfig 接收事件
   ↓
4️⃣ 调用 Proxier 的 EventHandler 方法
   │
   ├─ OnServiceAdd/Update/Delete(service)
   │  └─▶ 更新 serviceChanges 队列
   │
   └─ OnEndpointsAdd/Update/Delete(endpoints)
      └─▶ 更新 endpointsChanges 队列
   ↓
5️⃣ 触发 syncRunner.Run()
   ↓
6️⃣ BoundedFrequencyRunner 控制频率后调用 syncProxyRules()
   ↓
7️⃣ syncProxyRules() 执行:
   │
   ├─ serviceMap.Update(serviceChanges)
   ├─ endpointsMap.Update(endpointsChanges)
   ├─ 生成 iptables/IPVS 规则
   └─ 应用规则到内核
```

### 3.2 核心组件

1. **ProxyServer**: 主服务器,负责启动和管理
2. **Provider Interface**: 代理器接口,定义代理行为
3. **Proxier Implementation**: 具体实现(iptables/ipvs)
4. **Informer**: 监听 API Server 变化
5. **Config Handler**: 配置文件热加载

---

## 4. ProxyServer 结构体

**位置**: `cmd/kube-proxy/app/server.go:535-558`

```go
type ProxyServer struct {
    // Kubernetes 客户端
    Client                 clientset.Interface
    EventClient            v1core.EventsGetter

    // 网络接口
	execer                 exec.Interface
    IptInterface           utiliptables.Interface  // iptables 接口
    IpvsInterface          utilipvs.Interface      // IPVS 接口
    IpsetInterface         utilipset.Interface     // ipset 接口

    // 核心代理器
    Proxier                proxy.Provider

    // 事件记录
	Recorder               events.EventRecorder
    Broadcaster            events.EventBroadcaster

    // 连接跟踪配置
	Conntracker            Conntracker
    ConntrackConfiguration kubeproxyconfig.KubeProxyConntrackConfiguration

    // 配置
    ProxyMode              string  // 代理模式: userspace/iptables/ipvs
    NodeRef                *v1.ObjectReference
    MetricsBindAddress     string
    BindAddressHardFail    bool
    EnableProfiling        bool
    UseEndpointSlices      bool
    OOMScoreAdj            *int32
    ConfigSyncPeriod       time.Duration
    HealthzServer          healthcheck.ProxierHealthUpdater
    localDetectorMode      kubeproxyconfig.LocalMode
    podCIDRs               []string
}
```

**设计要点**:

1. **接口抽象**: 通过接口抽象 iptables/IPVS,便于测试和扩展
2. **事件驱动**: 使用 Broadcaster 和 Recorder 记录事件
3. **灵活配置**: 支持多种配置方式(配置文件、命令行参数)
4. **健康检查**: 内置健康检查服务

---

## 5. 启动流程详解

### 5.1 整体流程图

```
main()
  │
  └─▶ NewProxyCommand()
       │
       ├─▶ opts.Complete()
       │    ├─▶ 加载配置文件
       │    ├─▶ 初始化文件监听器
       │    ├─▶ 处理 hostname 覆盖
       │    └─▶ 设置 Feature Gates
       │
       ├─▶ opts.Validate()
       │    └─▶ 验证配置
       │
       └─▶ opts.Run()
            │
            ├─▶ NewProxyServer(o)
            │    │
            │    ├─▶ 检测 IPVS 支持
            │    ├─▶ 创建 Kubernetes 客户端
            │    ├─▶ 检测节点 IP
            │    ├─▶ 创建事件广播器和记录器
            │    ├─▶ 创建健康检查服务器
            │    ├─▶ 确定代理模式 (iptables/IPVS/userspace)
            │    ├─▶ 创建 Proxier 实现
            │    │    ├─▶ iptables.NewProxier() 或
            │    │    ├─▶ ipvs.NewProxier() 或
            │    │    └─▶ userspace.NewProxier()
            │    └─▶ 返回 ProxyServer 实例
            │
            └─▶ o.runLoop()
                 │
                 └─▶ s.Run()
                      │
                      ├─▶ 设置 OOM Score Adj
                      ├─▶ 启动事件广播器
                      ├─▶ 启动健康检查服务
                      ├─▶ 启动 Metrics 服务
                      ├─▶ 配置 conntrack
                      ├─▶ 创建 Informer 工厂
                      ├─▶ 创建 Service 配置 (ServiceConfig)
                      ├─▶ 创建 Endpoints 配置 (EndpointsConfig 或 EndpointSliceConfig)
                      ├─▶ 创建 Node 配置 (NodeConfig)
                      ├─▶ 注册事件处理器到 Proxier
                      ├─▶ 启动所有 Informer
                      └─▶ 启动 Proxier.SyncLoop()
```

### 5.2 详细启动步骤

#### 5.2.1 命令初始化 - NewProxyCommand()

**位置**: `cmd/kube-proxy/app/server.go:471-537`

```go
func NewProxyCommand() *cobra.Command {
    opts := NewOptions()

    cmd := &cobra.Command{
        Use: "kube-proxy",
        RunE: func(cmd *cobra.Command, args []string) error {
            // 步骤 1: 完成配置 (加载配置文件等)
            if err := opts.Complete(); err != nil {
                return fmt.Errorf("failed complete: %w", err)
            }

            // 步骤 2: 验证配置
            if err := opts.Validate(); err != nil {
                return fmt.Errorf("failed validate: %w", err)
            }

            // 步骤 3: 运行 kube-proxy
            if err := opts.Run(); err != nil {
                return err
            }

            return nil
        },
    }

    // 应用默认配置
    opts.config, err = opts.ApplyDefaults(opts.config)

    return cmd
}
```

#### 5.2.2 配置完成 - opts.Complete()

**位置**: `cmd/kube-proxy/app/server.go:228-253`

```go
func (o *Options) Complete() error {
    // 1. 如果使用旧的命令行参数,转换为配置文件格式
    if len(o.ConfigFile) == 0 && len(o.WriteConfigTo) == 0 {
        o.config.HealthzBindAddress = addressFromDeprecatedFlags(...)
        o.config.MetricsBindAddress = addressFromDeprecatedFlags(...)
    }

    // 2. 加载配置文件
    if len(o.ConfigFile) > 0 {
        c, err := o.loadConfigFromFile(o.ConfigFile)
        if err != nil {
            return err
        }
        o.config = c

        // 3. 初始化文件监听器 (用于热重载)
        if err := o.initWatcher(); err != nil {
            return err
        }
    }

    // 4. 处理 hostname 覆盖
    if err := o.processHostnameOverrideFlag(); err != nil {
        return err
    }

    // 5. 设置 Feature Gates
    return utilfeature.DefaultMutableFeatureGate.SetFromMap(o.config.FeatureGates)
}
```

#### 5.2.3 创建 ProxyServer - NewProxyServer()

**位置**: `cmd/kube-proxy/app/server_others.go:76-395`

```go
func NewProxyServer(o *Options) (*ProxyServer, error) {
    return newProxyServer(o.config, o.CleanupAndExit, o.master)
}

func newProxyServer(
    config *proxyconfigapi.KubeProxyConfiguration,
    cleanupAndExit bool,
    master string) (*ProxyServer, error) {

    // ===== 步骤 1: 初始化网络接口 =====
    execer := exec.New()
    kernelHandler := ipvs.NewLinuxKernelHandler()
    ipsetInterface := utilipset.New(execer)

    // 检测是否可以使用 IPVS
    canUseIPVS, err := ipvs.CanUseIPVSProxier(kernelHandler, ipsetInterface, config.IPVS.Scheduler)

    var ipvsInterface utilipvs.Interface
    if canUseIPVS {
        ipvsInterface = utilipvs.New()
    }

    // ===== 步骤 2: 创建 Kubernetes 客户端 =====
    client, eventClient, err := createClients(config.ClientConnection, master)
    if err != nil {
        return nil, err
    }

    // ===== 步骤 3: 检测节点 IP =====
    hostname, err := utilnode.GetHostname(config.HostnameOverride)
    if err != nil {
        return nil, err
    }

    nodeIP := detectNodeIP(client, hostname, config.BindAddress)
    klog.InfoS("Detected node IP", "address", nodeIP.String())

    // ===== 步骤 4: 创建事件广播器和记录器 =====
    eventBroadcaster := events.NewBroadcaster(&events.EventSinkImpl{Interface: client.EventsV1()})
    recorder := eventBroadcaster.NewRecorder(scheme.Scheme, "kube-proxy")

    nodeRef := &v1.ObjectReference{
        Kind:      "Node",
        Name:      hostname,
        UID:       types.UID(hostname),
        Namespace: "",
    }

    // ===== 步骤 5: 创建健康检查服务器 =====
    var healthzServer healthcheck.ProxierHealthUpdater
    if len(config.HealthzBindAddress) > 0 {
        healthzServer = healthcheck.NewProxierHealthServer(
            config.HealthzBindAddress,
            2*config.IPTables.SyncPeriod.Duration,
            recorder,
            nodeRef,
        )
    }

    // ===== 步骤 6: 确定代理模式 =====
    proxyMode := getProxyMode(string(config.Mode), canUseIPVS, iptables.LinuxKernelCompatTester{})
    detectLocalMode, err := getDetectLocalMode(config)
    if err != nil {
        return nil, fmt.Errorf("cannot determine detect-local-mode: %v", err)
    }

    // 如果使用 LocalModeNodeCIDR,需要等待 Pod CIDR 分配
    var nodeInfo *v1.Node
    podCIDRs := []string{}
    if detectLocalMode == proxyconfigapi.LocalModeNodeCIDR {
        nodeInfo, err = waitForPodCIDR(client, hostname)
        if err != nil {
            return nil, err
        }
        podCIDRs = nodeInfo.Spec.PodCIDRs
    }

    // ===== 步骤 7: 创建 iptables 接口 =====
    primaryProtocol := utiliptables.ProtocolIPv4
    if netutils.IsIPv6(nodeIP) {
        primaryProtocol = utiliptables.ProtocolIPv6
    }
    iptInterface := utiliptables.New(execer, primaryProtocol)

    // 检查是否支持双栈
    var ipt [2]utiliptables.Interface
    dualStack := true
    if proxyMode != proxyModeUserspace {
        // 创建 IPv4 和 IPv6 的 iptables 接口
        if primaryProtocol == utiliptables.ProtocolIPv4 {
            ipt[0] = iptInterface
            ipt[1] = utiliptables.New(execer, utiliptables.ProtocolIPv6)
        } else {
            ipt[0] = utiliptables.New(execer, utiliptables.ProtocolIPv4)
            ipt[1] = iptInterface
        }

        // 检查两个协议族是否都支持
        for _, perFamilyIpt := range ipt {
            if !perFamilyIpt.Present() {
                dualStack = false
            }
        }
    }

    // ===== 步骤 8: 创建 Proxier 实现 =====
    var proxier proxy.Provider

    if proxyMode == proxyModeIPTables {
        klog.V(0).InfoS("Using iptables Proxier")

        if dualStack {
            klog.V(0).InfoS("Creating dualStackProxier for iptables")
            var localDetectors [2]proxyutiliptables.LocalTrafficDetector
            localDetectors, err = getDualStackLocalDetectorTuple(detectLocalMode, config, ipt, nodeInfo)
            if err != nil {
                return nil, fmt.Errorf("unable to create proxier: %v", err)
            }

            proxier, err = iptables.NewDualStackProxier(
                ipt,
                utilsysctl.New(),
                execer,
                config.IPTables.SyncPeriod.Duration,
                config.IPTables.MinSyncPeriod.Duration,
                config.IPTables.MasqueradeAll,
                int(*config.IPTables.MasqueradeBit),
                localDetectors,
                hostname,
                nodeIPTuple(config.BindAddress),
                recorder,
                healthzServer,
                config.NodePortAddresses,
            )
        } else {
            // 单栈模式
            var localDetector proxyutiliptables.LocalTrafficDetector
            localDetector, err = getLocalDetector(detectLocalMode, config, iptInterface, nodeInfo)
            if err != nil {
                return nil, fmt.Errorf("unable to create proxier: %v", err)
            }

            proxier, err = iptables.NewProxier(
                iptInterface,
                utilsysctl.New(),
                execer,
                config.IPTables.SyncPeriod.Duration,
                config.IPTables.MinSyncPeriod.Duration,
                config.IPTables.MasqueradeAll,
                int(*config.IPTables.MasqueradeBit),
                localDetector,
                hostname,
                nodeIP,
                recorder,
                healthzServer,
                config.NodePortAddresses,
            )
        }

        if err != nil {
            return nil, fmt.Errorf("unable to create proxier: %v", err)
        }
        proxymetrics.RegisterMetrics()

    } else if proxyMode == proxyModeIPVS {
        klog.V(0).InfoS("Using ipvs Proxier")

        if dualStack {
            klog.V(0).InfoS("Creating dualStackProxier for ipvs")
            nodeIPs := nodeIPTuple(config.BindAddress)

            var localDetectors [2]proxyutiliptables.LocalTrafficDetector
            localDetectors, err = getDualStackLocalDetectorTuple(detectLocalMode, config, ipt, nodeInfo)
            if err != nil {
                return nil, fmt.Errorf("unable to create proxier: %v", err)
            }

            proxier, err = ipvs.NewDualStackProxier(
                ipt,
                ipvsInterface,
                ipsetInterface,
                utilsysctl.New(),
                execer,
                config.IPVS.SyncPeriod.Duration,
                config.IPVS.MinSyncPeriod.Duration,
                config.IPVS.ExcludeCIDRs,
                config.IPVS.StrictARP,
                config.IPVS.TCPTimeout.Duration,
                config.IPVS.TCPFinTimeout.Duration,
                config.IPVS.UDPTimeout.Duration,
                config.IPTables.MasqueradeAll,
                int(*config.IPTables.MasqueradeBit),
                localDetectors,
                hostname,
                nodeIPs,
                recorder,
                healthzServer,
                config.IPVS.Scheduler,
                config.NodePortAddresses,
                kernelHandler,
            )
        } else {
            var localDetector proxyutiliptables.LocalTrafficDetector
            localDetector, err = getLocalDetector(detectLocalMode, config, iptInterface, nodeInfo)
            if err != nil {
                return nil, fmt.Errorf("unable to create proxier: %v", err)
            }

            proxier, err = ipvs.NewProxier(
                iptInterface,
                ipvsInterface,
                ipsetInterface,
                utilsysctl.New(),
                execer,
                config.IPVS.SyncPeriod.Duration,
                config.IPVS.MinSyncPeriod.Duration,
                config.IPVS.ExcludeCIDRs,
                config.IPVS.StrictARP,
                config.IPVS.TCPTimeout.Duration,
                config.IPVS.TCPFinTimeout.Duration,
                config.IPVS.UDPTimeout.Duration,
                config.IPTables.MasqueradeAll,
                int(*config.IPTables.MasqueradeBit),
                localDetector,
                hostname,
                nodeIP,
                recorder,
                healthzServer,
                config.IPVS.Scheduler,
                config.NodePortAddresses,
                kernelHandler,
            )
        }
        if err != nil {
            return nil, fmt.Errorf("unable to create proxier: %v", err)
        }
        proxymetrics.RegisterMetrics()

    } else {
        // userspace 模式 (已废弃)
        klog.V(0).InfoS("Using userspace Proxier")
        klog.V(0).InfoS("The userspace proxier is now deprecated and will be removed in a future release")

        proxier, err = userspace.NewProxier(
            userspace.NewLoadBalancerRR(),
            netutils.ParseIPSloppy(config.BindAddress),
            iptInterface,
            execer,
            *utilnet.ParsePortRangeOrDie(config.PortRange),
            config.IPTables.SyncPeriod.Duration,
            config.IPTables.MinSyncPeriod.Duration,
            config.UDPIdleTimeout.Duration,
            config.NodePortAddresses,
        )
        if err != nil {
            return nil, fmt.Errorf("unable to create proxier: %v", err)
        }
    }

    // ===== 步骤 9: 创建 ProxyServer 实例 =====
    useEndpointSlices := true
    if proxyMode == proxyModeUserspace {
        useEndpointSlices = false
    }

    return &ProxyServer{
        Client:                 client,
        EventClient:            eventClient,
        IptInterface:           iptInterface,
        IpvsInterface:          ipvsInterface,
        IpsetInterface:         ipsetInterface,
        execer:                 execer,
        Proxier:                proxier,
        Broadcaster:            eventBroadcaster,
        Recorder:               recorder,
        ConntrackConfiguration: config.Conntrack,
        Conntracker:            &realConntracker{},
        ProxyMode:              proxyMode,
        NodeRef:                nodeRef,
        MetricsBindAddress:     config.MetricsBindAddress,
        BindAddressHardFail:    config.BindAddressHardFail,
        EnableProfiling:        config.EnableProfiling,
        OOMScoreAdj:            config.OOMScoreAdj,
        ConfigSyncPeriod:       config.ConfigSyncPeriod.Duration,
        HealthzServer:          healthzServer,
        UseEndpointSlices:      useEndpointSlices,
        localDetectorMode:      detectLocalMode,
        podCIDRs:               podCIDRs,
    }, nil
}
```

#### 5.2.4 运行 ProxyServer - s.Run()

**位置**: `cmd/kube-proxy/app/server.go:660-799`

```go
func (s *ProxyServer) Run() error {
    // ===== 步骤 1: 日志版本信息 =====
    klog.InfoS("Version info", "version", version.Get())
    klog.InfoS("Golang settings", "GOGC", os.Getenv("GOGC"), ...)

    // ===== 步骤 2: 设置 OOM Score Adj =====
    var oomAdjuster *oom.OOMAdjuster
    if s.OOMScoreAdj != nil {
        oomAdjuster = oom.NewOOMAdjuster()
        if err := oomAdjuster.ApplyOOMScoreAdj(0, int(*s.OOMScoreAdj)); err != nil {
            klog.V(2).InfoS("Failed to apply OOMScore", "err", err)
        }
    }

    // ===== 步骤 3: 启动事件广播器 =====
    if s.Broadcaster != nil && s.EventClient != nil {
        stopCh := make(chan struct{})
        s.Broadcaster.StartRecordingToSink(stopCh)
    }

    // ===== 步骤 4: 启动健康检查服务 =====
    serveHealthz(s.HealthzServer, errCh)

    // ===== 步骤 5: 启动 Metrics 服务 =====
    serveMetrics(s.MetricsBindAddress, s.ProxyMode, s.EnableProfiling, errCh)

    // ===== 步骤 6: 配置 conntrack =====
    if s.Conntracker != nil {
        max, err := getConntrackMax(s.ConntrackConfiguration)
        if max > 0 {
            s.Conntracker.SetMax(max)
        }

        if s.ConntrackConfiguration.TCPEstablishedTimeout != nil {
            timeout := int(s.ConntrackConfiguration.TCPEstablishedTimeout.Duration / time.Second)
            s.Conntracker.SetTCPEstablishedTimeout(timeout)
        }

        if s.ConntrackConfiguration.TCPCloseWaitTimeout != nil {
            timeout := int(s.ConntrackConfiguration.TCPCloseWaitTimeout.Duration / time.Second)
            s.Conntracker.SetTCPCloseWaitTimeout(timeout)
        }
    }

    // ===== 步骤 7: 创建 Informer 工厂 =====
    // 过滤掉不需要代理的服务
    noProxyName, err := labels.NewRequirement(apis.LabelServiceProxyName, selection.DoesNotExist, nil)
    noHeadlessEndpoints, err := labels.NewRequirement(v1.IsHeadlessService, selection.DoesNotExist, nil)

    labelSelector := labels.NewSelector()
    labelSelector = labelSelector.Add(*noProxyName, *noHeadlessEndpoints)

    informerFactory := informers.NewSharedInformerFactoryWithOptions(
        s.Client,
        s.ConfigSyncPeriod,
        informers.WithTweakListOptions(func(options *metav1.ListOptions) {
            options.LabelSelector = labelSelector.String()
        }),
    )

    // ===== 步骤 8: 创建 Service 配置 =====
    serviceConfig := config.NewServiceConfig(informerFactory.Core().V1().Services(), s.ConfigSyncPeriod)
    serviceConfig.RegisterEventHandler(s.Proxier)
    go serviceConfig.Run(wait.NeverStop)

    // ===== 步骤 9: 创建 Endpoints 配置 =====
    if endpointsHandler, ok := s.Proxier.(config.EndpointsHandler); ok && !s.UseEndpointSlices {
        // 使用旧的 Endpoints API
        endpointsConfig := config.NewEndpointsConfig(informerFactory.Core().V1().Endpoints(), s.ConfigSyncPeriod)
        endpointsConfig.RegisterEventHandler(endpointsHandler)
        go endpointsConfig.Run(wait.NeverStop)
    } else {
        // 使用新的 EndpointSlices API
        endpointSliceConfig := config.NewEndpointSliceConfig(informerFactory.Discovery().V1().EndpointSlices(), s.ConfigSyncPeriod)
        endpointSliceConfig.RegisterEventHandler(s.Proxier)
        go endpointSliceConfig.Run(wait.NeverStop)
    }

    // ===== 步骤 10: 启动 Service/Endpoints Informer =====
    informerFactory.Start(wait.NeverStop)

    // ===== 步骤 11: 创建 Node 配置 =====
    currentNodeInformerFactory := informers.NewSharedInformerFactoryWithOptions(
        s.Client,
        s.ConfigSyncPeriod,
        informers.WithTweakListOptions(func(options *metav1.ListOptions) {
            options.FieldSelector = fields.OneTermEqualSelector("metadata.name", s.NodeRef.Name).String()
        }),
    )

    nodeConfig := config.NewNodeConfig(currentNodeInformerFactory.Core().V1().Nodes(), s.ConfigSyncPeriod)

    // 如果使用 LocalModeNodeCIDR,注册 PodCIDR 变更处理器
    if s.localDetectorMode == kubeproxyconfig.LocalModeNodeCIDR {
        nodeConfig.RegisterEventHandler(proxy.NewNodePodCIDRHandler(s.podCIDRs))
    }

    nodeConfig.RegisterEventHandler(s.Proxier)
    go nodeConfig.Run(wait.NeverStop)

    // ===== 步骤 12: 启动 Node Informer =====
    currentNodeInformerFactory.Start(wait.NeverStop)

    // ===== 步骤 13: 发送启动事件 =====
    s.birthCry()

    // ===== 步骤 14: 启动 Proxier SyncLoop =====
    go s.Proxier.SyncLoop()

    // ===== 步骤 15: 等待错误 =====
    return <-errCh
}
```

### 5.3 关键流程说明

#### 5.3.1 Informer 机制

kube-proxy 使用 Kubernetes 的 Informer 机制来监听 API Server 的变化:

```
┌─────────────────────────────────────────────────────────────┐
│                  Informer 事件处理流程                        │
└─────────────────────────────────────────────────────────────┘

API Server
    │
    │ Service/Endpoint/Node 变化
    ▼
Informer (SharedInformerFactory)
    │
    │ 事件通知
    ▼
EventHandler (Provider Interface)
    │
    ├─▶ OnServiceAdd/Update/Delete
    ├─▶ OnEndpointsAdd/Update/Delete 或
    ├─▶ OnEndpointSliceAdd/Update/Delete
    └─▶ OnNodeAdd/Update/Delete
    │
    ▼
更新内部状态 (serviceMap/endpointsMap)
    │
    ▼
SyncLoop()
    │
    ├─▶ 周期性同步 (默认 30s)
    └─▶ 增量同步 (最小 1s)
    │
    ▼
应用规则到 iptables/IPVS
```

#### 5.3.2 双栈支持

从 Kubernetes 1.16 开始,kube-proxy 支持双栈(IPv4 + IPv6):

```go
// 创建 IPv4 和 IPv6 的 iptables 接口
var ipt [2]utiliptables.Interface
dualStack := true

if primaryProtocol == utiliptables.ProtocolIPv4 {
    ipt[0] = utiliptables.New(execer, utiliptables.ProtocolIPv4)
    ipt[1] = utiliptables.New(execer, utiliptables.ProtocolIPv6)
} else {
    ipt[0] = utiliptables.New(execer, utiliptables.ProtocolIPv4)
    ipt[1] = utiliptables.New(execer, utiliptables.ProtocolIPv6)
}

// 检查两个协议族是否都支持
for _, perFamilyIpt := range ipt {
    if !perFamilyIpt.Present() {
        dualStack = false
    }
}

// 如果支持双栈,创建 DualStackProxier
if dualStack {
    proxier, err = iptables.NewDualStackProxier(
        ipt,
        // ...
    )
}
```

---

## 6. 代理模式对比

### 6.1 iptables 模式

**核心思想**: 使用 Linux iptables/netfilter 实现负载均衡

**工作原理概述**:

```
Service: nginx (ClusterIP: 10.96.0.10, Port: 80)
Endpoints:
  - 10.244.1.2:8080
  - 10.244.2.3:8080
  - 10.244.3.4:8080

iptables 规则链示例:
─────────────────────────────────────────────────────────────
PREROUTING 链:
  -j KUBE-SERVICES

KUBE-SERVICES 链:
  dst 10.96.0.10 -p tcp --dport 80
  -j KUBE-SVC-NLN46L3FJN6H4P6Q

KUBE-SVC-NLN46L3FJN6H4P6Q 链:
  -m statistic --mode random
  -j KUBE-SEP-XXXX1 (33.3%)
  -j KUBE-SEP-XXXX2 (33.3%)
  -j KUBE-SEP-XXXX3 (33.3%)

KUBE-SEP-XXXX1 链:
  -j DNAT --to-destination 10.244.1.2:8080
```

**优缺点**:

✅ **优点**:
- 内核态处理,性能较好
- 稳定成熟
- 无需用户态进程

❌ **缺点**:
- 规则数量随服务数量线性增长
- 大量服务时性能下降
- 只支持随机负载均衡

> **详细解析**: iptables 模式的深度实现原理将在《深入理解 kube-proxy(2) - iptables 模式详解》中详细介绍。

### 6.2 IPVS 模式

**核心思想**: 使用 Linux IPVS (IP Virtual Server) 实现高性能负载均衡

**工作原理概述**:

```
Service: nginx (ClusterIP: 10.96.0.10, Port: 80)
Endpoints:
  - 10.244.1.2:8080
  - 10.244.2.3:8080
  - 10.244.3.4:8080

IPVS 配置示例:
─────────────────────────────────────────────────────────────
IP Virtual Server: 10.96.0.10:80
  Protocol: TCP
  Scheduler: rr (round robin)
  Flags:
  - Real Server: 10.244.1.2:8080 (Weight: 1)
  - Real Server: 10.244.2.3:8080 (Weight: 1)
  - Real Server: 10.244.3.4:8080 (Weight: 1)
```

**IPVS vs iptables**:

```
iptables 模式:
  Client → iptables规则1 → iptables规则2 → ... → iptables规则N → Backend
  (每条规则都要遍历,性能随规则数下降)

IPVS 模式:
  Client → IPVS表(哈希查找) → Backend
  (一次哈希查找,性能恒定)
```

**支持的调度算法**:

- rr: Round Robin (轮询)
- lc: Least Connection (最少连接)
- dh: Destination Hash (目标地址哈希)
- sh: Source Hash (源地址哈希)
- nq: Never Queue (永不排队)

**优缺点**:

✅ **优点**:
- 高性能(哈希表查找)
- 支持多种负载均衡算法
- 规则数量少,易于管理
- 支持连接复用

❌ **缺点**:
- 依赖 IPVS 内核模块
- 配置相对复杂
- 旧内核可能不支持

> **详细解析**: IPVS 模式的深度实现原理将在《深入理解 kube-proxy(3) - IPVS 模式详解》中详细介绍。

### 6.3 userspace 模式 (已废弃)

**核心思想**: 在用户空间实现代理逻辑

**工作原理**:

```
用户空间代理流程:
─────────────────────────────────────────────────────────────
1. kube-proxy 监听在某个端口(如 10001)
2. Client 连接到 ClusterIP:80
3. iptables 规则将流量重定向到 kube-proxy:10001
4. kube-proxy 选择后端,建立连接
5. 在 Client 和 Backend 之间转发数据
```

**缺点**:
- 用户态和内核态切换开销大
- 性能差
- 已废弃,仅用于向后兼容

---

## 7. 核心接口设计

### 7.1 Provider 接口

**位置**: `pkg/proxy/types.go:30-41`

```go
// Provider 是代理器实现的接口
type Provider interface {
    config.EndpointSliceHandler
    config.ServiceHandler
    config.NodeHandler

    // Sync 立即同步当前状态到代理规则
    Sync()

    // SyncLoop 运行周期性任务
    // 作为 goroutine 或主循环运行,永不返回
    SyncLoop()
}
```

**接口方法详解**:

```go
// ServiceHandler - Service 变化处理
OnServiceAdd(service *v1.Service)
OnServiceUpdate(oldService, newService *v1.Service)
OnServiceDelete(service *v1.Service)

// EndpointSliceHandler - EndpointSlice 变化处理
OnEndpointSliceAdd(endpointSlice *discovery.EndpointSlice)
OnEndpointSliceUpdate(oldSlice, newSlice *discovery.EndpointSlice)
OnEndpointSliceDelete(endpointSlice *discovery.EndpointSlice)

// NodeHandler - Node 变化处理
OnNodeAdd(node *v1.Node)
OnNodeUpdate(oldNode, newNode *v1.Node)
OnNodeDelete(node *v1.Node)
```

**设计要点**:
- 统一的接口抽象,支持多种代理模式
- 事件驱动架构,通过 Informer 接收变化通知
- 支持立即同步(Sync)和周期性同步(SyncLoop)

### 7.2 ServicePort 接口

**位置**: `pkg/proxy/types.go:63-103`

```go
type ServicePort interface {
    String() string
    ClusterIP() net.IP
    Port() int
    Protocol() v1.Protocol
    SessionAffinityType() v1.ServiceAffinity
    StickyMaxAgeSeconds() int
    ExternalIPStrings() []string
    LoadBalancerIPStrings() []string
    HealthCheckNodePort() int
    NodePort() int
    ExternalPolicyLocal() bool
    InternalPolicyLocal() bool
    ExternalPolicyLocal() bool
    HintsAnnotation() string
    ExternallyAccessible() bool
    UsesClusterEndpoints() bool
    UsesLocalEndpoints() bool
}
```

**设计要点**:
- 接口抽象,便于测试和 Mock
- 覆盖 Service 的所有配置
- 支持多种 Service 类型(ClusterIP/NodePort/LoadBalancer)

### 7.3 Endpoint 接口

**位置**: `pkg/proxy/types.go:107-147`

```go
type Endpoint interface {
    String() string
    GetIsLocal() bool
    IsReady() bool
    IsServing() bool
    IsTerminating() bool
    GetZoneHints() sets.String
    IP() string
    Port() (int, error)
    Equal(Endpoint) bool
    GetNodeName() string
    GetZone() string
}
```

**设计要点**:
- 区分 ready/serving/terminating 状态
- 支持拓扑感知路由(Topology Aware Hints)
- 支持节点和区域信息

### 7.4 事件处理流程

```
┌─────────────────────────────────────────────────────────────┐
│                  Informer 事件处理流程                         │
└─────────────────────────────────────────────────────────────┘

API Server
    │
    │ Service/Endpoint/Node 变化
    ▼
SharedInformerFactory
    │
    │ ListWatch
    ▼
Informer (Delta FIFO Queue)
    │
    │ Pop 事件
    ▼
EventHandler (Provider Interface)
    │
    ├─▶ OnServiceAdd/Update/Delete
    ├─▶ OnEndpointsAdd/Update/Delete
    ├─▶ OnEndpointSliceAdd/Update/Delete
    └─▶ OnNodeAdd/Update/Delete
    │
    ▼
更新内部状态 (serviceMap/endpointsMap)
    │
    ▼
触发同步 (通过 BoundedFrequencyRunner)
    │
    ▼
SyncLoop() / syncProxyRules()
    │
    ├─▶ 周期性全量同步 (默认 30s)
    └─▶ 事件驱动增量同步 (最小 1s)
    │
    ▼
应用规则到 iptables/IPVS
```

**同步机制**:

kube-proxy 使用 `BoundedFrequencyRunner` 来控制同步频率:

```go
// BoundedFrequencyRunner 确保同步操作的频率在合理范围内
//
// - 最小同步周期 (MinSyncPeriod): 1s
// - 最大同步周期 (SyncPeriod): 30s
//
// 工作方式:
// 1. 有事件时,等待 MinSyncPeriod 后执行同步
// 2. 无事件时,每个 SyncPeriod 执行一次全量同步
// 3. 避免频繁同步导致的性能问题
```

---

## 8. 总结

### 8.1 核心设计思想

1. **接口抽象**: Provider 接口统一不同代理模式
2. **事件驱动**: Informer 机制监听 API 变化
3. **双阶段同步**: 周期性全量同步 + 事件驱动增量同步
4. **性能优化**: IPVS 模式提供高性能负载均衡
5. **灵活性**: 支持多种负载均衡算法和会话亲和

### 8.2 各模式选择建议

| 场景 | 推荐模式 | 原因 |
|------|---------|------|
| **中小集群** | iptables | 简单稳定,无需额外模块 |
| **大规模集群** | IPVS | 高性能,规则少 |
| **需要高级调度** | IPVS | 支持多种调度算法 |
| **老旧内核** | iptables | IPVS 可能不支持 |
| **向后兼容** | userspace | 已废弃,不推荐 |

### 8.3 架构优势

| 特性 | 实现 | 优势 |
|------|------|------|
| **可扩展** | Provider 接口 | 易于添加新的代理模式 |
| **高性能** | IPVS 模式 | 支持大规模服务 |
| **可靠性** | 周期性同步 | 自动恢复规则 |
| **灵活性** | 多种负载均衡 | 满足不同需求 |
| **双栈支持** | DualStackProxier | IPv4/IPv6 同时工作 |

### 8.4 对比其他服务网格

| 特性 | kube-proxy | Istio | Linkerd |
|------|-----------|-------|---------|
| **层级** | 四层(L4) | 七层(L7) | 七层(L7) |
| **性能** | 高(内核态) | 中(用户态) | 中(用户态) |
| **功能** | 负载均衡 | 流量管理、灰度发布等 | 简化服务网格 |
| **复杂度** | 低 | 高 | 中 |
| **适用场景** | Kubernetes 原生 | 微服务治理 | 轻量级服务网格 |

### 8.5 启动流程关键点回顾

1. **配置加载**: 支持配置文件和命令行参数
2. **代理模式选择**: 根据配置和内核支持自动选择
3. **网络接口初始化**: 创建 iptables/IPVS/ipset 接口
4. **Informer 启动**: 监听 Service/Endpoint/Node 变化
5. **事件处理器注册**: 将 Proxier 注册为事件处理器
6. **SyncLoop 启动**: 周期性同步代理规则

### 8.6 源码文件组织

```
cmd/kube-proxy/app/
├── server.go              # ProxyServer 定义和主运行逻辑
├── server_others.go       # Linux 平台的 ProxyServer 创建
└── server_windows.go      # Windows 平台的 ProxyServer 创建

pkg/proxy/
├── types.go               # Provider 接口定义
├── config/                # 配置和事件处理
│   ├── config.go          # ServiceConfig, EndpointsConfig
│   └── service.go         # 服务变更处理
├── iptables/              # iptables 模式实现
│   └── proxier.go
├── ipvs/                  # IPVS 模式实现
│   └── proxier.go
└── userspace/             # userspace 模式实现
    └── proxier.go
```

---
