# 代码组织结构文档

本文档说明所有代码文件（CSS、JavaScript、HTML）的职责划分，确保代码清晰、无重复、易维护。

---

## 📖 目录

- [目录结构](#-目录结构)
- [CSS 文件](#-css-文件)
- [JavaScript 文件](#-javascript-文件)
- [HTML 模板文件](#-html-模板文件)
- [配置文件](#️-配置文件)
- [组织原则](#-组织原则)
- [快速查找](#-快速查找)
- [检查清单](#-检查清单)

---

## 📁 目录结构

```
sozenh.github.io/
├── static/
│   ├── css/                    # 样式文件
│   │   ├── custom.css          ⭐ 全局样式（所有页面）
│   │   ├── blog-home.css       🏠 首页专用样式
│   │   ├── color-schemes.css   🎨 配色方案定义
│   │   ├── color-picker.css    🎨 配色选择器样式
│   │   └── contact-modal.css   💬 联系弹窗样式
│   └── js/                     # JavaScript 文件
│       ├── color-scheme.js     🎨 配色方案管理
│       └── contact-modal.js    💬 弹窗交互逻辑
├── layouts/
│   ├── index.html              🏠 首页完整布局
│   ├── _default/
│   │   └── baseof.html         📄 文档页基础布局
│   └── partials/
│       ├── common/             # 公共组件（跨页面复用）
│       │   ├── navbar.html     📍 统一导航栏
│       │   └── contact-modal.html  💬 联系弹窗HTML
│       └── docs/               # 文档页专用组件
│           ├── header.html     📍 文档页头部
│           └── inject/         # Hugo注入点
│               ├── head.html   📦 CSS/JS加载
│               └── body.html   📦 body注入
└── data/
    └── homepage.yaml           ⚙️ 可配置内容
```

---

## 🎨 CSS 文件

### 加载顺序

```html
<!-- 在 layouts/partials/docs/inject/head.html 中 -->

<!-- 全局样式 - 所有页面加载 -->
<link rel="stylesheet" href="/css/custom.css">
<link rel="stylesheet" href="/css/color-schemes.css">
<link rel="stylesheet" href="/css/color-picker.css">
<link rel="stylesheet" href="/css/contact-modal.css">

<!-- 首页专用样式 - 条件加载 -->
{{ if .IsHome }}
<link rel="stylesheet" href="/css/blog-home.css">
{{ end }}
```

**重要**: 后加载的 CSS 会覆盖先加载的同名样式！

---

### 1. custom.css ⭐ 全局样式

**加载**: 所有页面
**行数**: ~600 行

**包含内容**:
```css
/* 导航栏 */
.blog-nav, .nav-container, .nav-brand, .nav-links

/* 文档内容区域 */
.markdown (标题、段落、代码块、表格、链接等)
.book-menu (侧边栏)
.book-page (文档页面布局)

/* 全局美化 */
::-webkit-scrollbar (滚动条)
.book-menu nav ul li (菜单折叠)

/* 深色模式 */
.dark .blog-nav
.dark .markdown

/* 响应式 */
@media (max-width: 768px)
```

**重要原则**:
- ✅ 导航栏样式只在这里定义
- ✅ 全局组件的样式在这里
- ❌ 不要在 blog-home.css 中重复定义导航栏

**修改导航栏**:
```
文件: static/css/custom.css
查找: /* ==================== 文档页面导航栏 ==================== */
```

---

### 2. blog-home.css 🏠 首页专用

**加载**: 仅首页 (`{{ if .IsHome }}`)
**行数**: ~320 行

**包含内容**:
```css
/* 英雄区域 */
.hero-section, .hero-content, .hero-avatar
.hero-title, .hero-subtitle, .hero-description
.btn, .btn-primary, .btn-secondary

/* 文章预览区 */
.article-grid, .article-card
.article-header, .article-category, .article-date

/* 首页页脚 */
.blog-footer

/* 深色模式 */
.dark .hero-section
.dark .article-card

/* 响应式 */
@media (max-width: 768px)
```

**重要原则**:
- ✅ 只包含首页特有组件
- ❌ 不要定义导航栏样式

**修改首页英雄区域**:
```
文件: static/css/blog-home.css
查找: /* ==================== 英雄区域 ==================== */
```

---

### 3. color-schemes.css 🎨 配色方案

**加载**: 所有页面
**行数**: ~260 行

**包含内容**:
```css
/* CSS 变量定义 */
:root {
  --primary-color: #667eea;
  --bg-color: #ffffff;
  /* ... */
}

/* 预设配色方案 */
.scheme-default
.scheme-misty
.scheme-moss
/* ... */
```

**添加新配色**:
1. 在此文件添加 `.scheme-xxx` 类定义
2. 在 `color-scheme.js` 的 `schemes` 数组注册

---

### 4. color-picker.css 🎨 配色选择器

**加载**: 所有页面
**行数**: ~195 行

**包含内容**:
```css
.color-scheme-btn      /* 🎨 按钮 */
.color-scheme-dropdown /* 下拉菜单 */
.scheme-grid          /* 配色网格 */
.scheme-item          /* 配色项 */
```

---

### 5. contact-modal.css 💬 联系弹窗

**加载**: 所有页面
**行数**: ~180 行

**包含内容**:
```css
.contact-modal        /* 弹窗遮罩 */
.modal-content        /* 弹窗内容 */
.contact-info         /* 联系方式列表 */
.contact-item         /* 单个联系项 */
```

---

## 📜 JavaScript 文件

### 1. color-scheme.js 🎨 配色方案管理

**行数**: ~175 行

**职责**: 管理配色方案的选择、切换和持久化

**主要功能**:
```javascript
// 配色方案列表
const schemes = [
  { id: 'default', name: '柔和蓝灰', color: '#5b7c99' },
  { id: 'misty', name: '雾霾蓝', color: '#6b8cae' },
  // ...
];

// 功能
- renderSchemeGrid()     // 渲染配色选择器UI
- applyScheme(schemeId)  // 应用配色方案
- localStorage 持久化    // 保存用户选择
```

**配合文件**:
- CSS: `color-schemes.css` (配色定义)
- CSS: `color-picker.css` (选择器样式)

---

### 2. contact-modal.js 💬 弹窗交互

**行数**: ~65 行

**职责**: 管理联系我弹窗的打开、关闭和交互

**主要功能**:
```javascript
// 事件处理
- 点击"联系我"链接 → 打开弹窗
- 点击关闭按钮 → 关闭弹窗
- 点击背景遮罩 → 关闭弹窗
- 按 ESC 键 → 关闭弹窗
- 弹窗打开时禁止页面滚动
```

**配合文件**:
- HTML: `partials/common/contact-modal.html`
- CSS: `contact-modal.css`

---

## 📄 HTML 模板文件

### 布局文件

#### 1. layouts/index.html 🏠 首页模板

**职责**: 首页完整布局

**结构**:
```html
<!DOCTYPE html>
<html>
<head>
  {{ partial "docs/html-head" . }}
  {{ partial "docs/inject/head" . }}
</head>
<body class="home-page">
  <!-- 导航栏 -->
  {{ partial "common/navbar.html" . }}

  <main class="blog-main">
    <!-- 英雄区域 -->
    <section class="hero-section">...</section>

    <!-- 文章预览 -->
    <section class="content-preview">...</section>

    <!-- 页脚 -->
    <footer class="blog-footer">...</footer>
  </main>

  <!-- 联系弹窗 -->
  {{ partial "common/contact-modal.html" . }}
</body>
</html>
```

---

#### 2. layouts/_default/baseof.html 📄 文档页基础模板

**职责**: 文档页的基础布局结构

**结构**:
```html
<!DOCTYPE html>
<html>
<head>
  {{ partial "docs/html-head" . }}
  {{ partial "docs/inject/head" . }}
</head>
<body class="docs-page">
  <!-- 导航栏（在 main 外层，全宽） -->
  {{ if not .IsHome }}
  {{ partial "docs/header" . }}
  {{ end }}

  <main class="container flex">
    <!-- 左侧边栏 -->
    <aside class="book-menu">...</aside>

    <!-- 文章内容 -->
    <div class="book-page">...</div>

    <!-- 右侧目录 -->
    <aside class="book-toc">...</aside>
  </main>

  {{ partial "docs/inject/body" . }}
</body>
</html>
```

---

### 公共组件 (partials/common/)

#### 3. navbar.html 📍 统一导航栏

**职责**: 渲染网站顶部导航栏

**使用位置**:
- 首页: `index.html`
- 文档页: `docs/header.html`

**包含元素**:
```html
<nav class="blog-nav">
  <div class="nav-container">
    <div class="nav-brand">
      <a href="/">sozenh</a>
    </div>
    <div class="nav-links">
      <a href="/技术/">技术</a>
      <a href="/随笔/">随笔</a>
      <a href="#" id="contact-link">联系我</a>
      <!-- 配色选择器 -->
      <div class="color-scheme-picker">...</div>
    </div>
  </div>
</nav>
```

**配置**: `data/homepage.yaml` → `nav` 部分
**样式**: `static/css/custom.css` → 导航栏区块

---

#### 4. contact-modal.html 💬 联系弹窗

**职责**: 渲染联系我弹窗 HTML

**使用位置**:
- 首页: `index.html`
- 文档页: `docs/inject/body.html`

**配置**: `data/homepage.yaml` → `contact` 部分
**样式**: `static/css/contact-modal.css`
**脚本**: `static/js/contact-modal.js`

---

### 文档页组件 (partials/docs/)

#### 5. docs/header.html 📍 文档页头部

**职责**: 引用统一导航栏组件

```html
{{ partial "common/navbar.html" . }}
```

---

#### 6. docs/inject/head.html 📦 CSS/JS 加载

**职责**: 在 `<head>` 中注入 CSS 和 JS

```html
<!-- 全局 CSS -->
<link rel="stylesheet" href="/css/custom.css">
<link rel="stylesheet" href="/css/color-schemes.css">
<link rel="stylesheet" href="/css/color-picker.css">
<link rel="stylesheet" href="/css/contact-modal.css">

<!-- 首页专用 CSS -->
{{ if .IsHome }}
<link rel="stylesheet" href="/css/blog-home.css">
{{ end }}

<!-- JavaScript -->
<script defer src="/js/color-scheme.js"></script>
<script defer src="/js/contact-modal.js"></script>
```

---

#### 7. docs/inject/body.html 📦 body 注入点

**职责**: 在 `</body>` 前注入 HTML

```html
<!-- 联系弹窗 -->
{{ partial "common/contact-modal.html" . }}
```

---

## ⚙️ 配置文件

### data/homepage.yaml

**职责**: 集中管理所有可配置的文本内容

**配置项**:
```yaml
nav:                    # 导航栏文本
  site_title: "sozenh"
  tech_link: "技术"
  essay_link: "随笔"
  contact_link: "联系我"

hero:                   # 首页英雄区域
  avatar_type: "github"
  github_username: "sozenh"
  title: "你好，这里是sozenh"
  # ...

articles:               # 文章显示设置
  max_display: 6
  section_title: "最新文章"

footer:                 # 页脚
  copyright: "持续学习，不断进步 🌱"

contact:                # 联系方式
  modal_title: "联系我"
  email:
    label: "邮箱"
    address: "your@email.com"
  github:
    label: "GitHub"
    url: "https://github.com/username"
```

**详细文档**: `/HOMEPAGE_CONFIG.md`

---

## ✅ 组织原则

### 1. 单一职责原则
- 每个文件只负责一个明确的功能
- 每个组件的代码只在一个地方定义
- 不同页面的相同组件使用同一份代码

### 2. DRY 原则（Don't Repeat Yourself）
- ✅ 公共组件提取到 `partials/common/`
- ✅ 导航栏、联系弹窗只定义一次
- ✅ CSS 样式不在多个文件中重复

### 3. 职责分离
- **布局** (layouts/) - HTML 结构
- **样式** (static/css/) - 视觉外观
- **逻辑** (static/js/) - 交互行为
- **内容** (data/) - 可配置文本

### 4. 命名规范
- **CSS 类名**: kebab-case (`.nav-container`)
- **JavaScript**: camelCase (`initContactModal`)
- **文件名**: kebab-case (`contact-modal.js`)
- **组件目录**: `partials/common/` (跨页面), `partials/docs/` (文档页)

---

## 🔍 快速查找

### 修改导航栏

| 内容 | 文件 | 位置 |
|------|------|------|
| 样式 | `static/css/custom.css` | 搜索 "文档页面导航栏" |
| HTML | `layouts/partials/common/navbar.html` | 整个文件 |
| 文本 | `data/homepage.yaml` | `nav` 部分 |

---

### 修改联系弹窗

| 内容 | 文件 | 位置 |
|------|------|------|
| 样式 | `static/css/contact-modal.css` | 整个文件 |
| HTML | `layouts/partials/common/contact-modal.html` | 整个文件 |
| 逻辑 | `static/js/contact-modal.js` | 整个文件 |
| 内容 | `data/homepage.yaml` | `contact` 部分 |

---

### 修改首页英雄区域

| 内容 | 文件 | 位置 |
|------|------|------|
| 样式 | `static/css/blog-home.css` | 搜索 "英雄区域" |
| HTML | `layouts/index.html` | 搜索 "hero-section" |
| 内容 | `data/homepage.yaml` | `hero` 部分 |

---

### 添加新配色方案

1. **定义配色** - `static/css/color-schemes.css`
   ```css
   .scheme-newcolor {
     --primary-color: #xxx;
     --bg-color: #xxx;
     /* ... */
   }
   ```

2. **注册配色** - `static/js/color-scheme.js`
   ```javascript
   const schemes = [
     // ...
     { id: 'newcolor', name: '新配色', color: '#xxx' },
   ];
   ```

---

### 修改文章内容样式

| 元素 | 文件 | 类名 |
|------|------|------|
| 标题 | `static/css/custom.css` | `.markdown h1` ~ `.markdown h6` |
| 代码块 | `static/css/custom.css` | `.markdown pre`, `.markdown code` |
| 表格 | `static/css/custom.css` | `.markdown table` |
| 链接 | `static/css/custom.css` | `.markdown a` |
| 引用 | `static/css/custom.css` | `.markdown blockquote` |

---

## 📋 检查清单

修改代码后，请检查：

### 代码质量
- [ ] 没有重复定义的 HTML 结构
- [ ] 没有重复定义的 CSS 样式
- [ ] 公共组件在 `common/` 目录中
- [ ] 每个文件有清晰的头部注释
- [ ] 代码符合命名规范

### 功能测试
- [ ] 首页导航栏显示正确
- [ ] 文档页导航栏显示正确
- [ ] 两个页面的导航栏样式一致
- [ ] 联系弹窗在两个页面都能正常工作
- [ ] 配色选择器功能正常
- [ ] 深色模式下所有样式正常
- [ ] 移动端响应式布局正常

### 浏览器检查
- [ ] 没有 CSS 警告或错误
- [ ] 没有 JavaScript 错误
- [ ] 页面加载速度正常
- [ ] 所有链接可点击

---

## 📚 相关文档

- 首页配置: `/HOMEPAGE_CONFIG.md`
- Hugo 主题: `themes/hugo-book/`
- Hugo 文档: https://gohugo.io/documentation/

---

**最后更新**: 2025-10-10
**维护者**: Claude Code

**提示**: 如有疑问，请参考文件头部的注释说明。
