# 首页配置说明

## 配置文件位置

`data/homepage.yaml` - 首页所有文本内容的配置文件

## 如何修改首页内容

直接编辑 `data/homepage.yaml` 文件，修改后重新运行 `hugo` 命令即可生效。

### 主要配置项说明

#### 1. 导航栏 (nav)
```yaml
nav:
  site_title: "我的技术博客"  # 网站标题（左上角）
  tech_link: "技术"           # 技术链接文本
  essay_link: "随笔"          # 随笔链接文本
  contact_link: "联系我"      # 联系我链接文本
```

#### 2. 英雄区域 (hero) - 首页顶部大标题区域
```yaml
hero:
  # 头像设置
  avatar_type: "github"      # 头像类型："github" 或 "emoji"
  avatar_emoji: "👨‍💻"       # emoji头像（当avatar_type为"emoji"时使用）
  github_username: "sozenh"  # GitHub用户名（当avatar_type为"github"时使用）

  # 文本内容
  title: "你好，我是技术博主"  # 主标题
  subtitle: "一个热爱技术、热爱编程的开发者"  # 副标题
  description: "..."         # 描述文本（支持HTML标签）
  tech_button: "📚 技术文章"  # 技术文章按钮文本
  essay_button: "✍️ 随笔感悟" # 随笔感悟按钮文本
```

**头像类型说明：**
- `avatar_type: "github"` - 使用GitHub头像，会从 `https://github.com/用户名.png` 获取
- `avatar_type: "emoji"` - 使用emoji表情作为头像

**描述文本提示：**
- 可以使用 `<strong>文本</strong>` 来加粗
- 可以使用 `<br>` 来换行

#### 3. 特色区域 (features) - 三个特色卡片
```yaml
features:
  section_title: "博客特色"  # 区域标题

  feature1:                  # 第一个特色卡片
    icon: "💻"              # 图标emoji
    title: "技术深度"        # 卡片标题
    description: "..."      # 卡片描述

  feature2:                  # 第二个特色卡片
    icon: "📝"
    title: "系统学习"
    description: "..."

  feature3:                  # 第三个特色卡片
    icon: "🚀"
    title: "项目实践"
    description: "..."
```

#### 4. 最新文章区域 (articles)
```yaml
articles:
  section_title: "最新文章"  # 区域标题
  max_display: 6             # 最多显示几篇文章
```

#### 5. 页脚 (footer)
```yaml
footer:
  copyright: "持续学习，不断进步 🌱"  # 版权信息
```

#### 6. 联系方式 (contact) - 联系我弹窗
```yaml
contact:
  modal_title: "联系我"      # 弹窗标题

  email:
    label: "邮箱"            # 邮箱标签
    address: "your.email@example.com"  # 你的邮箱地址

  github:
    label: "GitHub"          # GitHub标签
    url: "https://github.com/yourusername"     # 你的GitHub地址
    display: "github.com/yourusername"         # 显示文本
```

## 快速开始

### 1. 修改联系方式（最重要）
找到配置文件中的 `contact` 部分，修改为你的真实信息：

```yaml
contact:
  email:
    address: "zhangsan@example.com"  # 改成你的邮箱

  github:
    url: "https://github.com/zhangsan"      # 改成你的GitHub地址
    display: "github.com/zhangsan"          # 改成你的GitHub用户名
```

### 2. 修改个人信息
找到 `hero` 部分，修改个人介绍：

**使用GitHub头像（推荐）：**
```yaml
hero:
  avatar_type: "github"        # 使用GitHub头像
  github_username: "sozenh"    # 改成你的GitHub用户名
  title: "你好，我是张三"       # 改成你的名字
  subtitle: "全栈开发工程师"    # 改成你的职位
```

**或者使用emoji头像：**
```yaml
hero:
  avatar_type: "emoji"   # 使用emoji头像
  avatar_emoji: "🚀"     # 改成你喜欢的emoji
  title: "你好，我是张三"
  subtitle: "全栈开发工程师"
```

### 3. 修改特色卡片
根据你的博客定位，修改三个特色卡片的内容：

```yaml
features:
  feature1:
    icon: "🎨"
    title: "前端设计"
    description: "专注于React和Vue框架的学习和实践"
```

### 4. 重新构建
修改完成后，运行以下命令：

```bash
hugo
```

或者如果开发服务器正在运行，它会自动重新构建。

## 注意事项

1. **YAML格式要求**：
   - 缩进必须使用**空格**，不能用Tab
   - 冒号后面必须有一个空格
   - 字符串中如果包含特殊字符（如引号），需要用引号包裹

2. **Emoji选择**：
   - 可以在 [Emojipedia](https://emojipedia.org/) 找到更多emoji
   - 直接复制粘贴到配置文件中即可

3. **测试修改**：
   - 建议每次修改后立即查看效果
   - 如果页面显示异常，检查YAML格式是否正确

## 常见问题

**Q: 修改后页面没有变化？**
A: 确保重新运行了 `hugo` 命令，或者强制刷新浏览器（Ctrl+F5）

**Q: 页面显示空白或错误？**
A: 检查YAML文件格式是否正确，特别注意缩进和引号

**Q: 想添加更多联系方式？**
A: 需要修改 `layouts/index.html` 模板文件，这需要一些HTML知识

**Q: 想修改配色？**
A: 点击首页右上角的🎨图标，可以选择不同的配色方案
