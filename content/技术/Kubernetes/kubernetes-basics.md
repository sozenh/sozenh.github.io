---
title: "Kubernetes 基础概念入门"
date: 2025-10-09T20:00:00+08:00
draft: false
tags: ["kubernetes", "k8s", "云原生", "容器编排"]
---

## 什么是 Kubernetes？

Kubernetes（简称 K8s）是一个开源的容器编排平台，用于自动化部署、扩展和管理容器化应用程序。

### 核心概念

#### 1. Pod

Pod 是 Kubernetes 中最小的可部署单元，通常包含一个或多个容器。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nginx-pod
spec:
  containers:
  - name: nginx
    image: nginx:1.21
    ports:
    - containerPort: 80
```

#### 2. Deployment

Deployment 用于管理 Pod 的副本集，提供声明式更新和回滚功能。

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx:1.21
        ports:
        - containerPort: 80
```

#### 3. Service

Service 为一组 Pod 提供稳定的网络端点。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx-service
spec:
  selector:
    app: nginx
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
  type: LoadBalancer
```

### Kubernetes 架构

```
┌─────────────────────────────────────┐
│         Control Plane               │
│  ┌──────────┐  ┌──────────────┐   │
│  │ API      │  │ Scheduler    │   │
│  │ Server   │  │              │   │
│  └──────────┘  └──────────────┘   │
│  ┌──────────┐  ┌──────────────┐   │
│  │ etcd     │  │ Controller   │   │
│  │          │  │ Manager      │   │
│  └──────────┘  └──────────────┘   │
└─────────────────────────────────────┘
           │
    ┌──────┴──────┐
    ▼             ▼
┌─────────┐  ┌─────────┐
│ Node 1  │  │ Node 2  │
│ ┌─────┐ │  │ ┌─────┐ │
│ │ Pod │ │  │ │ Pod │ │
│ └─────┘ │  │ └─────┘ │
└─────────┘  └─────────┘
```

### 常用命令

```bash
# 查看集群信息
kubectl cluster-info

# 查看节点
kubectl get nodes

# 查看所有 Pod
kubectl get pods --all-namespaces

# 创建资源
kubectl apply -f deployment.yaml

# 查看 Pod 日志
kubectl logs <pod-name>

# 进入 Pod
kubectl exec -it <pod-name> -- /bin/bash

# 删除资源
kubectl delete -f deployment.yaml
```

### 为什么选择 Kubernetes？

1. **自动化部署和回滚**
2. **服务发现和负载均衡**
3. **自我修复**：自动重启失败的容器
4. **水平扩展**：根据负载自动扩缩容
5. **存储编排**：自动挂载存储系统
6. **密钥和配置管理**

### 学习资源

- [Kubernetes 官方文档"](https://kubernetes.io/docs/)
- [Kubernetes 中文社区"](https://kubernetes.io/zh-cn/)
- [CNCF 云原生技术栈"](https://landscape.cncf.io/)

### 总结

Kubernetes 是现代云原生应用的基石，掌握它对于后端开发和运维工程师来说至关重要。在接下来的文章中，我会深入探讨 Kubernetes 的高级特性和最佳实践。

---

*本文为 Kubernetes 入门系列第一篇*
