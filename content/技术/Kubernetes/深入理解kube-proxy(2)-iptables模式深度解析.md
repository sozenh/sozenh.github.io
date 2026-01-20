---
title: "深入理解 kube-proxy(2)-iptables 模式深度解析"
date: 2026-01-20T18:00:00+08:00
draft: false
tags: ["kubernetes", "源码解析", "kube-proxy", "iptables"]
summary: "从基础到实践，深入理解 kube-proxy iptables 模式的工作原理"
---

# 深入理解 kube-proxy(2) - iptables 模式深度解析

---

## 1. iptables 基础知识

在深入 kube-proxy 的 iptables 实现之前，我们需要先理解一些基础概念。

### 1.1 什么是 iptables

iptables 是 Linux 系统中的一个防火墙工具，它工作在网络层（OSI 第 3 层）和传输层（OSI 第 4 层），用于控制数据包的转发、修改和过滤。

**核心概念**:

iptables 有 **5 个钩子点**（称为"五链"）和 **4 个表**（称为"四表"）：

**五链（5 Hook Points）**：
1. **PREROUTING** - 数据包进入后，路由决策前
2. **INPUT** - 发往本机进程的数据包
3. **FORWARD** - 需要转发的数据包
4. **OUTPUT** - 本机进程发出的数据包
5. **POSTROUTING** - 数据包离开前

**四表（4 Tables）**：
- raw - 主要用来决定是否对数据包进行状态跟踪;
- mangle - 用来修改数据包的服务类型，生存周期，为数据包设置标记，实现流量整形、策略路由等;
- nat - 用来修改数据包的 IP 地址、端口号信息;
- filter - 用来对数据包进行过滤，具体的规则要求决定如何处理一个数据包;

```
                              网卡
                               │
                    ┌──────────▼───────────┐
                    │ PREROUTING           │
                    │ raw → mangle → nat   │
                    └──────────┬───────────┘
                            路由决策
                 ┌─────────────┴─────────────┐
        ┌────────▼─────────┐        ┌────────▼─────────┐
        │   FORWARD        │        │    INPUT         │
        │ mangle → filter  │        │ mangle → filter  │
        └────────┬─────────┘        └────────┬─────────┘
                 │                           │
                 │                  ┌────────▼─────────┐
                 │                  │ local application│
                 │                  └────────┬─────────┘
                 │                           │
                 │                  ┌────────▼─────────┐
                 │                  │ OUTPUT           │
                 │                  │ raw → mangle →   │
                 │                  │ nat → filter     │
                 │                  └────────┬─────────┘
                 └───────────────────────────│
                                     ┌───────▼──────────┐
                                     │ POSTROUTING      │
                                     │ mangle → nat     │
                                     └────────┬─────────┘
                                            网卡
```

**关键理解点**:

1. **数据包按钩子点的顺序流动**：
   - 入站流量：PREROUTING → (INPUT 或 FORWARD) → POSTROUTING
   - 出站流量：OUTPUT → POSTROUTING

2. **在每个钩子点内部**，不同表的链按优先级被触发：raw → mangle → nat → filter

### 1.2 什么是 DNAT 和 SNAT

**SNAT (Source Network Address Translation)**: 源地址转换

SNAT 修改数据包的源 IP 地址和端口，通常用于让内网主机访问外网。

```
示例：内网访问外网场景

原始请求:
  源 IP: 10.0.0.5 (内网服务器)  → 目标 IP: 93.184.216.34 (example.com)

在 POSTROUTING 钩子点执行 SNAT 后:
  源 IP: 192.168.1.10 (网关 IP)  → 目标 IP: 93.184.216.34
  源端口: 54321                  → 目标端口: 80

效果：外网服务器看到的请求来自网关 IP，而不是内网 IP
```

**为什么需要 SNAT?**

```
场景：内网主机通过网关访问外网

1. 内网主机发送: 10.0.0.5 → 93.184.216.34
2. 网关收到请求，执行 DNAT: 10.0.0.5 → 93.184.216.34
3. 外网服务器收到: 源 IP = 10.0.0.5
4. 外网服务器响应: 93.184.216.34 → 10.0.0.5

问题: 10.0.0.5 是私网地址，外网路由器不知道如何转发
解决: 使用 SNAT 将源 IP 改为网关的公网 IP
    - 外网服务器看到: 192.168.1.10 (网关) → 93.184.216.34
    - 外网服务器响应: 93.184.216.34 → 192.168.1.10
    - 网关收到响应后，再转换回内网 IP: 192.168.1.10 → 10.0.0.5
```

**DNAT (Destination Network Address Translation)**: 目标地址转换

DNAT 修改数据包的目标 IP 地址和端口，通常用于端口转发和负载均衡。

```
示例：端口转发场景

原始请求:
  源 IP: 203.0.113.5         → 目标 IP: 192.168.1.10 (公网 IP)
  源端口: 12345              → 目标端口: 80

在 PREROUTING 钩子点执行 DNAT 后:
  源 IP: 203.0.113.5         → 目标 IP: 10.0.0.5 (内网服务器 IP)
  源端口: 12345              → 目标端口: 8080

效果：访问公网 IP 的 80 端口，实际被转发到内网服务器的 8080 端口
```

### 1.3 完整的端口转发流程

让我们通过一个具体的例子来跟踪数据包在 iptables 中的完整流转过程。

**场景：外部客户端访问内网 Web 服务**

```
外部客户端 (203.0.113.5) 访问 网关对外地址 (1.2.3.4:80)
  │
  │ 数据包: src=203.0.113.5, dst=1.2.3.4:80
  ▼
网关服务器
  外网接口: 1.2.3.4
  内网接口: 10.0.0.1
  │
  ├─▶ 1. PREROUTING 钩子点 (nat 表)
  │     ├─▶ 匹配规则: dst=1.2.3.4:80
  │     ├─▶ 执行 DNAT: 1.2.3.4:80 → 10.0.0.5:8080
  │     └─▶ 数据包变为: src=203.0.113.5, dst=10.0.0.5:8080
  │
  ├─▶ 2. 路由决策（在 PREROUTING 之后）
  │     ├─▶ 目标 IP 10.0.0.5 不属于本机
  │     └─▶ 决定: 通过内网接口转发
  │
  ├─▶ 3. FORWARD 钩子点 (filter 表)
  │     ├─▶ 匹配规则: 允许该连接及其回包
  │     └─▶ 数据包继续转发
  │
  ├─▶ 4. POSTROUTING 钩子点 (nat 表)
  │     ├─▶ （默认不做 SNAT / MASQUERADE，当数据包返回网关时，利用 conntrack 做反向 DNAT 即可）
  │     ├─▶ （除非该网关非内网默认网关，即数据包最终无法返回该网关，才需要做 SNAT）
  │     └─▶ 数据包保持不变:
  │           src=203.0.113.5, dst=10.0.0.5:8080
  │
  ▼
发送到内网服务器 (10.0.0.5:8080)
  │
  ▼
内网服务器 (10.0.0.5:8080) 响应请求
  │
  │ 数据包: src=10.0.0.5:8080, dst=203.0.113.5
  ▼
网关服务器
  内网接口: 10.0.0.1
  │
  ├─▶ 5. PREROUTING 钩子点 (nat 表)
  │     ├─▶ 命中已有 conntrack 连接
  │     ├─▶ 执行反向 DNAT（自动）
  │     └─▶ 数据包变为:
  │           src=1.2.3.4:80, dst=203.0.113.5
  │
  ├─▶ 6. 路由决策
  │     ├─▶ 目标 IP 203.0.113.5 不属于本机
  │     └─▶ 决定: 通过外网接口发送
  │
  ├─▶ 7. POSTROUTING 钩子点 (nat 表)
  │     ├─▶ （如入站方向未做 SNAT，此处也无需处理）
  │     └─▶ 数据包保持不变
  │
  ▼
发送到外部客户端 (203.0.113.5)
```

---

## 2. conntrack 与流量黑洞

### 2.1 什么是 conntrack

**conntrack (connection tracking)** 是 Linux 内核的连接跟踪机制，它记录所有活动的网络连接状态。

**为什么需要 conntrack?**

```
场景: TCP 连接

Client                    节点                      Pod
  │                         │                          │
  ├─ SYN ──────────────────▶│                          │
  │                         ├─ DNAT ──────────────────▶│
  │                         │                          │
  │◀─ SYN-ACK ──────────────┤◀─────────────────────────┤
  │◀─ (转发自 Pod)           │                          │
  │                         │                          │
  ├─ ACK ──────────────────▶│                          │
  │                         ├─ DNAT ──────────────────▶│
  │                         │                          │

问题: 如何知道 SYN-ACK 属于哪个连接?
解决: conntrack 记录连接状态
    - 原始连接: 203.0.113.5:12345 → 10.96.0.10:80
    - 转换后连接: 203.0.113.5:12345 → 10.244.1.5:8080

当 SYN-ACK 返回时，内核查看 conntrack 表: "哦，这个包属于之前的连接，需要反向 DNAT"
    10.244.1.5:8080 → 203.0.113.5:12345
```

**conntrack 条目示例**:

```bash
# 查看 conntrack 表
conntrack -L

# TCP 连接
tcp      6 117 SYN_SENT src=203.0.113.5 dst=10.244.1.5 sport=12345 dport=8080
        [UNREPLIED] src=10.244.1.5 dst=203.0.113.5 sport=8080 dport=12345

# UDP "连接" (UDP 是无状态的，但 conntrack 也会记录)
udp      17 30 src=203.0.113.5 dst=10.96.0.10 sport=54321 dport=53
        src=10.244.1.5 dst=203.0.113.5 sport=53 dport=54321
```

### 2.2 什么是流量黑洞

**流量黑洞 (Traffic Blackhole)**: 数据包被发送到某个目标，但无法到达，导致连接超时或失败。

**在 Kubernetes 中的场景**:

```
场景: UDP Service 的 Endpoint 从 0 变为非 0

时间线:
────────────────────────────────────────────────────────────

T=0:  Service "dns" 有 2 个 Endpoint
     - 10.244.1.5:53
     - 10.244.2.5:53

     客户端发送 UDP 请求到 10.96.0.10:53 (Service IP)
     ↓ DNAT
     请求到达 10.244.1.5:53 (Endpoint 1)
     ↓ conntrack 记录:
     udp 17 30 src=客户端IP dst=10.96.0.10:53 sport=12345 dport=53
         src=10.244.1.5:53 dst=客户端IP sport=53 dport=12345

T=30s: 两个 Pod 都挂了 (Endpoint 数量变为 0)

     kube-proxy 删除了 iptables 规则
     Service 现在没有 Endpoint

     但是！conntrack 条目还在！（超时时间 30s）

T=35s: 客户端再次发送 UDP 请求到 10.96.0.10:53

     数据包到达节点
     ↓
     内核检查 conntrack: "这个连接还在活跃"
     ↓
     根据 conntrack 条目，内核仍然 DNAT 到 10.244.1.5:53
     ↓
     但 10.244.1.5 已经不存在了！
     ↓
     【流量黑洞】数据包被发送到不存在的 IP，永远不会得到响应
     ↓
     客户端等待超时（可能 30 秒或更久）
```

### 2.3 为什么要清理 conntrack

**问题**: UDP 的 conntrack 条目默认超时时间很长（30 秒），如果 Endpoint 快速变化（Pod 重启、滚动更新），旧的 conntrack 条目会指向不存在的 Pod。

**解决**: kube-proxy 检测到 UDP Service 的 Endpoint 从 0 变为非 0 时，主动清理 conntrack 条目。

**清理时机**:

```go
// 检测需要清理 conntrack 的服务
for _, svcPortName := range endpointUpdateResult.StaleServiceNames {
    if svcInfo, ok := proxier.serviceMap[svcPortName]; ok {
        // 只清理 UDP/SCTP 协议（TCP 有自己的连接状态管理）
        if conntrack.IsClearConntrackNeeded(svcInfo.Protocol()) {
            // 清理 ClusterIP 的 conntrack
            conntrackCleanupServiceIPs.Insert(svcInfo.ClusterIP().String())

            // 清理 ExternalIPs 的 conntrack
            for _, extIP := range svcInfo.ExternalIPStrings() {
                conntrackCleanupServiceIPs.Insert(extIP)
            }

            // 清理 NodePort 的 conntrack
            if svcInfo.Protocol() == v1.ProtocolUDP && nodePort != 0 {
                conntrackCleanupServiceNodePorts.Insert(nodePort)
            }
        }
    }
}
```

**清理命令**:

```bash
# 清理特定 IP 的 conntrack 条目
conntrack -D -d 10.96.0.10

# 清理特定端口的所有 conntrack 条目
conntrack -D --dport 53

# 清理特定协议的所有 conntrack 条目
conntrack -D -p udp
```

**效果对比**:

```
不清理 conntrack:
  Pod 重启后 30 秒内，客户端请求仍然被路由到旧 IP
  → 请求超时
  → 用户体验差（30 秒延迟）

清理 conntrack:
  Pod 重启后立即清理 conntrack
  → 新请求立即路由到新 Pod
  → 无延迟
```

---

## 3. iptables 模式概述

### 3.1 工作原理

iptables 模式通过 Linux 内核的 netfilter 框架实现负载均衡。kube-proxy 监听 Kubernetes Service 和 Endpoint 的变化，动态生成 iptables 规则来实现流量转发。

**核心思想**:
- 使用 NAT 功能实现数据包目标地址转换(DNAT)
- 通过 statistic 模块实现随机负载均衡
- 所有规则在内核态处理，性能优于用户态代理

**简单比喻**:

```
iptables 就像是一个"智能路由表"：

传统路由表:
  目标 IP 10.244.1.5 → 发送到接口 eth0

iptables 路由表:
  目标 IP 10.96.0.10:80 (Service)
    → 随机选择:
       - 33% 概率 → 10.244.1.5:8080 (Pod 1)
       - 33% 概率 → 10.244.2.5:8080 (Pod 2)
       - 33% 概率 → 10.244.3.5:8080 (Pod 3)
```

### 3.2 数据流向

```
Client Packet
    │
    │ 请求: Service ClusterIP:Port
    ▼
PREROUTING chain (nat table)
    │
    ├─▶ KUBE-SERVICES chain
    │    │
    │    ├─▶ Service ClusterIP Match?
    │    │    │
    │    │    └─▶ KUBE-SVC-XXXX (Service chain)
    │    │         │
    │    │         └─▶ 随机选择 Endpoint 链
    │    │              ├─▶ KUBE-SEP-XXXX1 (33.3%) ──▶ DNAT to Pod1
    │    │              ├─▶ KUBE-SEP-XXXX2 (33.3%) ──▶ DNAT to Pod2
    │    │              └─▶ KUBE-SEP-XXXX3 (33.3%) ──▶ DNAT to Pod3
    │    │
    │    └─▶ (No Match) Continue normal routing
    │
    ▼
POSTROUTING chain (nat table)
    │
    ├─▶ KUBE-POSTROUTING chain
    │    │
    │    └─▶ MASQUERADE if needed (SNAT)
    │
    ▼
Backend Pod
```

### 3.3 优缺点分析

**优点**:
- ✅ **内核态处理**: 数据包在内核空间直接转发，无需用户态-内核态切换
- ✅ **稳定成熟**: iptables 是 Linux 标准组件，经过充分测试
- ✅ **规则持久化**: 规则写入内核，重启后自动恢复
- ✅ **无需用户态进程**: 不需要像 userspace 模式那样维护用户态代理

**缺点**:
- ❌ **规则数量线性增长**: 每个 Service/Endpoint 都需要规则，1000 个 Service 可能产生数万条规则
- ❌ **大规模性能下降**: 规则越多，遍历耗时越长，影响吞吐量和延迟
- ❌ **只支持随机负载均衡**: 无法使用最少连接、加权轮询等高级算法
- ❌ **规则更新开销**: 全量刷新规则，即使只有一个 Service 变化

**性能对比**:

```
小型集群 (< 100 Services):
  - iptables 模式: 表现优秀
  - 规则数量: ~1000 条
  - 延迟增加: < 1ms

中型集群 (100-1000 Services):
  - iptables 模式: 表现良好
  - 规则数量: ~10000 条
  - 延迟增加: 1-5ms

大型集群 (> 1000 Services):
  - iptables 模式: 性能下降明显
  - 规则数量: >50000 条
  - 延迟增加: > 10ms
  - 推荐: 使用 IPVS 模式
```

---

## 4. Proxier 初始化

### 4.1 创建 Proxier

**位置**: `pkg/proxy/iptables/proxier.go:243-170`

NewProxier 的作用是根据节点的配置创建一个 Proxier 实例，初始化所有状态、缓冲区、规则缓存、同步机制等，为后续 iptables 规则生成做好准备。

```go
func NewProxier(
    ipt utiliptables.Interface,
    sysctl utilsysctl.Interface,
    exec utilexec.Interface,
    syncPeriod time.Duration,
    minSyncPeriod time.Duration,
    masqueradeAll bool,
    masqueradeBit int,
    localDetector proxyutiliptables.LocalTrafficDetector,
    hostname string,
    nodeIP net.IP,
    recorder events.EventRecorder,
    healthzServer healthcheck.ProxierHealthUpdater,
    nodePortAddresses []string,
) (*Proxier, error) {
    // 如果 NodePort 包含回环地址，需要设置 route_localnet=1，否则内核会拒绝回环地址的流量
    if utilproxy.ContainsIPv4Loopback(nodePortAddresses) {
        if err := utilproxy.EnsureSysctl(sysctl, "net/ipv4/conf/all/route_localnet", 1); err != nil {
            return nil, err
        }
    }

    // 检查 br_netfilter 模块，确保 bridge 流量可以经过 iptables 处理
    if val, err := sysctl.GetSysctl("net/bridge/bridge-nf-call-iptables"); err == nil && val != 1 {
        klog.InfoS("Missing br-netfilter module or unset sysctl br-nf-call-iptables")
    }

    // 生成 masquerade 标记，用于 SNAT，标记哪些流量需要做源地址修改
    masqueradeValue := 1 << uint(masqueradeBit)
    masqueradeMark := fmt.Sprintf("%#08x", masqueradeValue)

    // 确定协议族，避免 IPv4 与 IPv6 混用导致的路由错误
    ipFamily := v1.IPv4Protocol
    if ipt.IsIPv6() {
        ipFamily = v1.IPv6Protocol
    }
    ipFamilyMap := utilproxy.MapCIDRsByIPFamily(nodePortAddresses)
    nodePortAddresses = ipFamilyMap[ipFamily]

    // 创建 Proxier 实例，包含服务、Endpoints 追踪器、缓冲区、规则缓存、同步机制等
    proxier := &Proxier{
        serviceMap:               make(proxy.ServiceMap),
        serviceChanges:           proxy.NewServiceChangeTracker(newServiceInfo, ipFamily, recorder, nil),
        endpointsMap:             make(proxy.EndpointsMap),
        endpointsChanges:         proxy.NewEndpointChangeTracker(hostname, newEndpointInfo, ipFamily, recorder, nil),
        syncPeriod:               syncPeriod,
        iptables:                 ipt,
        masqueradeAll:            masqueradeAll,
        masqueradeMark:           masqueradeMark,
        exec:                     exec,
        localDetector:            localDetector,
        hostname:                 hostname,
        nodeIP:                   nodeIP,
        recorder:                 recorder,
        serviceHealthServer:      healthcheck.NewServiceHealthServer(hostname, recorder, nodePortAddresses),
        healthzServer:            healthzServer,
        precomputedProbabilities: make([]string, 0, 1001),
        iptablesData:             bytes.NewBuffer(nil),
        existingFilterChainsData: bytes.NewBuffer(nil),
        filterChains:             utilproxy.LineBuffer{},
        filterRules:              utilproxy.LineBuffer{},
        natChains:                utilproxy.LineBuffer{},
        natRules:                 utilproxy.LineBuffer{},
        nodePortAddresses:        nodePortAddresses,
        networkInterfacer:        utilproxy.RealNetwork{},
    }

    // 创建同步运行器，控制 syncProxyRules 执行频率，避免过于频繁更新 iptables
    burstSyncs := 2
    proxier.syncRunner = async.NewBoundedFrequencyRunner("sync-runner", proxier.syncProxyRules, minSyncPeriod, time.Hour, burstSyncs)

    // 启动 iptables 监控，监控 nat/filter/mangle 表变化，触发规则同步
    go ipt.Monitor(kubeProxyCanaryChain, []utiliptables.Table{utiliptables.TableMangle, utiliptables.TableNAT, utiliptables.TableFilter}, proxier.syncProxyRules, syncPeriod, wait.NeverStop)

    return proxier, nil
}
```

**关键步骤说明**:

1. **sysctl 参数检查**:
   - `route_localnet=1`: 允许使用回环地址作为 NodePort，常见于本地测试或 HostNetwork Pod
   - `bridge-nf-call-iptables=1`: 确保桥接流量经过 iptables，否则 Pod-to-Pod 或 Host-to-Pod 的流量可能绕过 NAT

2. **masqueradeMark 生成**:
   - 用于标记需要 SNAT 的数据包
   - SNAT 只在 Pod 默认网关不经过节点时才会生效

3. **协议族过滤**:
   - IPv4 与 IPv6 地址分开处理，避免混用导致 DNAT 或 SNAT 错误

4. **创建同步运行器**:
   - `BoundedFrequencyRunner` 控制规则更新频率，避免频繁写 iptables 造成性能下降

---

## 5. 核心数据结构

### 5.1 Proxier 结构体

```go
type Proxier struct {
    // 同步控制
    mu           sync.Mutex

    // 数据缓存与变更追踪器
    nodeLabels   map[string]string
    serviceMap   proxy.ServiceMap
    serviceChanges   *proxy.ServiceChangeTracker
    endpointsMap proxy.EndpointsMap
    endpointsChanges *proxy.EndpointChangeTracker

    // 初始化状态
    servicesSynced       bool
    endpointSlicesSynced bool
    initialized          int32

    // 限流/异步调用 syncProxyRules
    syncRunner           *async.BoundedFrequencyRunner
    syncPeriod           time.Duration

    // iptables 接口
    iptables       utiliptables.Interface
    masqueradeAll  bool
    masqueradeMark string

    // 其他接口
    exec           utilexec.Interface
    localDetector  proxyutiliptables.LocalTrafficDetector
    hostname       string
    nodeIP         net.IP
    recorder       events.EventRecorder

    // 健康检查
    serviceHealthServer healthcheck.ServiceHealthServer
    healthzServer       healthcheck.ProxierHealthUpdater

    // 性能优化:预分配的缓冲区
    precomputedProbabilities []string

    // iptables 规则缓冲区
    iptablesData             *bytes.Buffer
    existingFilterChainsData *bytes.Buffer
    filterChains             utilproxy.LineBuffer
    filterRules              utilproxy.LineBuffer
    natChains                utilproxy.LineBuffer
    natRules                 utilproxy.LineBuffer

    // 配置
    nodePortAddresses []string
    endpointChainsNumber int

    // 网络接口
    networkInterfacer utilproxy.NetworkInterfacer
}
```

**设计要点**:

1. **变更追踪器**:
   - `serviceChanges`: 追踪 Service 变更
   - `endpointsChanges`: 追踪 Endpoint 变更

2. **同步控制**:
   - `mu`: 互斥锁保护并发访问
   - `syncRunner`: 有界频率运行器,控制同步频率

3. **缓冲区复用**:
   - 使用 `LineBuffer` 复用内存,避免频繁分配
   - 减少垃圾回收压力

---

## 6. 规则同步机制

### 6.1 syncProxyRules 主流程

**位置**: `pkg/proxy/iptables/proxier.go:806-383`

```go
func (proxier *Proxier) syncProxyRules() {
    proxier.mu.Lock()
    defer proxier.mu.Unlock()

    // 检查初始化状态
	// 必须等待 Service/Endpoint 数据加载完成，否则无法生成正确的 iptables 规则
    if !proxier.isInitialized() {
        klog.V(2).InfoS("Not syncing iptables until Services and Endpoints have been received")
        return
    }

    // 记录同步时间
    start := time.Now()
    defer func() {
        metrics.SyncProxyRulesLatency.Observe(metrics.SinceInSeconds(start))
        klog.V(2).InfoS("SyncProxyRules complete", "elapsed", time.Since(start))
    }()

    // 更新 serviceMap 和 endpointsMap
    serviceUpdateResult := proxier.serviceMap.Update(proxier.serviceChanges)
    endpointUpdateResult := proxier.endpointsMap.Update(proxier.endpointsChanges)

    // 检测需要清理 conntrack 的服务，主要针对 UDP 和 SCTP 服务
    conntrackCleanupServiceIPs := serviceUpdateResult.UDPStaleClusterIP
    conntrackCleanupServiceNodePorts := sets.NewInt()

    for _, svcPortName := range endpointUpdateResult.StaleServiceNames {
        if svcInfo, ok := proxier.serviceMap[svcPortName]; ok && svcInfo != nil {
            // UDP/SCTP 才需要清理
			// UDP 是无连接协议，conntrack 条目有超时机制（默认 30 秒）
			// 当 Endpoint 快速变化（Pod 重启、滚动更新）时，旧条目仍存在
			// 会导致请求被 DNAT 到已不存在的 Pod → 流量黑洞
			// kube-proxy 在这里主动清理，保证新请求立即到达可用 Pod
            if conntrack.IsClearConntrackNeeded(svcInfo.Protocol()) {
				
                // 清理 ClusterIP 对应的 conntrack 条目
                conntrackCleanupServiceIPs.Insert(svcInfo.ClusterIP().String())
				
                // 清理 ExternalIP / LoadBalancer IP 对应的 conntrack 条目
                for _, extIP := range svcInfo.ExternalIPStrings() {
                    conntrackCleanupServiceIPs.Insert(extIP)
                }
                for _, lbIP := range svcInfo.LoadBalancerIPStrings() {
                    conntrackCleanupServiceIPs.Insert(lbIP)
                }

                // 清理 NodePort 对应的 conntrack 条目（仅 UDP）
                nodePort := svcInfo.NodePort()
                if svcInfo.Protocol() == v1.ProtocolUDP && nodePort != 0 {
                    conntrackCleanupServiceNodePorts.Insert(nodePort)
                }
            }
        }
    }

    klog.V(2).InfoS("Syncing iptables rules")

    // ===== 步骤 5: 生成和应用的 iptables 规则 =====
    // 1. 根据 serviceMap 和 endpointsMap 生成 KUBE-SERVICES / KUBE-SEP 规则
    // 2. 应用 DNAT 到后端 Pod
    // 3. 根据 nodePort/masquerade 配置生成 SNAT 规则
    // 4. 写入 iptables 内核
    // 说明:
    //   - 所有规则先在缓冲区生成（iptablesData / LineBuffer）
    //   - 减少重复提交内核调用，提高性能
}
```

**关键点**:

1. **初始化检查**: 必须等待 Services 和 Endpoints 同步完成
2. **变更更新**: 将变更应用到 serviceMap 和 endpointsMap
3. **conntrack 清理**: 检测 UDP 服务的 stale 连接，防止旧条目 DNAT 到已不存在 Pod → 流量黑洞
4. **错误重试**: 如果同步失败,延迟重试

### 6.2 BoundedFrequencyRunner

`BoundedFrequencyRunner` 确保同步操作在合理的频率范围内:

**参数**:
- `minSyncPeriod`: 最小同步周期(默认 1s)
- `syncPeriod`: 最大同步周期(默认 30s)
- `burstSyncs`: 突发同步次数(默认 2)

**工作方式**:
```
有事件时:
  ┌────────────┐
  │ 事件到达    │
  └─────┬──────┘
        ▼
  等待 minSyncPeriod (1s)
        │
        ▼
  执行 syncProxyRules()（最多允许 burstSyncs 次突发同步）

无事件时:
  ┌────────────┐
  │  上次同步   │
  └─────┬──────┘
        ▼
  等待 syncPeriod (30s)
        │
        ▼
  执行 syncProxyRules() (全量同步)
```

---

## 7. iptables 规则生成

### 7.1 完整的链结构

kube-proxy 在 iptables 中创建了一套完整的链结构来实现 Service 负载均衡。

**入站流量处理流程**:

```
数据包进入网卡
  │
  ▼
PREROUTING 链 (数据包进入后的第一个钩子点)
  │
  ├─▶ nat 表处理
  │     └─▶ -j KUBE-SERVICES
  │           │
  │           ▼
  │     KUBE-SERVICES 链 (所有 Service 的入口点)
  │     │
  │     ├─▶ 匹配 ClusterIP:Port
  │     │     └─▶ KUBE-SVC-XXXXX (Service 链)
  │     │
  │     ├─▶ 匹配 NodePort:Port
  │     │     └─▶ KUBE-NODEPORTS
  │     │
  │     └─▶ 匹配 ExternalIP:Port
  │           └─▶ KUBE-EXT-XXX
  │
  ├─▶ KUBE-SVC-XXXXX (具体 Service 链)
  │     │
  │     └─▶ 随机跳转到 Endpoint 链 (使用 statistic 模块)
  │           ├─▶ KUBE-SEP-XXXX1 (概率 33.3%)
  │           ├─▶ KUBE-SEP-XXXX2 (概率 33.3%)
  │           └─▶ KUBE-SEP-XXXX3 (概率 33.3%)
  │
  └─▶ KUBE-SEP-XXXXX (Endpoint 链)
        └─▶ DNAT --to-destination PodIP:Port
              │
              ▼
路由决策 (目标地址已被 DNAT 修改为 PodIP)
  │
  ├─▶ 如果目标是本机 Pod → INPUT 链
  │     │
  │     └─▶ filter 表处理
  │           └─▶ 本地 Pod
  │
  └─▶ 如果目标是其他节点 → FORWARD 链
        │
        └─▶ filter 表处理
              └─▶ -j KUBE-FORWARD
                    │
                    ▼
              POSTROUTING 链 (数据包离开前的最后一个钩子点)
                    │
                    └─▶ nat 表处理
                          └─▶ -j KUBE-POSTROUTING (MASQUERADE 处理)
                                │
                                ▼
发送到 Backend Pod
```

**出站流量处理流程**:

```
本机应用发送数据包
  │
  ▼
OUTPUT 链 (本机发出的数据包)
  │
  └─▶ nat 表处理
        └─▶ -j KUBE-SERVICES
              │
              ▼
路由决策
  │
  ▼
POSTROUTING 链
  │
  └─▶ nat 表处理
        └─▶ -j KUBE-POSTROUTING
              │
              ▼
发送到目标
```

### 7.2 规则生成流程

**位置**: `pkg/proxy/iptables/proxier.go:806-1450`

kube-proxy 的规则生成在 `syncProxyRules()` 函数中实现，整个过程分为以下核心步骤：

#### 步骤 1: 准备基础链

```go
// proxier.go:864-877
for _, jump := range iptablesJumpChains {
    // 确保 KUBE-SERVICES, KUBE-NODEPORTS, KUBE-POSTROUTING 等基础链存在
    proxier.iptables.EnsureChain(jump.table, jump.dstChain)

    // 在系统链中添加跳转规则
    // 例如: PREROUTING → KUBE-SERVICES
    proxier.iptables.EnsureRule(utiliptables.Prepend, jump.table, jump.srcChain, args...)
}
```

**生成的规则示例**:
```bash
# 在 PREROUTING 链中添加跳转规则
-A PREROUTING -m comment --comment "kubernetes service portals" -j KUBE-SERVICES

# 在 OUTPUT 链中添加跳转规则
-A OUTPUT -m comment --comment "kubernetes service portals" -j KUBE-SERVICES

# 在 POSTROUTING 链中添加跳转规则
-A POSTROUTING -m comment --comment "kubernetes postrouting rules" -j KUBE-POSTROUTING
```

#### 步骤 2: 为每个 Service 创建服务链

```go
// proxier.go:1042-1052
for _, svcName := range proxier.serviceMap {
    svcInfo := proxier.serviceMap[svcName]

    // 生成 KUBE-SVC-XXXX 链名
    svcChain := servicePortPolicyClusterChainName(svcName, svcInfo)

    // 创建服务链
    proxier.natChains.Write(utiliptables.MakeChainLine(svcChain))

    // 在 KUBE-SERVICES 中添加匹配规则
    args := []string{
        "-A", string(kubeServicesChain),
        "-m", "comment", "--comment", fmt.Sprintf(`"%s cluster IP"`, svcNameString),
        "-m", protocol, "-p", protocol,
        "-d", svcInfo.ClusterIP().String(),
        "--dport", strconv.Itoa(svcInfo.Port()),
        "-j", string(svcChain),
    }
    proxier.natRules.Write(args)
}
```

**生成的规则示例**:
```bash
# 创建服务链
:KUBE-SVC-67RL4FK6IPCNHQJO - [0:0]

# 在 KUBE-SERVICES 中添加匹配规则
-A KUBE-SERVICES -m comment --comment "default/nginx-service cluster IP" \
  -m tcp -p tcp -d 10.96.0.10 --dport 80 -j KUBE-SVC-67RL4FK6IPCNHQJO
```

#### 步骤 3: 为每个 Endpoint 创建端点链

```go
// proxier.go:1552-1575
func (proxier *Proxier) writeServiceToEndpointRules(...) {
    numEndpoints := len(endpoints)

    for i, ep := range endpoints {
        epInfo, ok := ep.(*endpointsInfo)

        // 为每个 Endpoint 创建 KUBE-SEP-XXXX 链
        proxier.natChains.Write(utiliptables.MakeChainLine(epInfo.ChainName))

        // 在服务链中添加跳转到 Endpoint 链的规则
        args = append(args[:0], "-A", string(svcChain))

        if i < (numEndpoints - 1) {
            // 使用 statistic 模块实现概率匹配（负载均衡）
            args = append(args,
                "-m", "statistic",
                "--mode", "random",
                "--probability", proxier.probability(numEndpoints-i))
        }
        // 最后一个 Endpoint 是 100% 匹配
        proxier.natRules.Write(args, "-j", string(epInfo.ChainName))
    }
}
```

**生成的规则示例**:
```bash
# 创建三个 Endpoint 链
:KUBE-SEP-I7PTGWNWVA2M4U7R - [0:0]  # Pod 1
:KUBE-SEP-RZTI7M2MUBNHQP7R - [0:0]  # Pod 2
:KUBE-SEP-7QTW6LWFLE4VTB4Z - [0:0]  # Pod 3

# 在服务链中添加负载均衡规则
-A KUBE-SVC-67RL4FK6IPCNHQJO -m comment --comment "default/nginx-service -> 10.244.1.5:80" \
  -m statistic --mode random --probability 0.33332999982376099 \
  -j KUBE-SEP-I7PTGWNWVA2M4U7R

-A KUBE-SVC-67RL4FK6IPCNHQJO -m comment --comment "default/nginx-service -> 10.244.2.5:80" \
  -m statistic --mode random --probability 0.50000000000000000 \
  -j KUBE-SEP-RZTI7M2MUBNHQP7R

-A KUBE-SVC-67RL4FK6IPCNHQJO -m comment --comment "default/nginx-service -> 10.244.3.5:80" \
  -j KUBE-SEP-7QTW6LWFLE4VTB4Z  # 第三个规则没有 probability，表示 100% 匹配
```

#### 步骤 4: 在 Endpoint 链中添加 DNAT 规则

```go
// proxier.go:1575
proxier.natRules.Write(args, "-j", string(epInfo.ChainName))

// 在 Endpoint 链中执行 DNAT
args := []string{
    "-A", string(epInfo.ChainName),
    "-m", "comment", "--comment", comment,
    "-j", "DNAT",
    "--to-destination", epInfo.Endpoint.String(),
}
proxier.natRules.Write(args)
```

**生成的规则示例**:
```bash
# Endpoint 链中执行 DNAT
-A KUBE-SEP-I7PTGWNWVA2M4U7R -m comment --comment "default/nginx-service -> 10.244.1.5:80" \
  -j DNAT --to-destination 10.244.1.5:80

-A KUBE-SEP-RZTI7M2MUBNHQP7R -m comment --comment "default/nginx-service -> 10.244.2.5:80" \
  -j DNAT --to-destination 10.244.2.5:80

-A KUBE-SEP-7QTW6LWFLE4VTB4Z -m comment --comment "default/nginx-service -> 10.244.3.5:80" \
  -j DNAT --to-destination 10.244.3.5:80
```

#### 步骤 5: 批量应用规则到内核

```go
// proxier.go:1450-1460
// 使用 iptables-restore 批量应用规则
proxier.iptables.RestoreAll(
    proxier.natChains.Bytes(),
    proxier.natRules.Bytes(),
    proxier.filterChains.Bytes(),
    proxier.filterRules.Bytes(),
    false,
)
```

**关键点**:

1. **规则缓冲**: 所有规则先写入 `LineBuffer`，减少系统调用次数
2. **概率计算**: 使用 `probability(n)` 函数计算每个 Endpoint 的匹配概率
   - 第 1 个: `1/3 ≈ 0.3333`
   - 第 2 个: `1/2 = 0.5`
   - 第 3 个: `1` (不设置 probability，默认 100%)
3. **批量应用**: 使用 `iptables-restore` 一次性应用所有规则，性能优于逐条执行 `iptables` 命令

---

## 8. 连接跟踪清理

### 8.1 清理触发时机

kube-proxy 在以下情况下清理 conntrack:

1. **UDP Service 从无 Endpoint 到有 Endpoint**
2. **UDP Service 的 Endpoint IP 发生变化**
3. **Service 被删除**

### 8.2 清理实现

```go
// 检测 UDP Service 的 stale 连接
for ip := range conntrackCleanupServiceIPs {
    if err := proxier.conntrack.ClearEntriesForIP(ip); err != nil {
        klog.ErrorS(err, "Failed to clear conntrack for IP", "ip", ip)
    }
}

for nodePort := range conntrackCleanupServiceNodePorts {
    if err := proxier.conntrack.ClearEntriesForPort(nodePort, v1.ProtocolUDP); err != nil {
        klog.ErrorS(err, "Failed to clear conntrack for nodePort", "nodePort", nodePort)
    }
}
```

---

## 9. 总结

### 9.1 iptables 模式核心机制

1. **规则生成**:
   - 为每个 Service 创建服务链(KUBE-SVC-XXX)
   - 为每个 Endpoint 创建端点链(KUBE-SEP-XXX)
   - 使用 statistic 模块实现随机负载均衡

2. **同步机制**:
   - BoundedFrequencyRunner 控制同步频率
   - iptables.Monitor 监控规则变化
   - 变更追踪器累积变更

3. **性能优化**:
   - 缓冲区复用
   - 概率预计算
   - 批量应用规则

### 9.2 关键要点

| 特性       | 说明                        |
|----------|---------------------------|
| **工作层级** | 内核态 (netfilter)           |
| **负载均衡** | 随机 (statistic 模块)         |
| **规则数量** | 线性增长 (Service × Endpoint) |
| **性能**   | 中等 (随规则数下降)               |
| **适用规模** | < 1000 Services           |

### 9.3 与 IPVS 对比

| 特性      | iptables | IPVS |
|---------|----------|------|
| **性能**  | 中        | 高    |
| **规则数** | 多        | 少    |
| **算法**  | 随机       | 多种   |
| **扩展性** | 差        | 好    |

---
