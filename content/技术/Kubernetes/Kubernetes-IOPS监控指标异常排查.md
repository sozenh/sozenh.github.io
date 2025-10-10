---
title: "Kubernetes IOPS 监控指标异常排查报告"
date: 2025-10-10T18:00:00+08:00
draft: false
tags: ["kubernetes", "监控", "故障排查", "cAdvisor", "cgroup"]
summary: "记录一次因 Linux IO 调度策略变更导致的 Kubernetes Pod IOPS 监控指标异常问题的完整排查过程"
---

# Kubernetes 集群 IOPS 监控指标异常排查报告

## 摘要

本文档记录了一次因 Linux IO 调度策略变更导致的 Kubernetes Pod IOPS 监控指标异常问题的完整排查过程。通过分析 cAdvisor 在 cgroup v1 环境下的指标采集机制,最终定位根因并提供解决方案。

**核心问题**: 混合使用 CFQ 和 Deadline IO 调度策略时,cAdvisor 无法正确采集部分磁盘的 IOPS 指标。

---

## 1. 问题背景与现象

### 1.1 环境信息

- **Kubernetes 版本**: v1.x
- **容器运行时**: containerd/Docker
- **cgroup 版本**: v1
- **监控组件**: cAdvisor + Prometheus + Grafana
- **操作系统**: Linux (使用传统 IO 调度器)

### 1.2 变更内容

在存储设备维护过程中,对集群部分节点执行了以下操作:
- 将磁盘 IO 调度策略从 **CFQ (Complete Fairness Queueing)** 调整为 **Deadline**
- 目的: 优化数据库等时延敏感应用的 IO 性能

### 1.3 问题现象

**症状描述**:
1. 调整后的节点上,Prometheus 中 IOPS 相关指标值恒定为 **0**
2. 未调整的节点监控数据正常
3. 监控面板显示有数据,但数值不随实际 IO 变化

**影响范围**:
- 使用 Deadline 调度策略磁盘的所有 Pod
- 具体指标: `container_fs_reads_total`, `container_fs_writes_total`

---

## 2. 排查思路与方法论

### 2.1 监控链路分析

首先梳理 Kubernetes 环境下 IOPS 监控的完整数据流:
```
┌─────────────────────┐
│   Linux Kernel      │
└──────────┬──────────┘
           │ 读取 cgroup 文件
           ↓
┌─────────────────────┐
│     cAdvisor        │
└──────────┬──────────┘
           │ /metrics 接口
           ↓
┌─────────────────────┐
│    Prometheus       │
└──────────┬──────────┘
           │ PromQL 查询
           ↓
┌─────────────────────┐
│      Grafana        │
└─────────────────────┘
```

### 2.2 逐层排查策略

采用**自顶向下**的排查方法,从用户界面开始逐层验证:

| 层级 | 组件 | 验证方法 | 预期结果 |
|------|------|----------|----------|
| L4 | Grafana | 检查面板配置和 PromQL | 数据查询正常 |
| L3 | Prometheus | 直接查询原始指标 | 数据存在但恒定 |
| L2 | cAdvisor | 访问 /metrics 接口 | 定位数据源头 |
| L1 | cgroup | 检查 blkio 文件内容 | **问题出现在此** |

---

## 3. 问题排查详细过程

### 3.1 第一阶段: 确认数据流完整性

#### 步骤 1: 验证 Grafana → Prometheus

**操作**:
```promql
# 在 Grafana 面板中获取原始 PromQL
rate(container_fs_reads_total{pod="test-pod"}[5m])
```

**观察**: 查询返回结果,但计算后的值为 0

**结论**: Grafana 到 Prometheus 链路正常

---

#### 步骤 2: 验证 Prometheus 原始数据

**操作**:
```bash
# 直接在 Prometheus 查询基础指标 (不使用 rate 函数)
container_fs_reads_total{pod="test-pod"}
```

**观察**:
- 数据点存在
- 但数值在时间维度上**完全不变** (如一直为 12345)
- 正常情况下该值应持续累加

**结论**:
- Prometheus 采集到了数据
- 但数据源本身就是静态的
- 问题定位到 **cAdvisor 采集层**

---

### 3.2 第二阶段: cAdvisor 采集机制分析

#### 3.2.1 cAdvisor 工作原理

cAdvisor 通过读取 **cgroup 伪文件系统**获取容器资源使用情况:
```bash
# Pod 的 cgroup 路径示例
/sys/fs/cgroup/blkio/kubepods/pod<uid>/<container-id>/
```

相关 blkio 文件:
- `blkio.throttle.io_serviced` - IO 节流统计
- `blkio.io_serviced_recursive` - IO 操作统计 (递归统计子 cgroup)
- `blkio.throttle.io_serviced_recursive` - IO 节流统计 (递归)

#### 3.2.2 代码审查: cgroup v1 采集策略

通过阅读 cAdvisor 源码 (`github.com/google/cadvisor`) 发现:

**采集优先级** (按顺序尝试,成功后立即返回):
```go
// 简化的伪代码
func GetBlkioStats() BlkioStats {
    // 优先级 1: 尝试读取 CFQ 调度器文件
    if data := readFile("blkio.io_serviced_recursive"); data != nil {
        return parseStats(data)  // ← 如果成功,直接返回!
    }

    // 优先级 2: 尝试读取 Deadline/Throttle 文件
    if data := readFile("blkio.throttle.io_serviced_recursive"); data != nil {
        return parseStats(data)
    }

    // 优先级 3: 读取字节统计...
    // ...
}
```

**关键发现**:
- 如果第一个文件存在且可读,**后续文件不会被检查**
- 这是一个**短路策略**

---

### 3.3 第三阶段: 根因定位

#### 3.3.1 问题环境特征

通过检查问题节点,发现存在**混合调度策略**:
```bash
# 节点上有多块磁盘
$ cat /sys/block/*/queue/scheduler

# 输出示例:
/sys/block/sda/queue/scheduler:[cfq] deadline noop     # 旧磁盘
/sys/block/sdb/queue/scheduler:[cfq] deadline noop     # 旧磁盘
/sys/block/nvme0n1/queue/scheduler:cfq [deadline] noop # 新磁盘 (已调整)
```

#### 3.3.2 cgroup 文件内容对比

**在问题 Pod 的 cgroup 目录中**:
```bash
# 文件 1: blkio.io_serviced_recursive (优先级高)
$ cat blkio.io_serviced_recursive
8:0 Read 1234    # sda (CFQ)
8:0 Write 5678
8:16 Read 910    # sdb (CFQ)
8:16 Write 1112
# ← 注意: 缺少 nvme0n1 (Deadline) 的数据!

# 文件 2: blkio.throttle.io_serviced_recursive (优先级低)
$ cat blkio.throttle.io_serviced_recursive
8:0 Read 1234    # sda (CFQ)
8:0 Write 5678
8:16 Read 910    # sdb (CFQ)
8:16 Write 1112
259:0 Read 9999  # nvme0n1 (Deadline) ← 数据在这里!
259:0 Write 8888
```

#### 3.3.3 根因总结

**问题链条**:

1. **Linux 内核行为**: Deadline 调度器的 IO 统计写入 `blkio.throttle.*` 文件,**不写入** `blkio.io_serviced_recursive`

2. **混合环境**: 节点上同时存在 CFQ 和 Deadline 磁盘,导致 `blkio.io_serviced_recursive` 文件**非空** (包含 CFQ 磁盘数据)

3. **cAdvisor 短路**: 因为第一个文件非空,cAdvisor 直接返回,**跳过了包含 Deadline 磁盘数据的第二个文件**

4. **指标缺失**: Deadline 磁盘(新磁盘)的 IOPS 数据被忽略,导致使用该磁盘的 Pod 指标为 0

**关键矛盾**:
- cAdvisor 期望调度策略**统一** (要么全 CFQ,要么全 Deadline)
- 实际环境**混合配置**,打破了这个假设

---

## 4. 验证与复现

### 4.1 场景复现

#### 测试 1: 混合调度策略 (问题场景)
```bash
# 环境配置
sda: CFQ
sdb: CFQ
nvme0n1: Deadline ← Pod 使用此磁盘

# cgroup 文件状态
blkio.io_serviced_recursive: 包含 sda, sdb (没有 nvme0n1)
blkio.throttle.io_serviced_recursive: 包含所有磁盘

# cAdvisor 行为
读取第一个文件 → 有数据 → 返回 (缺少 nvme0n1)

# 结果
✗ nvme0n1 的 IOPS 为 0
```

#### 测试 2: 统一为 Deadline (解决方案)
```bash
# 环境配置
sda: Deadline
sdb: Deadline
nvme0n1: Deadline

# cgroup 文件状态
blkio.io_serviced_recursive: 空
blkio.throttle.io_serviced_recursive: 包含所有磁盘

# cAdvisor 行为
读取第一个文件 → 为空 → 读取第二个文件 → 返回

# 结果
✓ 所有磁盘 IOPS 正常
```

### 4.2 设备号说明
```bash
# 查看设备号
$ ls -l /dev/sda /dev/nvme0n1
brw-rw---- 1 root disk   8,  0 Jan 10 10:00 /dev/sda      # 8:0
brw-rw---- 1 root disk 259,  0 Jan 10 10:00 /dev/nvme0n1  # 259:0

# cgroup 文件中的 "8:0" 和 "259:0" 对应上述主/次设备号
```

---

## 5. 解决方案

### 5.1 方案对比

| 方案 | 实施难度 | 系统影响 | 生效时间 | 推荐度 |
|------|----------|----------|----------|--------|
| 统一 IO 调度策略 | 低 | 需要重启 | 立即 | ⭐⭐⭐⭐⭐ |
| 升级到 cgroup v2 | 高 | 需要内核支持 + 重启 | 需要测试 | ⭐⭐⭐ |
| 修改 cAdvisor 代码 | 高 | 需要维护自定义版本 | 需要重新部署 | ⭐⭐ |

### 5.2 方案 1: 统一 IO 调度策略 (推荐)

#### 原理

确保所有磁盘使用**相同的调度器**,使 cAdvisor 的短路策略不会遗漏数据。

#### 实施步骤

**临时修改 (立即生效,重启后失效)**:
```bash
# 查看当前调度策略
for disk in /sys/block/sd*/queue/scheduler; do
    echo "$disk: $(cat $disk)"
done

# 统一设置为 deadline
for disk in /sys/block/sd*/queue/scheduler; do
    echo deadline > $disk
done
for disk in /sys/block/nvme*/queue/scheduler; do
    echo deadline > $disk 2>/dev/null  # NVMe 可能不支持,忽略错误
done
```

**永久配置**:

方式 1: 使用 udev 规则
```bash
# 创建 /etc/udev/rules.d/60-scheduler.rules
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/scheduler}="deadline"
ACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{queue/scheduler}="none"

# 注意: NVMe 设备通常使用 "none" (多队列调度器)
```

方式 2: 通过 Grub 启动参数
```bash
# 编辑 /etc/default/grub
GRUB_CMDLINE_LINUX="elevator=deadline"

# 更新配置并重启
grub2-mkconfig -o /boot/grub2/grub.cfg  # RHEL/CentOS
update-grub                             # Debian/Ubuntu
reboot
```

**验证**:
```bash
# 检查所有磁盘调度策略
cat /sys/block/*/queue/scheduler

# 预期输出 (deadline 被方括号包围表示已启用)
noop [deadline] cfq
```

---

### 5.3 方案 2: 升级到 cgroup v2

#### 原理

cgroup v2 使用统一的 IO 统计接口 `io.stat`,不受调度策略影响。

#### 优势

- **根本解决**: 消除了调度策略依赖
- **未来兼容**: cgroup v2 是未来趋势
- **功能增强**: v2 提供更细粒度的控制

#### 前置条件
```bash
# 检查内核版本 (需要 >= 4.5)
$ uname -r
5.10.0-...  # ✓ 符合要求

# 检查当前 cgroup 版本
$ mount | grep cgroup
cgroup on /sys/fs/cgroup/memory type cgroup ...  # ← v1
cgroup2 on /sys/fs/cgroup type cgroup2 ...       # ← v2
```

#### 实施步骤

**1. 启用 cgroup v2**:
```bash
# 编辑 /etc/default/grub
GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1"

# 更新 grub
grub2-mkconfig -o /boot/grub2/grub.cfg
reboot
```

**2. 验证**:
```bash
# 应该只看到 cgroup2
$ mount | grep cgroup
cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime)

# 检查 Pod 的 IO 统计文件
$ cat /sys/fs/cgroup/kubepods.slice/kubepods-pod<uid>.slice/io.stat
259:0 rbytes=1234567 wbytes=7654321 rios=100 wios=200
```

**3. 兼容性测试**:

需要验证的组件:
- Kubernetes (1.19+ 原生支持 v2)
- 容器运行时 (containerd 1.4+, Docker 20.10+)
- 其他使用 cgroup 的监控/管理工具

#### 注意事项

⚠️ **重要提示**:
- cgroup v1 → v2 是单向迁移
- 某些旧版本软件可能不兼容
- 建议在测试环境充分验证

---

### 5.4 方案 3: cAdvisor 代码修改 (不推荐)

#### 原理

修改 cAdvisor 采集逻辑,合并多个 cgroup 文件的数据。

#### 伪代码
```go
func GetBlkioStats() BlkioStats {
    stats := BlkioStats{}

    // 读取所有可能的文件
    data1 := readFile("blkio.io_serviced_recursive")
    data2 := readFile("blkio.throttle.io_serviced_recursive")

    // 合并数据 (设备号去重)
    stats = mergeStats(data1, data2)
    return stats
}
```

#### 缺点

- 需要维护自定义 cAdvisor 版本
- 升级 Kubernetes 时可能产生兼容性问题
- 不是根本解决方案 (问题在于环境配置)

---

## 6. 技术深入解析

### 6.1 Linux IO 调度器详解

#### 调度器对比

| 调度器 | 全称 | 算法特点 | 适用场景 | cgroup 文件 |
|--------|------|----------|----------|-------------|
| **CFQ** | Completely Fair Queuing | 为每个进程维护独立队列,时间片轮转 | 通用场景,多用户系统 | `blkio.io_serviced` |
| **Deadline** | Deadline Scheduler | 为读/写请求设置截止时间,防止饿死 | 数据库,实时应用 | `blkio.throttle.*` |
| **Noop** | No Operation | 简单 FIFO,不排序 | SSD,RAID,虚拟化 | (不统计) |
| **BFQ** | Budget Fair Queueing | CFQ 的改进版,低延迟 | 桌面系统 | `blkio.io_serviced` |

#### Deadline 调度器原理
```
                 ┌─────────────┐
读请求 ──────────>│  读队列      │ (截止时间: 500ms)
                 │  按扇区排序  │
                 └──────┬──────┘
                        │
                        v
                 ┌─────────────┐      ┌──────────┐
                 │  调度器      │────> │  磁盘    │
                 └──────┬──────┘      └──────────┘
                        ^
                        │
                 ┌──────┴──────┐
写请求 ──────────>│  写队列      │ (截止时间: 5s)
                 │  按扇区排序  │
                 └─────────────┘
```

**特点**:
- 读请求优先 (截止时间更短)
- 批量处理写入 (提高吞吐量)
- 防止饿死 (超时请求强制执行)

---

### 6.2 cgroup blkio 子系统

#### cgroup v1 文件说明

| 文件名 | 说明 | 示例内容 |
|--------|------|----------|
| `blkio.io_serviced` | IO 操作次数统计 | `8:0 Read 123\n8:0 Write 456` |
| `blkio.io_serviced_recursive` | 递归统计(包含子 cgroup) | 同上 |
| `blkio.throttle.io_serviced` | 节流设备的 IO 统计 | 同上 |
| `blkio.io_service_bytes` | IO 字节数统计 | `8:0 Read 1048576` |
| `blkio.weight` | IO 权重配置 (100-1000) | `500` |

#### cgroup v2 简化
```bash
# v2 只有一个统一的文件
$ cat io.stat
259:0 rbytes=12345678 wbytes=87654321 rios=1234 wios=5678 dbytes=0 dios=0
#     |               |               |          |          |
#     |               |               |          |          +-- Discard IOs
#     |               |               |          +-- Write IOs
#     |               |               +-- Read IOs
#     |               +-- Write Bytes
#     +-- Read Bytes
```

**优势**: 不依赖调度器类型,所有数据在一个文件

---

### 6.3 cAdvisor 采集源码分析

#### 关键代码路径
```
github.com/google/cadvisor
├── container/libcontainer/handler.go
│   └── GetStats() ← 入口函数
│
└── utils/sysfs/sysfs.go
    └── GetBlockStats() ← 读取 cgroup 文件
```

#### 核心逻辑 (简化)
```go
// 文件: utils/sysfs/sysfs.go
func GetBlockStats() (BlockStats, error) {
    // v2 直接读取 io.stat
    if isCgroupV2() {
        return readIOStat()
    }

    // v1 按优先级读取
    files := []string{
        "blkio.io_serviced_recursive",
        "blkio.throttle.io_serviced_recursive",
        "blkio.io_service_bytes_recursive",
        "blkio.throttle.io_service_bytes_recursive",
    }

    for _, file := range files {
        if stats := readCgroupFile(file); stats != nil {
            return stats, nil  // ← 短路返回
        }
    }

    return nil, errors.New("no valid blkio file")
}
```

**问题代码**: 第一个非空文件立即返回,不检查数据完整性

---

## 7. 监控与告警

### 7.1 监控指标
```promql
# 检测 IOPS 为 0 的 Pod
count(
  rate(container_fs_reads_total{container!=""}[5m]) == 0
  and
  rate(container_fs_writes_total{container!=""}[5m]) == 0
) by (pod)

# 检测数据不变的指标 (delta 为 0)
sum by (pod) (
  delta(container_fs_reads_total[10m])
) == 0
```

### 7.2 告警规则
```yaml
# Prometheus Alert 规则
groups:
- name: cadvisor
  rules:
  - alert: IOPSMetricStale
    expr: |
      delta(container_fs_reads_total{container!="POD"}[10m]) == 0
      and
      delta(container_fs_writes_total{container!="POD"}[10m]) == 0
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "Pod {{ $labels.pod }} IOPS 指标无变化"
      description: "可能是 cAdvisor 采集异常或磁盘真的无 IO"
```

---

## 8. 常见问题 FAQ

### Q1: 如何判断是否受此问题影响?

**检查方法**:
```bash
# 1. 检查调度策略是否混合
cat /sys/block/*/queue/scheduler | sort -u
# 如果输出多行不同结果 → 存在混合

# 2. 检查 cgroup 文件
cat /sys/fs/cgroup/blkio/kubepods/pod<uid>/blkio.io_serviced_recursive
cat /sys/fs/cgroup/blkio/kubepods/pod<uid>/blkio.throttle.io_serviced_recursive
# 对比两个文件的设备列表是否一致

# 3. 检查 Prometheus 指标
rate(container_fs_reads_total{pod="xxx"}[5m])
# 如果为 0 但 Pod 实际有 IO → 受影响
```

---

### Q2: NVMe 设备需要调整调度策略吗?

**回答**: NVMe 设备通常使用 **none** (或 kyber) 调度器:
```bash
# NVMe 设备查看
$ cat /sys/block/nvme0n1/queue/scheduler
[none] mq-deadline kyber

# "none" 表示使用多队列 (blk-mq) 无调度器
# 这是 NVMe 的推荐配置,无需修改
```

**注意**: 本问题主要影响 SATA/SAS 磁盘 (sd*)

---

### Q3: 修改调度策略对性能有何影响?

**一般影响**:

| 场景 | CFQ → Deadline | 影响评估 |
|------|----------------|----------|
| 数据库 (MySQL/PostgreSQL) | 延迟降低 10-30% | ✓ 正面 |
| 顺序写入 (日志/备份) | 吞吐量略降 | ≈ 中性 |
| 随机读 (Web 应用) | 延迟略降 | ✓ 正面 |
| 混合负载 | 需要实测 | ? 视情况 |

**建议**: 生产变更前进行压测

---

### Q4: cgroup v2 迁移有哪些坑?

**常见问题**:

1. **Docker 版本**: 需要 20.10+
```bash
docker version | grep Version
# 如果 < 20.10 需要升级
```

2. **systemd 版本**: 需要 226+
```bash
systemctl --version
```

3. **应用兼容性**: 某些老旧监控工具可能硬编码 v1 路径
```bash
# 示例: 某些脚本可能写死
/sys/fs/cgroup/memory/memory.limit_in_bytes  # v1
# 应该改为
/sys/fs/cgroup/memory.max                    # v2
```

---

### Q5: 如何快速回滚?

**场景 1: 临时修改的调度策略**
```bash
# 回滚到 cfq
for disk in /sys/block/sd*/queue/scheduler; do
    echo cfq > $disk
done

# 立即生效,无需重启
```

**场景 2: 通过 Grub 修改的**
```bash
# 编辑 /etc/default/grub,删除 elevator 参数
GRUB_CMDLINE_LINUX=""

# 更新并重启
grub2-mkconfig -o /boot/grub2/grub.cfg
reboot
```

**场景 3: cgroup v2 回滚**
```bash
# 修改 grub
GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=0"

# 更新并重启
grub2-mkconfig -o /boot/grub2/grub.cfg
reboot
```

---

## 9. 总结

### 9.1 关键要点

1. **根本原因**: cAdvisor 在 cgroup v1 下的短路采集策略,无法处理混合调度器环境

2. **触发条件**:
   - 同一节点存在多种 IO 调度器
   - 使用 cgroup v1
   - Pod 使用 Deadline 调度器磁盘

3. **解决方案**: 统一调度策略或升级到 cgroup v2

4. **核心教训**: 系统级配置变更需要考虑监控链路的完整性

### 9.2 技术要点

| 层面 | 知识点 |
|------|--------|
| **Linux 内核** | IO 调度器工作原理,cgroup blkio 子系统 |
| **容器运行时** | cgroup 文件系统挂载,namespace 隔离 |
| **监控系统** | cAdvisor 采集机制,Prometheus 数据模型 |
| **故障排查** | 自顶向下排查,数据流追踪方法 |

### 9.3 推荐阅读

- [Linux Block IO Controller (kernel.org)](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v1/blkio-controller.html)
- [cgroup v2 (kernel.org)](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
- [cAdvisor GitHub](https://github.com/google/cadvisor)
- [Kubernetes cgroup v2 Support](https://kubernetes.io/docs/concepts/architecture/cgroups/)

---

## 附录

### A. 实用脚本

#### 检查集群调度策略一致性
```bash
#!/bin/bash
# check-schedulers.sh

echo "检查所有节点的磁盘调度策略..."

for node in $(kubectl get nodes -o name); do
    echo "=== $node ==="
    kubectl debug $node -it --image=busybox -- \
        sh -c 'cat /host/sys/block/*/queue/scheduler' 2>/dev/null || true
done
```

#### 批量修改调度策略
```bash
#!/bin/bash
# set-deadline.sh

TARGET_SCHEDULER="deadline"

for disk in /sys/block/sd*/queue/scheduler; do
    current=$(cat $disk | grep -oP '\[\K[^\]]+')
    if [ "$current" != "$TARGET_SCHEDULER" ]; then
        echo "设置 $disk -> $TARGET_SCHEDULER"
        echo $TARGET_SCHEDULER > $disk
    fi
done

echo "完成!"
```

---

### B. Prometheus 查询示例
```promql
# 1. 查看所有容器的读 IOPS
rate(container_fs_reads_total{container!="POD"}[5m])

# 2. 按节点汇总 IO
sum by (node) (
  rate(container_fs_reads_total[5m]) +
  rate(container_fs_writes_total[5m])
)

# 3. 查找 IOPS 异常的 Pod (过去 1 小时平均 < 1)
avg_over_time(
  rate(container_fs_reads_total{container!="POD"}[5m])[1h:]
) < 1

# 4. 对比两个时间段的 IOPS 变化
(
  rate(container_fs_reads_total[5m])
  -
  rate(container_fs_reads_total[5m] offset 1h)
) > 100
```

---

### C. 术语表

| 术语 | 英文全称 | 说明 |
|------|----------|------|
| **IOPS** | IO Operations Per Second | 每秒 IO 操作次数 |
| **CFQ** | Completely Fair Queueing | 完全公平队列调度器 |
| **cgroup** | Control Groups | Linux 资源隔离和限制机制 |
| **cAdvisor** | Container Advisor | Google 开源的容器监控工具 |
| **blkio** | Block IO | cgroup 的块设备 IO 控制器 |
| **PromQL** | Prometheus Query Language | Prometheus 的查询语言 |
