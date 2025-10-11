/**
 * ============================================================================
 * sidebar-toggle.js - 侧边栏切换统一管理
 * ============================================================================
 *
 * 职责: 统一管理左侧菜单和右侧 TOC 的显示/隐藏
 *
 * 功能:
 * - 左下角菜单按钮 (☰) 控制左侧菜单面板
 * - 右下角 TOC 按钮 (📑) 控制右侧 TOC 面板
 * - 点击按钮切换面板显示状态
 * - 打开时图标变为关闭图标 (✖)
 * - 关闭时恢复原始图标
 *
 * 配合文件:
 * - HTML: /layouts/_default/baseof.html
 * - CSS: /static/css/custom.css (.book-menu, .book-toc, .menu-toggle-btn, .toc-toggle-btn)
 *
 * ============================================================================
 */

(function() {
  'use strict';

  function initSidebarToggle() {
    // 通用遮罩层
    const overlay = document.querySelector('.sidebar-overlay');

    // 左侧菜单相关元素
    const menuPanel = document.querySelector('.book-menu');
    const menuBtn = document.querySelector('.menu-toggle-btn');

    // 右侧 TOC 相关元素
    const tocPanel = document.querySelector('.book-toc');
    const tocBtn = document.querySelector('.toc-toggle-btn');

    // 初始化菜单按钮
    if (menuPanel && menuBtn) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = menuPanel.classList.contains('show');

        if (isOpen) {
          // 关闭菜单
          menuPanel.classList.remove('show');
          menuBtn.classList.remove('active');
          menuBtn.innerHTML = '☰';
          if (overlay) overlay.classList.remove('show');
        } else {
          // 打开菜单
          menuPanel.classList.add('show');
          menuBtn.classList.add('active');
          menuBtn.innerHTML = '✖';
          if (overlay) overlay.classList.add('show');
        }
      });

    }

    // 初始化 TOC 按钮
    if (tocPanel && tocBtn) {
      tocBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = tocPanel.classList.contains('show');

        if (isOpen) {
          // 关闭 TOC
          tocPanel.classList.remove('show');
          tocBtn.classList.remove('active');
          tocBtn.innerHTML = '📑';
          if (overlay) overlay.classList.remove('show');
        } else {
          // 打开 TOC
          tocPanel.classList.add('show');
          tocBtn.classList.add('active');
          tocBtn.innerHTML = '✖';
          if (overlay) overlay.classList.add('show');
        }
      });

      // 阻止 TOC 内部点击事件冒泡
      tocPanel.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }

    // 点击遮罩层关闭所有侧边栏
    if (overlay) {
      overlay.addEventListener('click', () => {
        // 关闭左侧菜单
        if (menuPanel && menuPanel.classList.contains('show')) {
          menuPanel.classList.remove('show');
          if (menuBtn) {
            menuBtn.classList.remove('active');
            menuBtn.innerHTML = '☰';
          }
        }
        // 关闭右侧 TOC
        if (tocPanel && tocPanel.classList.contains('show')) {
          tocPanel.classList.remove('show');
          if (tocBtn) {
            tocBtn.classList.remove('active');
            tocBtn.innerHTML = '📑';
          }
        }
        // 隐藏遮罩层
        overlay.classList.remove('show');
      });
    }
  }

  // 页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSidebarToggle);
  } else {
    initSidebarToggle();
  }
})();
