/**
 * ============================================================================
 * toc-toggle.js - TOC 浮动按钮切换功能
 * ============================================================================
 *
 * 职责: 管理右侧 TOC（目录）的显示/隐藏
 *
 * 功能:
 * - 创建右下角浮动按钮
 * - 点击按钮切换 TOC 显示状态
 * - 打开时显示关闭图标（✖），关闭时显示目录图标（📑）
 * - 移动端自动隐藏（通过 CSS media query）
 *
 * 配合文件:
 * - CSS: /static/css/custom.css (.book-toc, .toc-toggle-btn 样式)
 *
 * 详细说明: 参见 /FILE_ORGANIZATION.md
 * ============================================================================
 */

(function() {
  'use strict';

  function initTocToggle() {
    const toc = document.querySelector('.book-toc');
    if (!toc) return;

    // 创建浮动按钮
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'toc-toggle-btn';
    toggleBtn.innerHTML = '📑';
    toggleBtn.setAttribute('aria-label', '目录');
    toggleBtn.setAttribute('title', '显示/隐藏目录');

    document.body.appendChild(toggleBtn);

    // 关闭 TOC 的函数
    function closeToc() {
      toc.classList.remove('show');
      toggleBtn.classList.remove('active');
      toggleBtn.innerHTML = '📑';
    }

    // 打开 TOC 的函数
    function openToc() {
      toc.classList.add('show');
      toggleBtn.classList.add('active');
      toggleBtn.innerHTML = '✖';
    }

    // 切换 TOC 显示/隐藏 - 只能通过按钮控制
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (toc.classList.contains('show')) {
        closeToc();
      } else {
        openToc();
      }
    });

    // 阻止 TOC 内部点击事件冒泡
    toc.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  // 页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTocToggle);
  } else {
    initTocToggle();
  }
})();
