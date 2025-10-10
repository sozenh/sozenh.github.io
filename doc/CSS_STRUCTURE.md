# CSS 文件结构说明

## 文件组织架构

项目使用模块化的 CSS 架构，每个文件都有明确的职责，避免代码重复和冲突。

```
static/css/
├── fonts.css           # 字体定义
├── color-schemes.css   # 配色方案变量
├── common.css          # 公共基础样式
├── navbar.css          # 导航栏样式
├── custom.css          # 文档页面样式
├── blog-home.css       # 首页样式
├── color-picker.css    # 配色选择器样式
└── contact-modal.css   # 联系弹窗样式
```

## 加载顺序

CSS 文件按以下顺序加载（在 `layouts/partials/docs/inject/head.html` 中定义）：

1. **fonts.css** - 字体定义（最先加载，供其他样式使用）
2. **color-schemes.css** - 配色方案CSS变量（必须在引用变量的样式之前）
3. **common.css** - 公共基础样式（字体、滚动条、按钮等）
4. **navbar.css** - 导航栏样式（所有页面共享）
5. **custom.css** - 文档页面样式（文档专用）
6. **blog-home.css** - 首页样式（仅首页加载，条件引入）
7. **color-picker.css** - 配色选择器组件
8. **contact-modal.css** - 联系弹窗组件

## 文件职责详解

### 1. fonts.css
**职责**: 定义所有字体的 `@font-face` 规则

**包含内容**:
- JetBrains Mono 字体（Regular, Bold, Italic等）
- Source Han Sans SC 字体（Regular, Light, Medium, Bold, Heavy）

**使用方式**:
```css
@font-face {
  font-family: 'JetBrains Mono';
  src: url('/fonts/JetBrainsMonoNL-Regular.ttf') format('truetype');
}
```

---

### 2. color-schemes.css
**职责**: 定义配色方案的CSS变量

**包含内容**:
- 9种柔和低饱和度配色方案
- 每个方案定义6个CSS变量：
  - `--primary-color` - 主色
  - `--primary-dark` - 深色
  - `--primary-light` - 浅色
  - `--primary-lighter` - 更浅色
  - `--gradient-start` - 渐变起始色
  - `--gradient-end` - 渐变结束色

**使用方式**:
```css
/* 默认配色 */
:root {
  --primary-color: #5b7c99;
}

/* 其他配色 */
[data-color-scheme="moss"] {
  --primary-color: #6b8e6f;
}
```

**配色切换**: 通过JavaScript修改HTML的 `data-color-scheme` 属性

---

### 3. common.css
**职责**: 所有页面共享的基础样式

**包含内容**:
- 全局字体设置（`body` 字体）
- 滚动条美化（`::-webkit-scrollbar`）
- 通用按钮样式（`.btn`, `.btn-primary`, `.btn-secondary`）

**重要原则**:
- 只包含真正公共的样式
- 不包含页面特定的样式
- 使用 CSS 变量引用配色

---

### 4. navbar.css
**职责**: 导航栏样式（所有页面共享）

**包含内容**:
- 导航栏基础样式（`.blog-nav`）
- 导航栏品牌和链接（`.nav-brand`, `.nav-links`）
- 响应式布局（移动端适配）

**重要特性**:
- 使用 `sticky` 定位
- 半透明背景 + 毛玻璃效果（`backdrop-filter: blur`）
- 响应式导航链接

---

### 5. custom.css
**职责**: 文档页面的专用样式

**包含内容**:
- 侧边栏样式（`.book-menu`）
- 文章内容区（`.markdown`）
- Markdown元素样式（标题、列表、表格等）
- TOC浮动按钮（`.toc-toggle-btn`）
- 汉堡菜单按钮
- 移动端适配

**重要原则**:
- 仅用于文档页面，不影响首页
- 遵循Forest主题的设计风格
- 代码高亮由Hugo Chroma控制，CSS只设置字体和布局

---

### 6. blog-home.css
**职责**: 首页专用样式

**包含内容**:
- 英雄区域（`.hero-section`）
- 文章预览网格（`.article-grid`, `.article-card`）
- 首页页脚（`.blog-footer`）

**加载方式**: 条件加载（仅在 `{{ if .IsHome }}` 时引入）

**重要特性**:
- 渐变背景（hero section）
- 卡片式文章预览
- GitHub头像显示

---

### 7. color-picker.css
**职责**: 配色选择器组件样式

**包含内容**:
- 选择器按钮（`.color-scheme-btn`）
- 下拉菜单（`.color-scheme-dropdown`）
- 配色网格（`.scheme-grid`）
- 深色模式适配

**重要特性**:
- 圆形颜色按钮网格布局
- 下拉动画效果
- 选中状态标识

---

### 8. contact-modal.css
**职责**: 联系我弹窗组件样式

**包含内容**:
- 模态框容器（`.contact-modal`）
- 内容区域（`.modal-content`）
- 联系方式列表（`.contact-item`）
- 动画效果（`fadeIn`, `slideIn`）

**重要特性**:
- 居中弹窗布局
- 淡入淡出动画
- 深色模式适配

---

## 样式优先级和冲突解决

### CSS变量优先级

1. `:root` - 默认配色（最低优先级）
2. `[data-color-scheme="xxx"]` - 用户选择的配色（覆盖默认值）

### 避免样式冲突的原则

1. **专用类名**: 每个模块使用独特的类名前缀
   - 导航栏: `.blog-nav`, `.nav-*`
   - 首页: `.hero-*`, `.article-*`
   - 文档: `.markdown`, `.book-*`

2. **作用域限制**: 通过父选择器限制作用域
   ```css
   /* 仅影响文档页面的 markdown */
   .markdown h1 { }

   /* 仅影响首页的 hero */
   .hero-section h1 { }
   ```

3. **条件加载**: 首页样式仅在首页加载
   ```html
   {{ if .IsHome }}
   <link rel="stylesheet" href="/css/blog-home.css">
   {{ end }}
   ```

4. **避免 !important**: 移除了所有不必要的 `!important`，仅在必要时使用

---

## Markdown 样式设计

### Forest 主题特性

文档页面遵循 Typora Forest 主题设计：

- **字体**: JetBrains Mono（英文） + Source Han Sans SC（中文）
- **背景**: 淡绿色调（#f5f7f3）
- **标题装饰**: 左侧彩色竖条（使用配色方案的渐变色）
- **代码高亮**: Hugo Chroma `friendly` 主题（柔和配色）

### 元素样式

| 元素 | 样式特点 |
|-----|---------|
| H1 | 居中对齐，底部横线，下方彩色短线装饰 |
| H2 | 左侧彩色竖条，底部细线 |
| H3 | 左侧彩色竖条 |
| H4 | 三角符号（▸）前缀 |
| 链接 | 主题色，悬浮显示下划线 |
| 引用块 | 左侧4px主题色边框，灯泡图标 |
| 列表 | 主题色标记符号（圆点/数字） |
| 表格 | 表头使用主题色渐变背景 |
| 代码块 | 浅色背景，由Hugo Chroma控制高亮 |

---

## 响应式设计

### 断点定义

- **移动端**: `< 56rem` (896px)
- **平板**: `768px - 1024px`
- **桌面**: `> 1024px`

### 移动端适配

在 `custom.css` 中：
```css
@media screen and (max-width: 56rem) {
  /* 侧边栏变为抽屉式 */
  /* 汉堡按钮显示 */
  /* TOC隐藏 */
}
```

在 `navbar.css` 和 `blog-home.css` 中：
```css
@media (max-width: 768px) {
  /* 导航栏字体缩小 */
  /* 文章网格变为单列 */
}
```

---

## 代码高亮配置

### Hugo配置 (hugo.toml)

```toml
[markup.highlight]
    style = 'friendly'      # 柔和的亮色主题
    lineNos = false         # 不显示行号
    noClasses = true        # 使用内联样式
```

### CSS控制

CSS只控制代码的字体和布局，不控制高亮颜色：

```css
/* 代码字体 */
.markdown code {
  font-family: 'JetBrains Mono', 'Menlo', 'Monaco', 'Consolas', 'Courier New', monospace;
}

/* 代码块布局 */
.markdown pre {
  overflow-x: auto;
  margin: 1.5rem 0;
}
```

---

## 维护指南

### 添加新样式

1. **判断样式归属**:
   - 所有页面共享 → `common.css`
   - 仅导航栏 → `navbar.css`
   - 仅文档页面 → `custom.css`
   - 仅首页 → `blog-home.css`
   - 新组件 → 创建独立CSS文件

2. **使用CSS变量**:
   ```css
   /* 好的做法 - 使用变量 */
   color: var(--primary-color);

   /* 避免硬编码 */
   color: #5b7c99;
   ```

3. **添加注释**:
   - 每个主要区块添加注释说明
   - 复杂样式添加解释

### 修改现有样式

1. **先确认文件**: 使用浏览器开发者工具查看样式来源
2. **检查影响范围**: 确保修改不会影响其他页面
3. **测试多种配色**: 切换配色方案测试效果
4. **移动端测试**: 检查响应式布局

### 调试技巧

1. **查看加载顺序**: 检查 HTML `<head>` 中的 CSS 引用顺序
2. **检查CSS变量**: 在开发者工具中查看 `:root` 和 `[data-color-scheme]` 的变量值
3. **查看层叠**: 使用开发者工具的 Computed 面板查看最终样式
4. **禁用样式表**: 临时禁用某个CSS文件，观察影响范围

---

## 最佳实践

### ✅ 推荐做法

- 使用语义化的类名（`.article-card` 而非 `.box1`）
- 通过CSS变量引用配色
- 使用模块化的CSS文件组织
- 添加清晰的注释说明
- 遵循响应式设计原则

### ❌ 避免做法

- 硬编码颜色值
- 在多个文件中重复相同样式
- 滥用 `!important`
- 在CSS中引用不存在的变量
- 跨文件修改其他模块的样式

---

## 问题排查清单

**样式不生效？**
1. 检查CSS文件加载顺序
2. 检查选择器优先级
3. 查看是否被后加载的样式覆盖
4. 检查是否使用了正确的CSS变量

**配色切换无效？**
1. 检查 `[data-color-scheme]` 属性是否正确设置
2. 检查样式是否使用了CSS变量
3. 检查 `color-schemes.css` 是否正确加载

**响应式布局异常？**
1. 检查断点值是否一致
2. 检查viewport meta标签
3. 使用开发者工具模拟不同设备

**代码高亮异常？**
1. 检查 `hugo.toml` 中的 highlight 配置
2. 确认使用的是内联样式（`noClasses = true`）
3. 检查是否有CSS覆盖了Chroma的样式

---

## 总结

本项目的CSS架构具有以下特点：

- **模块化**: 每个文件职责明确，便于维护
- **可复用**: 通过CSS变量和公共样式提高代码复用
- **可扩展**: 新增页面或组件只需添加对应CSS文件
- **可主题化**: 通过配色方案实现一键换肤
- **响应式**: 完善的移动端适配

通过遵循本文档的指导，可以保持代码的整洁性和可维护性。
