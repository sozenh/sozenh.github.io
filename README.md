# 我的技术博客

基于 Hugo 和 PaperMod 主题构建的个人技术博客。

## 🚀 特性

- ✅ 响应式设计，支持移动端
- 🌓 内置深色/浅色主题切换
- 📝 支持代码高亮和复制
- 🔍 内置搜索功能
- 📚 文章归档和标签分类
- 📖 目录导航（TOC）
- ⚡ 快速加载和构建

## 📁 目录结构

```
.
├── content/              # 文章内容
│   ├── 随笔/            # 随笔分类
│   ├── 技术/            # 技术分类
│   │   ├── Go/         # Go 语言相关
│   │   └── Kubernetes/ # Kubernetes 相关
│   ├── archives.md      # 归档页面
│   └── search.md        # 搜索页面
├── themes/PaperMod/     # PaperMod 主题（v7.0）
├── hugo.toml            # Hugo 配置文件
└── .github/workflows/   # GitHub Actions 自动部署
```

## 🛠️ 本地开发

### 前置要求

- Hugo Extended v0.139.3 或更高版本

### 安装 Hugo

```bash
# Linux (示例)
wget https://github.com/gohugoio/hugo/releases/download/v0.139.3/hugo_extended_0.139.3_Linux-64bit.tar.gz
tar -xzf hugo_extended_0.139.3_Linux-64bit.tar.gz
sudo mv hugo /usr/local/bin/
```

### 克隆仓库

```bash
git clone --recurse-submodules https://github.com/sozenh/sozenh.github.io.git
cd sozenh.github.io
```

### 启动开发服务器

```bash
hugo server --buildDrafts --buildFuture
```

访问 http://localhost:1313 查看博客。

## ✍️ 写作指南

### 创建新文章

```bash
hugo new content/技术/分类名/文章名.md
```

### 文章格式

每篇文章需要包含以下 Front Matter：

```yaml
---
title: "文章标题"
date: 2025-10-09T20:00:00+08:00
draft: false
tags: ["标签1", "标签2"]
---

文章内容...
```

### 分类说明

文章的分类通过**目录结构**自动生成，无需在 Front Matter 中指定 categories 字段：

- `content/随笔/` → 随笔分类
- `content/技术/Go/` → 技术 > Go
- `content/技术/Kubernetes/` → 技术 > Kubernetes

## 🚢 部署

本项目使用 GitHub Actions 自动部署到 GitHub Pages。

### 首次部署设置

1. 在 GitHub 仓库设置中启用 GitHub Pages
2. 选择 Source 为 "GitHub Actions"
3. 推送代码后，Actions 会自动构建并部署

### 手动部署

```bash
git add .
git commit -m "更新博客"
git push origin main
```

## 📝 配置说明

主要配置在 `hugo.toml` 文件中：

- `baseURL`: 博客的 URL 地址
- `title`: 网站标题
- `[params]`: 主题参数配置
- `[[menu.main]]`: 导航菜单配置

详细配置请参考 [PaperMod 主题文档](https://github.com/adityatelange/hugo-PaperMod)。

## 🎨 主题

使用 [PaperMod](https://github.com/adityatelange/hugo-PaperMod) v7.0 主题。

主题功能：
- 自动深色/浅色模式
- 代码高亮（Monokai 风格）
- 社交媒体链接
- 文章分享按钮
- 阅读时间估算

## 📄 许可证

本博客内容采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可。

---

**博客地址**: https://sozenh.github.io
**作者**: sozenh
