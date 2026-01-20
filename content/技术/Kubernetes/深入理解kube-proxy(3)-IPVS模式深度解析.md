---
title: "深入理解 kube-proxy(3)-IPVS 模式深度解析"
date: 2026-01-20T18:00:00+08:00
draft: false
tags: ["kubernetes", "源码解析", "kube-proxy", "ipvs"]
summary: "从基础到实践，深入理解 kube-proxy IPVS 模式的工作原理"
---

# 深入理解 kube-proxy(3) - IPVS 模式深度解析

---

## 1. IPVS 基础知识

在深入 kube-proxy 的 IPVS 实现之前，我们需要先理解一些基础概念。

### 1.1 什么是 IPVS

IPVS (IP Virtual Server) 是 Linux 内核层的负载均衡模块，基于 netfilter 框架实现。它是 LVS (Linux Virtual Server) 项目的核心组件。

**核心特性**:

1. **工作在内核态**: 性能极高，无需用户态参与
2. **哈希表查找**: O(1) 复杂度，不受规则数量影响
3. **多种调度算法**: 支持 RR、WRR、LC、WLC、DH、SH、SED、NQ 等
4. **连接复用**: 支持连接级别的会话保持
5. **规则简洁**: 相比 iptables，规则数量大幅减少

**与 iptables 的关系**:

```
IPVS 也是基于 netfilter 框架，但它使用专门的数据结构：
┌─────────────────────────────────────┐
│  netfilter 钩子点                    │
│  PREROUTING → INPUT → FORWARD       │
│                 ↓                   │
│         IPVS 内核模块                │
│                 ↓                   │
│         IPVS 虚拟服务器              │
│         (Virtual Server - VS)       │
│                 ↓                   │
│         IPVS 真实服务器              │
│         (Real Server - RS)          │
└─────────────────────────────────────┘
```

### 1.2 IPVS vs iptables

| 特性        | iptables           | IPVS            |
|-----------|--------------------|-----------------|
| **查找复杂度** | O(n) 线性查找          | O(1) 哈希查找       |
| **规则数量**  | Service × Endpoint | Service 数量      |
| **调度算法**  | 随机 (statistic)     | 多种算法可选          |
| **性能**    | 随服务数下降             | 恒定高性能           |
| **适用规模**  | < 1000 Services    | > 1000 Services |
| **连接追踪**  | 依赖 conntrack       | 内置连接表           |

**性能对比示例**:

```
场景: 100 个 Service，每个 Service 10 个 Endpoint

iptables 模式:
  - 规则数: 100 (KUBE-SVC) + 1000 (KUBE-SEP) = 1100 条
  - 每个包需要遍历: 最多 11 条规则
  - 查找时间: 随服务数量线性增长

IPVS 模式:
  - 规则数: 100 (Virtual Server)
  - 每个包需要: 1 次哈希查找
  - 查找时间: 恒定 O(1)
```

### 1.3 IPVS 工作模式

IPVS 支持三种工作模式，kube-proxy 使用 **NAT 模式**：

#### 1. NAT 模式

NAT 模式是 kube-proxy 使用的模式，请求和响应都经过 Director。

**完整数据流向示例**：

```
场景: Client (203.0.113.5) 访问 Service (10.96.0.10:80)

① 请求: 203.0.113.5:12345 → 10.96.0.10:80
   │
   ▼
┌────────────────┐
│  Director      │  (运行 IPVS 的节点)
│  (192.168.1.10)│
└────────────────┘
   │
   ├─▶ IPVS 查找 Virtual Server (10.96.0.10:80)
   │
   ├─▶ 应用调度算法选择 Real Server
   │     └─▶ 选择: 10.244.1.5:8080
   │
   └─▶ 执行 DNAT: 10.96.0.10 → 10.244.1.5
       │
       ▼
   转发: 203.0.113.5:12345 → 10.244.1.5:8080
       │
       ▼
┌────────────────┐
│ Real Server    │  (Pod)
│ (10.244.1.5)   │
└────────────────┘
   │
   └─▶ 处理请求
       │
       ▼
   响应: 10.244.1.5:8080 → 203.0.113.5:12345
   │
   ▼  (响应回到 Director，因为 Pod 的默认网关是节点)
┌────────────────┐
│  Director      │
└────────────────┘
   │
   ├─▶ conntrack 查找连接
   │
   └─▶ 反向 DNAT: 10.244.1.5 → 10.96.0.10
       │
       ▼
   响应: 10.96.0.10:80 → 203.0.113.5:12345
       │
       ▼
返回给 Client
```

**关键点**：

| 阶段                | 源地址               | 目标地址                | 说明         |
|-------------------|-------------------|---------------------|------------|
| Client → Director | 203.0.113.5:12345 | 10.96.0.10:80       | 初始请求       |
| DNAT 后            | 203.0.113.5:12345 | **10.244.1.5:8080** | 目标被修改      |
| Director → Pod    | 203.0.113.5:12345 | 10.244.1.5:8080     | 转发到 Pod    |
| Pod → Director    | 10.244.1.5:8080   | 203.0.113.5:12345   | Pod 响应     |
| 反向 DNAT 后         | **10.96.0.10:80** | 203.0.113.5:12345   | 源地址还原      |
| Director → Client | 10.96.0.10:80     | 203.0.113.5:12345   | 返回给 Client |

**特点**：
- 请求和响应都经过 Director
- 需要修改 IP 地址（DNAT 和反向 NAT）
- Real Server 可以在任何网络（通过 IP 路由）
- Real Server 的默认网关必须指向 Director


#### 2. DR 模式

DR 模式下，只有请求经过 Director，响应直接从 Real Server 返回给 Client。

**完整数据流向示例**：

```
场景: Client (203.0.113.5) 访问 VIP (10.96.0.10:80)

① 请求: 203.0.113.5:12345 → 10.96.0.10:80
   │
   ▼
┌────────────────────┐
│  Director          │
│  (VIP: 10.96.0.10) │
└────────────────────┘
   │
   ├─▶ IPVS 查找 Virtual Server (10.96.0.10:80)
   │
   ├─▶ 应用调度算法选择 Real Server
   │     └─▶ 选择: 10.244.1.5:80
   │
   └─▶ 只修改 MAC 地址 (不修改 IP 地址)
       │
       │ 数据包仍然:
       │ - 源: 203.0.113.5:12345
       │ - 目标: 10.96.0.10:80
       │ - 但目标 MAC 改为 Real Server 的 MAC
       │
       ▼
┌────────────────┐
│ Real Server    │
│ (10.244.1.5)   │  (配置了 VIP: 10.96.0.10)
└────────────────┘
   │
   ├─▶ 收到目标为 VIP 的包
   │
   └─▶ 处理请求
       │
       ▼
   ② 响应: 10.96.0.10:80 → 203.0.113.5:12345
       │  (注意：源地址是 VIP，不是 Pod IP)
       │
       ▼
   直接返回给 Client (不经过 Director)
```

**关键点**：

| 阶段                | 源地址               | 目标地址              | 说明          |
|-------------------|-------------------|-------------------|-------------|
| Client → Director | 203.0.113.5:12345 | 10.96.0.10:80     | 初始请求        |
| Director → RS     | 203.0.113.5:12345 | 10.96.0.10:80     | **只修改 MAC** |
| RS → Client       | **10.96.0.10:80** | 203.0.113.5:12345 | 直接返回        |

**特点**：
- 只有请求经过 Director，响应直接返回
- 只修改 MAC 地址，不修改 IP 地址
- Real Server 必须在同一网络段（二层互通）
- Real Server 需要配置 VIP（在 lo 接口上）
- 性能最好（响应不经过 Director）

#### 3. TUN 模式

TUN 模式使用 IP 隧道技术，Real Server 可以在不同网络。

**完整数据流向示例**：

```
场景: Client (203.0.113.5) 访问 VIP (10.96.0.10:80)

① 请求: 203.0.113.5:12345 → 10.96.0.10:80
   │
   ▼
┌────────────────┐
│  Director      │
└────────────────┘
   │
   ├─▶ IPVS 封装 IP 包
   │     └─▶ 原包: 203.0.113.5 → 10.96.0.10
   │     └─▶ 外层: DirectorIP → RealServerIP
   │
   ▼
   [IP 隧道]
   │  封装的包: DirectorIP → RealServerIP
   │  内层包: 203.0.113.5 → 10.96.0.10
   │
   ▼
┌────────────────┐
│ Real Server    │
│ (10.244.2.5)   │  (在不同网段)
└────────────────┘
   │
   ├─▶ 解封装 IP 包
   │     └─▶ 得到原包: 203.0.113.5 → 10.96.0.10
   │
   └─▶ 处理请求 (VIP 配置在隧道接口)
       │
       ▼
   ② 响应: 10.96.0.10:80 → 203.0.113.5:12345
       │
       ▼
   直接返回给 Client (不经过 Director)
```

**关键点**：

| 阶段                | 源地址               | 目标地址              | 说明          |
|-------------------|-------------------|-------------------|-------------|
| Client → Director | 203.0.113.5:12345 | 10.96.0.10:80     | 初始请求        |
| 封装后               | DirectorIP        | RealServerIP      | **IP 隧道封装** |
| 解封装后              | 203.0.113.5:12345 | 10.96.0.10:80     | 得到原包        |
| RS → Client       | **10.96.0.10:80** | 203.0.113.5:12345 | 直接返回        |

**特点**：
- 使用 IP 封装技术（IPIP 隧道）
- Real Server 可以在不同网络（通过隧道连接）
- Real Server 需要支持隧道协议
- 响应直接返回，不经过 Director
- 有额外的封装开销（增加 MTU）

**为什么 kube-proxy 选择 NAT 模式？**

1. **兼容性好**: 适用于所有网络环境
2. **配置简单**: 无需额外配置 VIP 或隧道
3. **节点分布**: Kubernetes 节点可能在不同网段
4. **Pod 网络**: Pod IP 与节点 IP 在不同网段

### 1.4 完整的数据包流向

让我们跟踪一个外部客户端访问 Kubernetes Service 的完整流程：

**场景：外部客户端访问 Service ClusterIP**

```
外部客户端 (203.0.113.5) 访问 Service ClusterIP (10.96.0.10:80)
  │
  │ 数据包: src=203.0.113.5, dst=10.96.0.10:80
  ▼
节点服务器
  │
  ├─▶ 1. PREROUTING 链
  │     │
  │     ├─▶ nat 表处理
  │     │     └─▶ -j KUBE-SERVICES
  │     │           │
  │     │           ▼
  │     │     KUBE-SERVICES 链
  │     │           │
  │     │           └─▶ 匹配 ClusterIP:Port
  │     │                 └─▶ ipset 匹配
  │     │                       │
  │     │                       ▼
  │     │                 IPVS 虚拟服务器
  │     │                       │
  │     │                       ├─▶ 调度算法选择
  │     │                       │   轮询/最小连接/哈希等
  │     │                       │
  │     │                       └─▶ 选择 Real Server
  │     │                             └─▶ 10.244.1.5:8080
  │     │
  │     ├─▶ 2. IPVS 处理
  │     │     │
  │     │     ├─▶ DNAT: 10.96.0.10:80 → 10.244.1.5:8080
  │     │     └─▶ 数据包变为: src=203.0.113.5, dst=10.244.1.5:8080
  │     │
  │     ├─▶ 3. 路由决策
  │     │     │
  │     │     └─▶ 目标为 Pod IP，需要转发
  │     │
  │     ├─▶ 4. FORWARD 链
  │     │     │
  │     │     └─▶ filter 表处理
  │     │           └─▶ -j KUBE-FORWARD
  │     │                 └─▶ 接受转发流量
  │     │
  │     ├─▶ 5. POSTROUTING 链
  │     │     │
  │     │     └─▶ nat 表处理
  │     │           └─▶ -j KUBE-POSTROUTING
  │     │                 └─▶ MASQUERADE (如果需要)
  │     │
  │     ▼
  发送到 Pod (10.244.1.5:8080)
  │
  │ Pod 处理请求并发送响应
  │ 数据包: src=10.244.1.5:8080, dst=203.0.113.5
  │
  ▼
节点服务器 (响应包)
  │
  ├─▶ 6. PREROUTING 链
  │     │
  │     └─▶ conntrack 自动识别连接
  │           │
  │           └─▶ 反向 DNAT (自动)
  │                 └─▶ 10.244.1.5:8080 → 10.96.0.10:80
  │
  ├─▶ 7. 路由决策
  │     │
  │     └─▶ 发送到外部网络
  │
  ▼
发送到外部客户端 (203.0.113.5)
```

**关键点总结**:

| 阶段                 | 源地址         | 目标地址                | 处理模块                  |
|--------------------|-------------|---------------------|-----------------------|
| 客户端发送              | 203.0.113.5 | 10.96.0.10:80       | -                     |
| PREROUTING         | 203.0.113.5 | 10.96.0.10:80       | iptables + ipset      |
| IPVS (DNAT)        | 203.0.113.5 | **10.244.1.5:8080** | IPVS 内核模块             |
| POSTROUTING (SNAT) | **节点IP**    | 10.244.1.5:8080     | iptables (MASQUERADE) |
| 到达 Pod             | 节点IP        | 10.244.1.5:8080     | -                     |

---

## 2. ipset 优化

### 2.1 什么是 ipset

ipset 是 Linux 内核的一个扩展，用于管理 IP 地址集合。它可以将大量 IP 地址存储在一个集合中，并在 iptables 规则中直接匹配整个集合。

**核心特性**:

1. **集合存储**: 将多个 IP 地址/端口存储在一个数据结构中
2. **高效匹配**: 使用哈希表或树结构，查找效率 O(1) 或 O(log n)
3. **动态更新**: 可以随时添加/删除成员，无需修改 iptables 规则
4. **内存共享**: 集合在内存中只有一份，多个规则可以引用

**ipset 类型**:

```bash
# 常用的 ipset 类型
hash:ip          # IP 地址哈希表
hash:ip,port     # IP:端口 哈希表
hash:net         # 网段哈希表
hash:net,port    # 网段:端口 哈希表
bitmap:ip        # IP 地址位图
bitmap:port      # 端口位图
```

### 2.2 为什么需要 ipset

**问题背景**:

在 IPVS 模式中，我们需要在 iptables 中快速匹配 Service IP，以便将流量交给 IPVS 处理。如果没有 ipset，我们需要：

```bash
# 不使用 ipset 的方式 (iptables 模式)
-A KUBE-SERVICES -d 10.96.0.10/32 -p tcp --dport 80 -j KUBE-SVC-XXX
-A KUBE-SERVICES -d 10.96.0.11/32 -p tcp --dport 443 -j KUBE-SVC-YYY
-A KUBE-SERVICES -d 10.96.0.12/32 -p tcp --dport 6379 -j KUBE-SVC-ZZZ
# ... 1000 条 Service 规则
```

这种方式的问题：
- 每个包都要遍历所有规则
- 规则数量随 Service 数量线性增长
- 添加/删除 Service 需要修改多条规则

**使用 ipset 的方式**:

```bash
# 创建 ipset
create KUBE-SERVICES hash:ip,port family inet

# 添加 Service 到 ipset
add KUBE-SERVICES 10.96.0.10,tcp:80
add KUBE-SERVICES 10.96.0.11,tcp:443
add KUBE-SERVICES 10.96.0.12,tcp:6379

# 在 iptables 中使用
-A KUBE-SERVICES -m set --match-set KUBE-SERVICES dst,dst -j KUBE-MARK-MASQ
```

优势：
- 只需要一条 iptables 规则
- ipset 查找是 O(1) 复杂度
- 动态添加/删除 Service 不需要修改 iptables

### 2.3 kube-proxy 中的 ipset 使用

**位置**: `pkg/proxy/ipvs/ipset.go`

kube-proxy 创建多个 ipset 来存储不同类型的 Service 地址：

```go
// pkg/proxy/ipvs/ipset.go:46-82
const (
    // 存储 ClusterIP + 协议 + 端口
    kubeIPSetClusterIP       utilipset.Type = "KUBE-SERVICES"        // hash:ip,port
    
    // 存储 ExternalIP + 协议 + 端口
    kubeIPSetExternalIP      utilipset.Type = "KUBE-EXTERNAL-IP"     // hash:ip,port
    
    // 存储 LoadBalancerIP + 协议 + 端口
    kubeIPSetLoadBalancer    utilipset.Type = "KUBE-LOAD-BALANCER"   // hash:ip,port
    
    // 存储 NodePort + 协议 + 端口
    kubeIPSetNodePort        utilipset.Type = "KUBE-NODE-PORT"       // bitmap:port
)
```

**ipset 创建示例**:

```bash
# 查看 kube-proxy 创建的 ipset
$ ipset list

Name: KUBE-SERVICES
Type: hash:ip,port
Revision: 6
Header: family inet hashsize 1024 maxelem 65536
Size in memory: 704
References: 2
Members:
10.96.0.10,tcp:80
10.96.0.11,tcp:443
10.96.0.12,tcp:6379

Name: KUBE-EXTERNAL-IP
Type: hash:ip,port
Revision: 6
Header: family inet hashsize 1024 maxelem 65536
Size in memory: 512
References: 1
Members:
203.0.113.10,tcp:80
203.0.113.11,tcp:443

Name: KUBE-NODE-PORT
Type: bitmap:port
Revision: 3
Header: range 0-65535
Size in memory: 8192
References: 1
Members:
30080
30443
30876
```

**iptables 规则中使用 ipset**:

```bash
# PREROUTING 链
-A PREROUTING -m comment --comment "kubernetes service portals" \
  -m set --match-set KUBE-SERVICES dst,dst -j KUBE-MARK-MASQ

# OUTPUT 链
-A OUTPUT -m comment --comment "kubernetes service portals" \
  -m set --match-set KUBE-SERVICES dst,dst -j KUBE-MARK-MASQ
```

**动态更新 ipset**:

```go
// pkg/proxy/ipvs/ipset.go:140-180
func (s *IPSet) validateAndAddIPSetEntry(entry *utilipset.Entry) error {
    // 检查 ipset 是否存在，不存在则创建
    if _, err := s.execIPSetCommand("create", ...); err != nil {
        // ipset 已存在，忽略错误
    }
    
    // 添加条目到 ipset
    if _, err := s.execIPSetCommand("add", 
        entry.Set, 
        entry.Net.String(), 
        "protocol", entry.Protocol,
        entry.Port); err != nil {
        return err
    }
    
    return nil
}
```

**性能对比**:

```
场景: 1000 个 Service

不使用 ipset:
  - iptables 规则: 1000 条
  - 匹配时间: O(n)，平均遍历 500 条
  - 更新时间: 需要重新加载 iptables 规则

使用 ipset:
  - iptables 规则: 1 条 (匹配 ipset)
  - 匹配时间: O(1)，哈希查找
  - 更新时间: 动态添加/删除 ipset 条目
```

---
## 3. IPVS 模式概述

### 3.1 工作原理

IPVS 模式通过结合 iptables、ipset 和 IPVS 内核模块实现高性能负载均衡。

**核心组件协作**:

```
┌─────────────────────────────────────────────────────────────┐
│                    kube-proxy IPVS 模式                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. iptables (nat 表)                                       │
│     - PREROUTING: 匹配 Service IP                           │
│     - 使用 ipset 快速匹配                                    │
│     - 标记需要 IPVS 处理的流量                              │
│                                                             │
│  2. ipset                                                    │
│     - 存储 Service IP:Port 集合                             │
│     - KUBE-SERVICES (ClusterIP)                             │
│     - KUBE-EXTERNAL-IP (ExternalIP)                         │
│     - KUBE-LOAD-BALANCER (LoadBalancerIP)                   │
│     - KUBE-NODE-PORT (NodePort)                             │
│                                                             │
│  3. IPVS 内核模块                                            │
│     - 维护 Virtual Server (VS) 和 Real Server (RS)          │
│     - 执行 DNAT: VIP → RIP                                   │
│     - 应用调度算法选择后端                                   │
│     - 管理连接表                                             │
│                                                             │
│  4. conntrack                                                │
│     - 追踪连接状态                                           │
│     - 自动反向 NAT                                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**简单比喻**:

```
IPVS 模式就像是一个"智能快递分拣中心"：

1. iptables = 入口安检
   - 检查包裹地址是否在服务列表 (ipset)
   - 给需要特殊处理的包裹打标记

2. ipset = 地址簿
   - 快速查找哪些地址需要特殊处理
   - O(1) 哈希查找，不需要遍历所有规则

3. IPVS = 分拣系统
   - 根据调度算法选择快递员 (Real Server)
   - 修改包裹地址 (DNAT)
   - 记录每个快递员的工作量

4. conntrack = 包裹追踪
   - 记录包裹的去向
   - 确保回程包裹能正确返回
```

### 3.2 数据流向

**入站流量**:

```
外部请求
  │
  ▼
PREROUTING 链
  │
  ├─▶ 匹配 ipset (KUBE-SERVICES)
  │     │
  │     └─▶ 命中 → 标记数据包 (KUBE-MARK-MASQ)
  │
  ├─▶ IPVS 处理
  │     │
  │     ├─▶ 查找 Virtual Server
  │     │     └─▶ 哈希查找，O(1) 复杂度
  │     │
  │     ├─▶ 应用调度算法
  │     │     ├─▶ Round Robin
  │     │     ├─▶ Weighted Round Robin
  │     │     ├─▶ Least Connection
  │     │     ├─▶ Weighted Least Connection
  │     │     ├─▶ Destination Hashing
  │     │     └─▶ Source Hashing
  │     │
  │     └─▶ 选择 Real Server
  │           └─▶ 执行 DNAT: VIP → RIP
  │
  ├─▶ 路由决策
  │
  ├─▶ FORWARD 链
  │     └─▶ 允许转发
  │
  └─▶ POSTROUTING 链
        └─▶ MASQUERADE (如果需要)
              │
              ▼
到达 Pod
```

**出站流量**:

```
Pod 响应
  │
  ▼
POSTROUTING 链
  │
  └─▶ conntrack 自动识别
        │
        └─▶ 反向 DNAT (自动)
              │
              ▼
返回客户端
```

### 3.3 优缺点分析

**优点**:

| 特性        | 说明                              |
|-----------|---------------------------------|
| **高性能**   | O(1) 哈希查找，性能不受服务数量影响            |
| **规则简洁**  | 只有 Service 数量的规则，无需 Endpoint 规则 |
| **灵活调度**  | 支持多种调度算法，适应不同场景                 |
| **连接复用**  | 内置连接表，支持会话保持                    |
| **动态更新**  | ipset 支持动态增删，无需重载规则             |
| **大规模适用** | 适合数千个 Service 的集群               |

**缺点**:

| 特性        | 说明                           |
|-----------|------------------------------|
| **内核依赖**  | 需要 IPVS 内核模块支持               |
| **配置复杂**  | 相比 iptables 模式配置更复杂          |
| **调试困难**  | IPVS 规则不如 iptables 直观        |
| **额外依赖**  | 依赖 ipset 工具                  |
| **小集群过重** | 对于小集群 (< 100 Services) 优势不明显 |

**适用场景**:

```
使用 IPVS 模式:
  ✓ 大规模集群 (> 1000 Services)
  ✓ 需要特定调度算法 (如源地址哈希)
  ✓ 对性能要求高
  ✓ Service 频繁变更

使用 iptables 模式:
  ✓ 小规模集群 (< 500 Services)
  ✓ 简单部署场景
  ✓ 调试和排错需求高
  ✓ 不依赖额外内核模块
```

---

## 4. Proxier 初始化

### 4.1 创建 Proxier

**位置**: `pkg/proxy/ipvs/proxier.go:346-507`

NewProxier 创建 IPVS 模式的 Proxier 实例，初始化所有必要的状态和同步机制。

```go
func NewProxier(
    ipt utiliptables.Interface,       // iptables 接口
    ipvs utilipvs.Interface,          // IPVS 接口
    ipset utilipset.Interface,        // ipset 接口
    sysctl utilsysctl.Interface,      // sysctl 接口
    exec utilexec.Interface,          // 命令执行接口
    syncPeriod time.Duration,          // 同步周期
    minSyncPeriod time.Duration,       // 最小同步周期
    excludeCIDRs []string,            // 排除的 CIDR
    strictARP bool,                   // 严格 ARP 模式
    tcpTimeout time.Duration,          // TCP 超时
    tcpFinTimeout time.Duration,       // TCP FIN 超时
    udpTimeout time.Duration,          // UDP 超时
    masqueradeAll bool,               // 是否对所有流量做 MASQUERADE
    masqueradeBit int,                // MASQUERADE 标记位
    localDetector proxyutiliptables.LocalTrafficDetector,
    hostname string,                  // 主机名
    nodeIP net.IP,                    // 节点 IP
    recorder events.EventRecorder,    // 事件记录器
    healthzServer healthcheck.ProxierHealthUpdater,
    nodePortAddresses []string,       // NodePort 地址
) (*Proxier, error) {
    
    // 1. 创建 ipset 管理器
    ipset := ipset.New(exec)
    
    // 2. 初始化所有需要的 ipset
    for _, set := range []utilipset.Set{
        {Name: string(kubeIPSetClusterIP), Type: utilipset.HashIPPort},
        {Name: string(kubeIPSetExternalIP), Type: utilipset.HashIPPort},
        {Name: string(kubeIPSetLoadBalancer), Type: utilipset.HashIPPort},
        {Name: string(kubeIPSetNodePort), Type: utilipset.BitmapPort},
    } {
        if _, err := ipset.CreateSet(set, true); err != nil {
            klog.ErrorS(err, "Failed to create ipset", "set", set.Name)
        }
    }
    
    // 3. 配置 IPVS 参数
    if err := ipvs.Flush(); err != nil {
        return nil, fmt.Errorf("failed to flush IPVS: %v", err)
    }
    
    // 4. 创建 Proxier 实例
    proxier := &Proxier{
        ipvs:                   ipvs,
        ipset:                  ipset,
        iptables:               ipt,
        serviceMap:             make(proxy.ServiceMap),
        endpointsMap:           make(proxy.EndpointsMap),
        serviceChanges:         proxy.NewServiceChangeTracker(...),
        endpointsChanges:       proxy.NewEndpointChangeTracker(...),
        syncPeriod:             syncPeriod,
        mu:                     sync.Mutex{},
        servicesSynced:         false,
        endpointsSynced:        false,
        // ...
    }
    
    // 5. 启动同步循环
    proxier.syncRunner = async.NewBoundedFrequencyRunner(
        "sync-runner",
        proxier.syncProxyRules,
        minSyncPeriod,
        time.Hour,
        burstSyncs,
    )
    
    // 6. 启动 ipset 监控
    go proxier.ipset.Monitor(..., proxier.syncRunner.Run)
    
    // 7. 启动 iptables 监控
    go ipt.Monitor(..., proxier.syncRunner.Run)
    
    return proxier, nil
}
```

**关键步骤说明**:

1. **ipset 初始化**: 创建 4 个 ipset 用于存储不同类型的 Service 地址
2. **IPVS 清空**: 清空所有现有的 IPVS 规则
3. **状态管理**: 初始化 Service 和 Endpoint 的映射表
4. **同步机制**: 创建 BoundedFrequencyRunner 控制同步频率
5. **监控启动**: 监控 ipset 和 iptables 变化，触发同步

---

## 5. 核心数据结构

### 5.1 Proxier 结构体

**位置**: `pkg/proxy/ipvs/proxier.go:130-215`

```go
type Proxier struct {
    // IPVS 接口
    ipvs utilipvs.Interface
    
    // ipset 接口
    ipset utilipset.Interface
    
    // iptables 接口
    iptables utiliptables.Interface
    
    // Service 和 Endpoint 映射
    serviceMap     proxy.ServiceMap
    endpointsMap   proxy.EndpointsMap
    
    // 变更追踪
    serviceChanges   *proxy.ServiceChangeTracker
    endpointsChanges *proxy.EndpointChangeTracker
    
    // 同步控制
    syncRunner async.BoundedFrequencyRunner
    syncPeriod time.Duration
    
    // 配置
    masqueradeAll bool
    masqueradeMark string
    excludeCIDRs   []string
    
    // 同步状态
    servicesSynced  bool
    endpointsSynced bool
    
    // 缓冲区
    iptablesData    bytes.Buffer
    filterChains    bytes.Buffer
    filterRules     bytes.Buffer
    natChains       bytes.Buffer
    natRules        bytes.Buffer
    
    // ...
}
```

**设计要点**:

1. **接口抽象**: 使用接口抽象 IPVS、ipset、iptables，便于测试和替换实现
2. **变更追踪**: 使用 ChangeTracker 累积变更，减少不必要的同步
3. **缓冲复用**: 使用 bytes.Buffer 缓存规则，避免频繁内存分配
4. **状态同步**: 使用 BoundedFrequencyRunner 控制同步频率

---

## 6. 规则同步机制

### 6.1 syncProxyRules 主流程

**位置**: `pkg/proxy/ipvs/proxier.go:620-920`

```go
func (proxier *Proxier) syncProxyRules() {
    proxier.mu.Lock()
    defer proxier.mu.Unlock()
    
    // 1. 检查初始化状态
    if !proxier.servicesSynced || !proxier.endpointsSynced {
        klog.V(2).InfoS("Not syncing ipvs until Services and Endpoints have been received")
        return
    }
    
    // 2. 更新 Service 和 Endpoint 映射
    serviceUpdateResult := proxier.serviceMap.Update(proxier.serviceChanges)
    endpointUpdateResult := proxier.endpointsMap.Update(proxier.endpointsChanges)
    
    // 3. 清理 conntrack (针对 UDP)
    conntrackCleanupServiceIPs := serviceUpdateResult.UDPStaleClusterIP
    // ... 类似 iptables 模式的 conntrack 清理逻辑
    
    // 4. 同步 ipset
    proxier.syncIpsets(proxier.serviceMap)
    
    // 5. 同步 IPVS Virtual Server 和 Real Server
    proxier.syncIpvsRules(proxier.serviceMap, proxier.endpointsMap)
    
    // 6. 同步 iptables 规则
    proxier.syncIptablesRules()
    
    // 7. 清理 conntrack
    proxier.cleanupConntrack(conntrackCleanupServiceIPs)
}
```

### 6.2 BoundedFrequencyRunner

与 iptables 模式相同，IPVS 模式也使用 BoundedFrequencyRunner 控制同步频率。

**工作方式**:

```
有事件时:
  事件到达 → 等待 minSyncPeriod → 执行 syncProxyRules()
                                    (最多 burstSyncs 次突发)
  
无事件时:
  上次同步 → 等待 syncPeriod → 执行 syncProxyRules()
```

---

## 7. IPVS 服务配置

### 7.1 Virtual Server 配置

**位置**: `pkg/proxy/ipvs/proxier.go:950-1100`

kube-proxy 为每个 Kubernetes Service 创建一个 IPVS Virtual Server。

```go
func (proxier *Proxier) syncIpvsRules(serviceMap proxy.ServiceMap, endpointsMap proxy.EndpointsMap) {
    
    // 1. 遍历所有 Service
    for svcName, svc := range serviceMap {
        
        // 2. 创建 Virtual Server
        virtualServer := &utilipvs.VirtualServer{
            Address:   svc.ClusterIP().String(),
            Port:      svc.Port(),
            Protocol:  string(svc.Protocol()),
            Scheduler: proxier.scheduler,  // 调度算法
        }
        
        // 3. 配置调度参数
        if svc.SessionAffinityType() == v1.ServiceAffinityClientIP {
            // 启用会话保持
            virtualServer.Flags |= utilipvs.IP_VS_SVC_F_PERSISTENT
            virtualServer.Timeout = uint32(svc.StickyMaxAgeSeconds())
        }
        
        // 4. 添加到 IPVS
        if err := proxier.ipvs.AddVirtualServer(virtualServer); err != nil {
            klog.ErrorS(err, "Failed to add VirtualServer", "service", svcName)
            continue
        }
        
        // 5. 获取该 Service 的 Endpoints
        endpoints := endpointsMap[svcName]
        
        // 6. 为每个 Endpoint 创建 Real Server
        for _, ep := range endpoints {
            realServer := &utilipvs.RealServer{
                Address:  ep.IP(),
                Port:     ep.Port(),
                Weight:   ep.Weight(),  // 权重
                Mode:     "NAT",         // 工作模式
            }
            
            // 7. 添加 Real Server 到 Virtual Server
            if err := proxier.ipvs.AddRealServer(virtualServer, realServer); err != nil {
                klog.ErrorS(err, "Failed to add RealServer", "endpoint", ep)
            }
        }
    }
    
    // 8. 清理已删除的 Service
    proxier.cleanupStaleServices(serviceMap)
}
```

**IPVS Virtual Server 示例**:

```bash
# 查看 IPVS Virtual Server
$ ipvsadm -Ln

IP Virtual Server version 1.2.1 (size=4096)
Prot LocalAddress:Port Scheduler Flags
  -> RemoteAddress:Port           Forward Weight ActiveConn InActConn
TCP  10.96.0.10:80 rr
  -> 10.244.1.5:8080              Masq    1      0          0
  -> 10.244.2.5:8080              Masq    1      0          0
  -> 10.244.3.5:8080              Masq    1      0          0

TCP  10.96.0.11:443 rr persistent 300
  -> 10.244.1.6:8443              Masq    1      0          0
  -> 10.244.2.6:8443              Masq    1      0          0
```

**字段说明**:

| 字段                     | 说明                                 |
|------------------------|------------------------------------|
| **Prot**               | 协议 (TCP/UDP/SCTP)                  |
| **LocalAddress:Port**  | Virtual Server 地址 (ClusterIP:Port) |
| **Scheduler**          | 调度算法 (rr/wrr/lc/wlc/dh/sh/sed/nq)  |
| **Flags**              | 标志 (persistent 表示会话保持)             |
| **RemoteAddress:Port** | Real Server 地址 (PodIP:Port)        |
| **Forward**            | 转发模式 (Masq = NAT)                  |
| **Weight**             | 权重 (用于加权调度)                        |
| **ActiveConn**         | 活跃连接数                              |
| **InActConn**          | 非活跃连接数                             |

### 7.2 Real Server 配置

Real Server 代表后端 Pod，每个 Virtual Server 可以有多个 Real Server。

```go
type RealServer struct {
    Address string   // Pod IP
    Port    uint16   // Pod Port
    Weight  int      // 权重 (0-65535)
    Mode    string   // 工作模式 ("NAT", "DR", "TUN")
}
```

**权重配置**:

```bash
# 配置不同权重的 Real Server
TCP  10.96.0.10:80 wrr
  -> 10.244.1.5:8080   Masq    3      0          0    # 权重 3
  -> 10.244.2.5:8080   Masq    2      0          0    # 权重 2
  -> 10.244.3.5:8080   Masq    1      0          0    # 权重 1

# wrr (Weighted Round Robin) 会按权重分配请求：
# - Pod1:Pod2:Pod3 = 3:2:1
# - 每 6 个请求中，3 个去 Pod1，2 个去 Pod2，1 个去 Pod3
```

### 7.3 配置流程详解

**完整流程**:

```
1. Service 变更
   │
   ▼
2. 更新 serviceMap
   │
   ▼
3. 同步 ipset
   │  - 添加 Service IP 到 KUBE-SERVICES
   │  - 添加 ExternalIP 到 KUBE-EXTERNAL-IP
   │  - 添加 LoadBalancerIP 到 KUBE-LOAD-BALANCER
   │  - 添加 NodePort 到 KUBE-NODE-PORT
   │
   ▼
4. 创建 Virtual Server
   │  - 检查 VS 是否存在
   │  - 不存在则创建
   │  - 存在则更新配置
   │
   ▼
5. 获取 Endpoints
   │
   ▼
6. 更新 Real Server
   │  - 添加新的 Endpoint
   │  - 更新已存在的 Endpoint
   │  - 删除已移除的 Endpoint
   │
   ▼
7. 同步 iptables 规则
   │  - 确保基础链存在
   │  - 确保跳转规则存在
   │
   ▼
8. 清理 conntrack (UDP)
   │
   ▼
完成
```

**错误处理**:

```go
// 处理 Virtual Server 创建失败
if err := proxier.ipvs.AddVirtualServer(vs); err != nil {
    if strings.Contains(err.Error(), "already exists") {
        // VS 已存在，更新配置
        if err := proxier.ipvs.UpdateVirtualServer(vs); err != nil {
            klog.ErrorS(err, "Failed to update VirtualServer")
        }
    } else {
        klog.ErrorS(err, "Failed to add VirtualServer")
    }
}

// 处理 Real Server 添加失败
for _, rs := range realServers {
    if err := proxier.ipvs.AddRealServer(vs, rs); err != nil {
        if !strings.Contains(err.Error(), "already exists") {
            // 真正的错误，记录日志
            klog.ErrorS(err, "Failed to add RealServer", "realServer", rs)
        }
        // 已存在，忽略错误（幂等操作）
    }
}
```

---

## 8. 调度算法

### 8.1 支持的算法

IPVS 支持多种调度算法，kube-proxy 默认使用 `rr` (Round Robin)。

| 算法      | 名称                      | 说明      | 适用场景    |
|---------|-------------------------|---------|---------|
| **rr**  | Round Robin             | 轮询，依次分配 | 服务器性能相近 |
| **wrr** | Weighted RR             | 加权轮询    | 服务器性能不同 |
| **lc**  | Least Connection        | 最少连接    | 长连接服务   |
| **wlc** | Weighted LC             | 加权最少连接  | 服务器性能不同 |
| **dh**  | Destination Hashing     | 目标地址哈希  | 需要会话保持  |
| **sh**  | Source Hashing          | 源地址哈希   | 需要会话保持  |
| **sed** | Shortest Expected Delay | 最短期望延迟  | 考虑服务器负载 |
| **nq**  | Never Queue             | 从不排队    | 避免队列等待  |

**算法选择**:

```go
// pkg/proxy/ipvs/proxier.go:100-120
type Scheduler struct {
    Algorithm string
}

func NewScheduler(scheduler string) *Scheduler {
    return &Scheduler{
        Algorithm: scheduler,  // 默认 "rr"
    }
}

// Kubernetes 支持通过 annotation 指定调度算法
// annotation: service.kubernetes.io/ipvs-scheduler: "wlc"
```

### 8.2 算法详解

#### 1. Round Robin (rr)

```
请求序列: 1 2 3 4 5 6 1 2 3 4 5 6 ...
后端:    A B C A B C A B C A B C ...

特点:
- 简单公平
- 适合后端性能相同
- 不考虑连接数
```

#### 2. Weighted Round Robin (wrr)

```
后端权重: A=3, B=2, C=1
请求序列: A A A B B C A A A B B C ...

特点:
- 考虑后端性能差异
- 权重越高，分配越多请求
- 需要手动配置权重
```

#### 3. Least Connection (lc)

```
连接数:
  A: 10 个连接
  B: 5 个连接
  C: 2 个连接

新请求 → C (选择连接数最少的)

特点:
- 动态负载均衡
- 适合长连接服务
- 考虑实际负载
```

#### 4. Destination Hashing (dh)

```
请求目标: 10.96.0.10:80
哈希计算: hash(10.96.0.10:80) % N = 2
后端选择: RealServer[2]

特点:
- 相同目标总是映射到同一后端
- 提高缓存命中率
- 适合缓存服务
```

#### 5. Source Hashing (sh)

```
请求源: 203.0.113.5:12345
哈希计算: hash(203.0.113.5) % N = 1
后端选择: RealServer[1]

特点:
- 相同客户端总是访问同一后端
- 实现会话保持
- 适合有状态服务
```

**性能对比**:

```
场景: 1000 个并发连接，3 个后端

rr (Round Robin):
  - 连接分配: 333, 333, 334
  - CPU 开销: 低
  - 适用: 短连接，性能相近

lc (Least Connection):
  - 连接分配: 200, 300, 500 (取决于处理速度)
  - CPU 开销: 中 (需要统计连接数)
  - 适用: 长连接，性能差异大

sh (Source Hash):
  - 连接分配: 取决于客户端 IP 分布
  - CPU 开销: 中 (需要哈希计算)
  - 适用: 需要会话保持
```

---

## 9. 性能优化

### 9.1 连接复用

IPVS 内置连接表，支持连接级别的会话保持。

```go
// 启用持久化连接
virtualServer.Flags |= utilipvs.IP_VS_SVC_F_PERSISTENT
virtualServer.Timeout = uint32(svc.StickyMaxAgeSeconds())
```

**连接表示例**:

```bash
# 查看 IPVS 连接
$ ipvsadm -Lnc

IPVS connection entries
pro expire state       source             virtual            destination
TCP 01:58  ESTABLISHED 203.0.113.5:12345 10.96.0.10:80      10.244.1.5:8080
TCP 02:30  ESTABLISHED 203.0.113.6:54321 10.96.0.10:80      10.244.2.5:8080
```

**优势**:

1. **减少调度开销**: 同一连接的后续包无需重新调度
2. **提高缓存命中率**: 同一客户端总是访问同一后端
3. **降低连接数**: 复用 TCP 连接，减少三次握手

### 9.2 哈希查找

IPVS 使用哈希表存储 Virtual Server，查找时间复杂度 O(1)。

```c
// 内核数据结构 (简化)
struct ip_vs_service {
    __u16                   protocol;     // 协议
    __be32                  addr;         // VIP
    __be16                  port;         // Port
    struct ip_vs_scheduler  *scheduler;   // 调度器
    struct hlist_node       s_list;       // 哈希链表
};

// 哈希查找
struct ip_vs_service *ip_vs_lookup_service(u32 af, __u16 protocol, __be32 port, __be32 addr) {
    // 计算哈希值
    unsigned hash = hash_key(af, protocol, port, addr);
    
    // O(1) 查找
    hlist_for_each_entry(svc, &ip_vs_svc_table[hash], s_list) {
        if (svc->protocol == protocol && 
            svc->addr == addr && 
            svc->port == port) {
            return svc;  // 找到
        }
    }
    return NULL;  // 未找到
}
```

**性能对比**:

```
场景: 1000 个 Virtual Server

iptables 模式:
  - 规则数: 1000 条
  - 查找时间: O(n)，平均 500 次比较
  - CPU 周期: ~500

IPVS 模式:
  - Virtual Server 数: 1000
  - 哈希桶数: 4096 (默认)
  - 查找时间: O(1)，平均 1-2 次比较
  - CPU 周期: ~2
```

### 9.3 规则简化

使用 ipset 大幅简化 iptables 规则。

**iptables 模式**:

```bash
# 需要为每个 Service 创建规则
-A KUBE-SERVICES -d 10.96.0.10/32 -p tcp --dport 80 -j KUBE-SVC-XXX
-A KUBE-SERVICES -d 10.96.0.11/32 -p tcp --dport 443 -j KUBE-SVC-YYY
# ... 1000 条规则
```

**IPVS 模式**:

```bash
# 只需要一条规则匹配 ipset
-A PREROUTING -m set --match-set KUBE-SERVICES dst,dst -j KUBE-MARK-MASQ

# ipset 内容 (O(1) 查找)
KUBE-SERVICES:
  10.96.0.10,tcp:80
  10.96.0.11,tcp:443
  # ... 1000 个条目
```

**内存占用**:

```
场景: 1000 个 Service

iptables 模式:
  - 规则内存: ~100 KB (每条规则 ~100 字节)
  - 查找时间: O(n)

IPVS 模式:
  - ipset 内存: ~50 KB (哈希表，每个条目 ~50 字节)
  - iptables 规则: 1 条 (~100 字节)
  - 查找时间: O(1)
```

---

## 10. 总结

### 10.1 IPVS 模式核心机制

IPVS 模式通过以下核心机制实现高性能负载均衡：

```
1. ipset 优化
   - O(1) 哈希查找
   - 动态更新，无需重载规则
   - 减少 iptables 规则数量

2. IPVS 内核模块
   - Virtual Server 管理服务
   - Real Server 管理后端
   - 内置连接表，支持会话保持

3. 多种调度算法
   - RR/WRR: 轮询
   - LC/WLC: 最少连接
   - DH/SH: 哈希
   - 适应不同场景需求

4. iptables 辅助
   - 标记需要 IPVS 处理的流量
   - 处理 MASQUERADE
   - 过滤非法连接
```

### 10.2 关键要点

| 特性        | 说明                         |
|-----------|----------------------------|
| **工作层级**  | 内核态 (IPVS 模块)              |
| **查找复杂度** | O(1) 哈希查找                  |
| **规则数量**  | Service 数量 (ipset 动态管理)    |
| **调度算法**  | RR/WRR/LC/WLC/DH/SH/SED/NQ |
| **性能**    | 恒定高性能，不受服务数影响              |
| **适用规模**  | > 1000 Services            |

### 10.3 与 iptables 对比

| 维度       | iptables        | IPVS                    |
|----------|-----------------|-------------------------|
| **性能**   | 随服务数下降          | 恒定高性能                   |
| **规模**   | < 1000 Services | > 1000 Services         |
| **复杂度**  | 简单              | 中等                      |
| **灵活性**  | 仅随机调度           | 多种调度算法                  |
| **依赖**   | 纯 iptables      | IPVS + ipset + iptables |
| **适用场景** | 小集群             | 大规模集群                   |

**选择建议**:

```
小规模集群 (< 500 Services)
  → 使用 iptables 模式
  → 优势：简单、易调试、无额外依赖

中等规模 (500-2000 Services)
  → 建议使用 IPVS 模式
  → 优势：性能更好、支持更多调度算法

大规模集群 (> 2000 Services)
  → 必须使用 IPVS 模式
  → 优势：O(1) 查找、规则简化、性能恒定
```

---

## 附录 A: IPVS 使用的 ipset 集合

kube-proxy IPVS 模式使用多个 ipset 集合来优化 iptables 规则：

| 集合名称                               | 成员                                         | 用途                             |
|------------------------------------|--------------------------------------------|--------------------------------|
| **KUBE-CLUSTER-IP**                | 所有 Service IP + Port                       | 标记需要 MASQUERADE 的 ClusterIP 流量 |
| **KUBE-LOOP-BACK**                 | 所有 Service IP + Port + IP                  | 处理 hairpin 流量的 MASQUERADE      |
| **KUBE-EXTERNAL-IP**               | Service ExternalIP + Port                  | ExternalIP 流量的 MASQUERADE      |
| **KUBE-LOAD-BALANCER**             | LoadBalancer Ingress IP + Port             | LoadBalancer 流量的 MASQUERADE    |
| **KUBE-LOAD-BALANCER-LOCAL**       | LB IP + Port (externalTrafficPolicy=local) | 接受本地流量                         |
| **KUBE-LOAD-BALANCER-FW**          | LB IP + Port (loadBalancerSourceRanges)    | 流量过滤                           |
| **KUBE-LOAD-BALANCER-SOURCE-CIDR** | LB IP + Port + source CIDR                 | 源地址过滤                          |
| **KUBE-NODE-PORT-TCP**             | NodePort TCP 端口                            | NodePort TCP 流量的 MASQUERADE    |
| **KUBE-NODE-PORT-LOCAL-TCP**       | NodePort TCP (externalTrafficPolicy=local) | 接受本地 NodePort 流量               |
| **KUBE-NODE-PORT-UDP**             | NodePort UDP 端口                            | NodePort UDP 流量的 MASQUERADE    |
| **KUBE-NODE-PORT-LOCAL-UDP**       | NodePort UDP (externalTrafficPolicy=local) | 接受本地 NodePort 流量               |

**查看 ipset 内容**:

```bash
# 查看所有 ipset
$ ipset list

Name: KUBE-CLUSTER-IP
Type: hash:ip,port
Revision: 6
Header: family inet hashsize 1024 maxelem 65536
Size in memory: 704
References: 2
Members:
10.96.0.10,tcp:80
10.96.0.11,tcp:443

Name: KUBE-NODE-PORT-TCP
Type: bitmap:port
Revision: 3
Header: range 0-65535
Size in memory: 8192
References: 1
Members:
30080
30443
```

## 附录 B: IPVS 回退到 iptables 的场景

IPVS 模式在以下 5 种场景下会使用 iptables：

### 1. masquerade-all=true

当 kube-proxy 以 `--masquerade-all=true` 启动时，所有访问 ClusterIP 的流量都会被 MASQUERADE。

```bash
Chain KUBE-SERVICES (2 references)
target     prot opt source               destination
KUBE-MARK-MASQ  all  --  0.0.0.0/0            0.0.0.0/0            match-set KUBE-CLUSTER-IP dst,dst
ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0            match-set KUBE-CLUSTER-IP dst,dst
```

### 2. 指定 cluster-cidr

当指定 `--cluster-cidr=<cidr>` 时，来自集群外部的访问 ClusterIP 流量会被 MASQUERADE。

```bash
Chain KUBE-SERVICES (2 references)
target     prot opt source               destination
KUBE-MARK-MASQ  all  --  !10.244.16.0/24      0.0.0.0/0            match-set KUBE-CLUSTER-IP dst,dst
ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0            match-set KUBE-CLUSTER-IP dst,dst
```

### 3. LoadBalancer 类型 Service

LoadBalancer Service 会创建 KUBE-LOAD-BALANCER 相关的 ipset 和规则。

```bash
Chain KUBE-LOAD-BALANCER (1 references)
target     prot opt source               destination
KUBE-FIREWALL  all  --  0.0.0.0/0            0.0.0.0/0            match-set KUBE-LOAD-BALANCER-FW dst,dst
RETURN     all  --  0.0.0.0/0            0.0.0.0/0            match-set KUBE-LOAD-BALANCER-LOCAL dst,dst
KUBE-MARK-MASQ  all  --  0.0.0.0/0            0.0.0.0/0
```

### 4. NodePort 类型 Service

NodePort Service 会创建 KUBE-NODE-PORT-TCP/UDP 相关的 ipset。

```bash
Chain KUBE-NODE-PORT (1 references)
target     prot opt source               destination
RETURN     all  --  0.0.0.0/0            0.0.0.0/0            match-set KUBE-NODE-PORT-LOCAL-TCP dst
KUBE-MARK-MASQ  all  --  0.0.0.0/0            0.0.0.0/0
```

### 5. ExternalIP Service

Service 指定 externalIPs 时，会创建 KUBE-EXTERNAL-IP ipset。

```bash
Chain KUBE-SERVICES (2 references)
target     prot opt source               destination
KUBE-MARK-MASQ  all  --  0.0.0.0/0            0.0.0.0/0            match-set KUBE-EXTERNAL-IP dst,dst
ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0            match-set KUBE-EXTERNAL-IP dst,dst PHYSDEV match ! --physdev-is-in ADDRTYPE match src-type !LOCAL
ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0            match-set KUBE-EXTERNAL-IP dst,dst ADDRTYPE match dst-type LOCAL
```

## 附录 C: 内核模块依赖

IPVS 模式需要以下内核模块：

```bash
# 必需模块
ip_vs                  # IPVS 核心模块
ip_vs_rr              # Round Robin 调度
ip_vs_wrr             # Weighted Round Robin 调度
ip_vs_sh              # Source Hashing 调度
nf_conntrack_ipv4     # IPv4 连接追踪 (内核 4.19 之前)
nf_conntrack          # 连接追踪 (内核 4.19 及以后)

# 可选模块 (其他调度算法)
ip_vs_lc              # Least Connection
ip_vs_wlc             # Weighted Least Connection
ip_vs_dh              # Destination Hashing
ip_vs_sed             # Shortest Expected Delay
ip_vs_nq              # Never Queue
```

**检查模块是否编译进内核**:

```bash
$ grep -e ipvs -e nf_conntrack_ipv4 /lib/modules/$(uname -r)/modules.builtin
kernel/net/ipv4/netfilter/nf_conntrack_ipv4.ko
kernel/net/netfilter/ipvs/ip_vs.ko
kernel/net/netfilter/ipvs/ip_vs_rr.ko
kernel/net/netfilter/ipvs/ip_vs_wrr.ko
kernel/net/netfilter/ipvs/ip_vs_lc.ko
...
```

**检查模块是否已加载**:

```bash
$ lsmod | grep -e ip_vs -e nf_conntrack_ipv4
ip_vs_sh               12688  0
ip_vs_wrr              12697  0
ip_vs_rr               12600  1
ip_vs                 145497  3 ip_vs_rr,ip_vs_wrr,ip_vs_sh
nf_conntrack_ipv4      15053  2
nf_conntrack          133323  7 ip_vs,xt_conntrack,nf_conntrack_ipv4,...
```

**加载模块**:

```bash
modprobe -- ip_vs
modprobe -- ip_vs_rr
modprobe -- ip_vs_wrr
modprobe -- ip_vs_sh
modprobe -- nf_conntrack_ipv4
```

## 附录 D: 调试 IPVS 模式

### 检查 IPVS 规则

```bash
# 查看 IPVS Virtual Server
$ ipvsadm -Ln

IP Virtual Server version 1.2.1 (size=4096)
Prot LocalAddress:Port Scheduler Flags
  -> RemoteAddress:Port           Forward Weight ActiveConn InActConn
TCP  10.0.0.1:443 rr persistent 10800
  -> 192.168.0.1:6443             Masq    1      1          0
TCP  10.0.0.10:53 rr
  -> 172.17.0.2:53                Masq    1      0          0
UDP  10.0.0.10:53 rr
  -> 172.17.0.2:53                Masq    1      0          0
```

### 检查 kube-proxy 日志

**成功启动 IPVS 模式**:

```
Using ipvs Proxier.
```

**失败回退到 iptables 模式**:

```
Can't use ipvs proxier, trying iptables proxier
Using iptables Proxier.
```

### 常见问题排查

1. **模块未加载**
   ```bash
   # 检查模块
   lsmod | grep ip_vs
   
   # 加载模块
   modprobe ip_vs ip_vs_rr ip_vs_wrr ip_vs_sh
   ```

2. **ipset 未安装**
   ```bash
   # 检查 ipset
   which ipset
   
   # 安装 ipset
   apt-get install ipset  # Ubuntu/Debian
   yum install ipset      # CentOS/RHEL
   ```

3. **权限不足**
   ```bash
   # kube-proxy 需要特权模式或 CAP_NET_ADMIN
   ```

4. **配置错误**
   ```bash
   # 检查 kube-proxy 配置
   kubectl get configmap -n kube-system kube-proxy -o yaml
   ```

