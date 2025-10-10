# 项目文件组织说明

本文档说明Hugo博客项目的完整文件组织结构，包括CSS、JavaScript、HTML模板等所有资源文件的职责和关系。

## 📁 目录结构概览

```
sozenh.github.io/
├── static/                    # 静态资源目录
│   ├── css/                   # CSS样式文件
│   ├── js/                    # JavaScript脚本
│   ├── fonts/                 # 字体文件
│   └── images/                # 图片资源
├── layouts/                   # Hugo模板文件
│   ├── partials/              # 可复用的模板片段
│   ├── _default/              # 默认模板
│   └── index.html             # 首页模板
├── content/                   # Markdown内容文件
├── data/                      # 数据文件（YAML/JSON）
├── hugo.toml                  # Hugo配置文件
├── CSS_STRUCTURE.md           # CSS架构详细说明
└── FILE_ORGANIZATION.md       # 本文档
```

---

## 🎨 CSS 样式文件

详细的CSS架构说明请参见 [CSS_STRUCTURE.md](./CSS_STRUCTURE.md)

### 文件列表和加载顺序

```
static/css/
├── 1. fonts.css              # 字体定义
├── 2. color-schemes.css      # 配色方案CSS变量
├── 3. common.css             # 公共基础样式
├── 4. navbar.css             # 导航栏样式
├── 5. custom.css             # 文档页面样式
├── 6. blog-home.css          # 首页样式（条件加载）
├── 7. color-picker.css       # 配色选择器组件
└── 8. contact-modal.css      # 联系弹窗组件
```

### 加载配置

在 `layouts/partials/docs/inject/head.html` 中按顺序引入：

```html
<!-- 1. 字体定义 -->
<link rel="stylesheet" href="/css/fonts.css">

<!-- 2. 配色方案变量 -->
<link rel="stylesheet" href="/css/color-schemes.css">

<!-- 3. 公共基础样式 -->
<link rel="stylesheet" href="/css/common.css">

<!-- 4. 导航栏样式 -->
<link rel="stylesheet" href="/css/navbar.css">

<!-- 5. 文档页面样式 -->
<link rel="stylesheet" href="/css/custom.css">

<!-- 6. 首页样式（条件加载） -->
{{ if .IsHome }}
<link rel="stylesheet" href="/css/blog-home.css">
{{ end }}

<!-- 7. 组件样式 -->
<link rel="stylesheet" href="/css/color-picker.css">
<link rel="stylesheet" href="/css/contact-modal.css">
```

---

## 🎯 JavaScript 脚本文件

### 文件列表

```
static/js/
├── color-scheme.js           # 配色方案选择器
├── contact-modal.js          # 联系弹窗功能
├── menu-resize.js            # 左侧菜单宽度调节
└── toc-toggle.js             # TOC浮动按钮切换
```

### 功能详解

| 文件 | 职责 | 依赖 |
|------|------|------|
| **color-scheme.js** | 配色方案选择、切换、持久化 | color-schemes.css, color-picker.css |
| **contact-modal.js** | 联系弹窗的打开、关闭、ESC键支持 | contact-modal.css |
| **menu-resize.js** | 左侧菜单拖拽调节宽度、保存用户设置 | custom.css (.menu-resize-handle) |
| **toc-toggle.js** | TOC浮动按钮创建、显示/隐藏切换 | custom.css (.book-toc, .toc-toggle-btn) |

### 加载方式

在 `layouts/partials/docs/inject/head.html` 中：

```html
<!-- 配色选择脚本 -->
<script defer src="/js/color-scheme.js"></script>

<!-- 联系弹窗脚本 -->
<script defer src="/js/contact-modal.js"></script>
```

在 `layouts/partials/docs/inject/body.html` 中：

```html
<!-- 左侧菜单宽度调节 -->
<script defer src="/js/menu-resize.js"></script>

<!-- TOC 浮动按钮 -->
<script defer src="/js/toc-toggle.js"></script>
```

---

## 📄 HTML 模板文件

### 目录结构

```
layouts/
├── index.html                        # 首页模板
├── _default/
│   └── baseof.html                   # 基础布局模板
└── partials/
    ├── common/                       # 公共组件
    │   ├── navbar.html               # 导航栏组件
    │   └── contact-modal.html        # 联系弹窗组件
    └── docs/                         # 文档页面组件
        ├── header.html               # 文档页面头部
        └── inject/                   # 注入点
            ├── head.html             # <head> 注入点
            └── body.html             # </body> 注入点
```

### 模板职责

#### 1. layouts/index.html
**职责**: 首页布局

**包含内容**:
- 导航栏（使用 `common/navbar.html`）
- 英雄区域（hero section）
- 文章预览网格
- 页脚
- 联系弹窗（使用 `common/contact-modal.html`）

**使用的CSS**: blog-home.css, common.css, navbar.css

---

#### 2. layouts/_default/baseof.html
**职责**: 所有页面的基础模板

**包含内容**:
- `<head>` 区域（加载CSS和meta）
- 注入点：`{{ partial "docs/inject/head.html" . }}`
- `<body>` 区域
- 注入点：`{{ partial "docs/inject/body.html" . }}`

---

#### 3. layouts/partials/common/navbar.html
**职责**: 统一导航栏组件

**使用位置**:
- 首页: `layouts/index.html`
- 文档页: `layouts/partials/docs/header.html`

**包含元素**:
- 网站标题 (sozenh)
- 导航链接 (技术、随笔、联系我)
- 配色选择器

**配置来源**: `data/homepage.yaml` 的 `nav` 部分

**样式**: navbar.css

---

#### 4. layouts/partials/common/contact-modal.html
**职责**: 联系方式弹窗组件

**使用位置**:
- 首页底部
- 文档页面（通过 `inject/body.html`）

**配置来源**: `data/homepage.yaml` 的 `contact` 部分

**样式**: contact-modal.css

**脚本**: contact-modal.js

---

#### 5. layouts/partials/docs/inject/head.html
**职责**: 在所有页面 `</head>` 前注入CSS和脚本

**包含内容**:
- 8个CSS文件链接（按顺序）
- 2个JavaScript脚本（color-scheme.js, contact-modal.js）

---

#### 6. layouts/partials/docs/inject/body.html
**职责**: 在文档页面 `</body>` 前注入额外HTML

**包含内容**:
- 联系弹窗组件（partial）
- 左侧菜单调节脚本（menu-resize.js）
- TOC浮动按钮脚本（toc-toggle.js）

---

## 🗂️ 数据配置文件

### data/homepage.yaml

存储首页和导航栏的配置数据：

```yaml
nav:
  site_title: "sozenh"
  tech_link: "技术"
  essay_link: "随笔"
  contact_link: "联系我"

hero:
  title: "你好，这里是sozenh"
  subtitle: "一个热爱技术、热爱编程的开发者"
  description: "..."

contact:
  modal_title: "联系我"
  email:
    label: "邮箱"
    address: "suhouzhen2020@gmail.com"
  github:
    label: "GitHub"
    url: "https://github.com/sozenh"
    display: "https://github.com/sozenh"
```

---

## 🔧 Hugo 配置

### hugo.toml

关键配置项：

```toml
baseURL = "https://sozenh.github.io/"
title = "我的技术博客"
theme = "hugo-book"

[markup.highlight]
    style = 'friendly'          # 柔和的代码高亮主题
    lineNos = false             # 不显示行号
    noClasses = true            # 使用内联样式
```

---

## 📦 静态资源

### 字体文件

```
static/fonts/
├── JetBrainsMonoNL-Regular.ttf
├── JetBrainsMonoNL-Bold.ttf
├── JetBrainsMonoNL-Italic.ttf
├── JetBrainsMonoNL-Medium.ttf
├── JetBrainsMonoNL-MediumItalic.ttf
├── JetBrainsMonoNL-BoldItalic.ttf
├── JetBrainsMonoNL-ExtraBold.ttf
├── JetBrainsMonoNL-ExtraBoldItalic.ttf
├── SourceHanSansSC-Regular.otf
├── SourceHanSansSC-Light.otf
├── SourceHanSansSC-Medium.otf
├── SourceHanSansSC-Bold.otf
└── SourceHanSansSC-Heavy.otf
```

**用途**:
- **JetBrains Mono**: 所有英文文本（包括正文和代码）
- **Source Han Sans SC**: 所有中文文本

**定义位置**: `static/css/fonts.css`

---

## 🔗 文件依赖关系图

### CSS 依赖关系

```
color-schemes.css (定义CSS变量)
    ↓
common.css (使用变量)
navbar.css (使用变量)
custom.css (使用变量)
blog-home.css (使用变量)
color-picker.css (使用变量)
contact-modal.css (使用变量)
```

### JavaScript 依赖关系

```
color-scheme.js
    ↓ 依赖
color-schemes.css (读取配色定义)
color-picker.css (选择器样式)

contact-modal.js
    ↓ 依赖
contact-modal.css (弹窗样式)
common/contact-modal.html (弹窗HTML)

menu-resize.js
    ↓ 依赖
custom.css (.menu-resize-handle)

toc-toggle.js
    ↓ 依赖
custom.css (.book-toc, .toc-toggle-btn)
```

### HTML 模板依赖关系

```
index.html (首页)
    ↓ 引入
common/navbar.html
common/contact-modal.html

_default/baseof.html (基础模板)
    ↓ 引入
docs/inject/head.html (CSS和脚本)
docs/inject/body.html (额外组件)
    ↓ 引入
common/contact-modal.html
```

---

## 🛠️ 组件化设计

项目采用组件化设计，每个功能模块都是独立的：

### 配色选择器组件

| 文件类型 | 文件路径 |
|---------|---------|
| CSS (变量定义) | `static/css/color-schemes.css` |
| CSS (UI样式) | `static/css/color-picker.css` |
| JavaScript | `static/js/color-scheme.js` |
| HTML | 内嵌在 `common/navbar.html` 中 |

### 联系弹窗组件

| 文件类型 | 文件路径 |
|---------|---------|
| CSS | `static/css/contact-modal.css` |
| JavaScript | `static/js/contact-modal.js` |
| HTML | `layouts/partials/common/contact-modal.html` |
| 数据 | `data/homepage.yaml` (contact 部分) |

### 左侧菜单组件

| 文件类型 | 文件路径 |
|---------|---------|
| CSS | `static/css/custom.css` (.book-menu) |
| JavaScript | `static/js/menu-resize.js` |
| HTML | Hugo Book主题提供 |

### TOC组件

| 文件类型 | 文件路径 |
|---------|---------|
| CSS | `static/css/custom.css` (.book-toc, .toc-toggle-btn) |
| JavaScript | `static/js/toc-toggle.js` |
| HTML | Hugo Book主题提供 |

---

## 📋 页面类型和资源加载

### 首页 (/)

**模板**: `layouts/index.html`

**加载的资源**:
```
CSS:
  - fonts.css
  - color-schemes.css
  - common.css
  - navbar.css
  - custom.css
  - blog-home.css ✓ (仅首页)
  - color-picker.css
  - contact-modal.css

JavaScript:
  - color-scheme.js
  - contact-modal.js
```

### 文档页面 (/技术/, /随笔/, 文章页)

**模板**: Hugo Book 主题默认模板 + 自定义注入

**加载的资源**:
```
CSS:
  - fonts.css
  - color-schemes.css
  - common.css
  - navbar.css
  - custom.css
  - (blog-home.css 不加载)
  - color-picker.css
  - contact-modal.css

JavaScript:
  - color-scheme.js
  - contact-modal.js
  - menu-resize.js ✓ (仅文档页)
  - toc-toggle.js ✓ (仅文档页)
```

---

## 🎯 开发流程

### 添加新页面

1. 在 `content/` 目录创建Markdown文件
2. Hugo自动使用默认模板渲染
3. 样式自动继承 custom.css 和 navbar.css

### 添加新组件

1. 创建CSS文件: `static/css/new-component.css`
2. 创建JavaScript文件: `static/js/new-component.js`（如需要）
3. 创建HTML模板: `layouts/partials/common/new-component.html`
4. 在 `inject/head.html` 中引入CSS
5. 在需要的地方引入HTML: `{{ partial "common/new-component.html" . }}`

### 修改配色方案

1. 编辑 `static/css/color-schemes.css`
2. 添加新的 `[data-color-scheme="xxx"]` 配置
3. 在 `static/js/color-scheme.js` 的 `schemes` 数组中添加新配色

### 修改导航栏

1. 编辑 `data/homepage.yaml` 的 `nav` 部分（文本）
2. 编辑 `layouts/partials/common/navbar.html`（结构）
3. 编辑 `static/css/navbar.css`（样式）

---

## 🔍 调试和问题排查

### CSS 样式不生效

1. 检查加载顺序：查看HTML源码中 `<link>` 标签顺序
2. 检查选择器优先级：使用浏览器开发者工具查看层叠
3. 检查CSS变量：查看 `:root` 和 `[data-color-scheme]` 的值
4. 检查缓存：硬刷新浏览器（Ctrl+Shift+R）

### JavaScript 功能异常

1. 打开浏览器控制台查看错误
2. 检查脚本加载：查看Network面板
3. 检查DOM元素：确认HTML元素存在且ID正确
4. 检查localStorage：清除可能损坏的数据

### 页面渲染问题

1. 检查Hugo构建输出：`hugo --cleanDestinationDir`
2. 检查模板语法：查看Hugo错误提示
3. 检查数据文件：验证YAML格式正确
4. 检查条件加载：确认 `{{ if }}` 逻辑正确

---

## 📚 相关文档

- **CSS架构详解**: [CSS_STRUCTURE.md](./CSS_STRUCTURE.md)
- **Hugo官方文档**: https://gohugo.io/documentation/
- **Hugo Book主题**: https://github.com/alex-shpak/hugo-book

---

## ✨ 总结

本项目采用模块化、组件化的架构设计：

- **CSS**: 8个独立文件，职责清晰，按顺序加载
- **JavaScript**: 4个功能脚本，使用IIFE封装，无全局污染
- **HTML**: 组件化模板，可复用，易维护
- **数据**: 配置与代码分离，便于管理

所有文件都有清晰的注释说明职责和依赖关系，便于团队协作和长期维护。
