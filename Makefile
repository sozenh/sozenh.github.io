.PHONY: help serve build clean new deploy

# 默认目标
help:
	@echo "可用命令:"
	@echo "  make serve    - 启动本地开发服务器（支持热重载）"
	@echo "  make build    - 构建静态网站到 public/ 目录"
	@echo "  make clean    - 清理生成的文件"
	@echo "  make new      - 创建新文章（使用: make new TITLE='文章标题' PATH='技术/Go'）"
	@echo "  make deploy   - 部署到 GitHub Pages"

# 启动本地开发服务器
serve:
	@echo "🚀 启动 Hugo 开发服务器..."
	@echo "📍 访问地址: http://localhost:1313"
	hugo server --bind 0.0.0.0 --port 1313 --buildDrafts --buildFuture

# 构建静态网站
build:
	@echo "🔨 构建静态网站..."
	hugo --gc --minify

# 清理生成的文件
clean:
	@echo "🧹 清理生成文件..."
	rm -rf public/ resources/_gen/ .hugo_build.lock

# 创建新文章
# 使用方法: make new TITLE="文章标题" PATH="技术/Go"
new:
	@if [ -z "$(TITLE)" ]; then \
		echo "❌ 错误: 请指定文章标题"; \
		echo "使用方法: make new TITLE='文章标题' PATH='技术/Go'"; \
		exit 1; \
	fi
	@if [ -z "$(PATH)" ]; then \
		echo "❌ 错误: 请指定文章路径"; \
		echo "使用方法: make new TITLE='文章标题' PATH='技术/Go'"; \
		exit 1; \
	fi
	@FILENAME=$$(echo "$(TITLE)" | sed 's/ /-/g' | tr '[:upper:]' '[:lower:]').md; \
	FILEPATH="content/$(PATH)/$$FILENAME"; \
	mkdir -p "content/$(PATH)"; \
	echo "---" > "$$FILEPATH"; \
	echo "title: \"$(TITLE)\"" >> "$$FILEPATH"; \
	echo "date: $$(date +%Y-%m-%dT%H:%M:%S%:z)" >> "$$FILEPATH"; \
	echo "draft: false" >> "$$FILEPATH"; \
	echo "tags: []" >> "$$FILEPATH"; \
	echo "---" >> "$$FILEPATH"; \
	echo "" >> "$$FILEPATH"; \
	echo "## 概述" >> "$$FILEPATH"; \
	echo "" >> "$$FILEPATH"; \
	echo "在这里写文章内容..." >> "$$FILEPATH"; \
	echo "" >> "$$FILEPATH"; \
	echo "✅ 已创建新文章: $$FILEPATH"

# 部署到 GitHub Pages
deploy: clean build
	@echo "📦 准备部署到 GitHub Pages..."
	@if [ -z "$$(git status --porcelain)" ]; then \
		echo "✅ 工作目录干净，准备推送..."; \
	else \
		echo "⚠️  工作目录有未提交的更改"; \
		git status --short; \
		echo ""; \
		read -p "是否继续提交并部署? [y/N] " confirm; \
		if [ "$$confirm" != "y" ] && [ "$$confirm" != "Y" ]; then \
			echo "❌ 取消部署"; \
			exit 1; \
		fi; \
		git add .; \
		read -p "请输入提交信息: " message; \
		git commit -m "$$message"; \
	fi
	@echo "🚀 推送到 GitHub..."
	git push origin main
	@echo "✅ 部署完成！GitHub Actions 将自动构建并发布网站"
	@echo "📍 网站地址: https://sozenh.github.io"

# 快速开发流程
dev: clean serve
