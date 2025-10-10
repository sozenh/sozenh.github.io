/**
 * ============================================================================
 * menu-resize.js - 左侧菜单宽度调节功能
 * ============================================================================
 *
 * 职责: 允许用户通过拖拽调节左侧菜单的宽度
 *
 * 功能:
 * - 创建拖拽手柄（固定定位在菜单右边缘）
 * - 监听鼠标拖拽事件
 * - 限制菜单宽度范围（180px - 400px）
 * - 保存用户设置到 localStorage
 * - 移动端自动禁用
 *
 * 配合文件:
 * - CSS: /static/css/custom.css (.menu-resize-handle 样式)
 *
 * 详细说明: 参见 /FILE_ORGANIZATION.md
 * ============================================================================
 */

(function() {
  'use strict';

  const STORAGE_KEY = 'menu-width';
  const MIN_WIDTH = 180;
  const MAX_WIDTH = 400;

  function initMenuResize() {
    const menu = document.querySelector('.book-menu');
    if (!menu) {
      console.log('Menu resize: .book-menu not found');
      return;
    }

    // 移动端不启用拖拽功能
    if (window.innerWidth <= 896) { // 56rem = 896px
      console.log('Menu resize: Skipped on mobile');
      return;
    }

    console.log('Menu resize: Initializing...');

    // 创建拖拽手柄
    const handle = document.createElement('div');
    handle.className = 'menu-resize-handle';
    handle.setAttribute('title', '拖动调节菜单宽度');
    document.body.appendChild(handle); // 添加到 body，便于 fixed 定位

    // 恢复保存的宽度
    const savedWidth = localStorage.getItem(STORAGE_KEY);
    if (savedWidth) {
      const width = parseInt(savedWidth);
      menu.style.flex = `0 0 ${width}px`;
      menu.style.flexBasis = width + 'px';
      menu.style.width = width + 'px';
      menu.style.minWidth = width + 'px';
      menu.style.maxWidth = width + 'px';
      console.log('Menu resize: Restored width:', savedWidth);
    }

    // 更新手柄位置
    function updateHandlePosition() {
      const menuRect = menu.getBoundingClientRect();
      handle.style.left = menuRect.right + 'px';
    }

    // 延迟初始化，确保 DOM 完全加载
    setTimeout(() => {
      updateHandlePosition();
      console.log('Menu resize: Handle positioned');
    }, 100);

    window.addEventListener('resize', updateHandlePosition);
    window.addEventListener('scroll', updateHandlePosition);

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    // 监听拖拽手柄
    handle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = menu.offsetWidth;
      handle.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
      console.log('Menu resize: Started dragging, initial width:', startWidth);
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;

      const delta = e.clientX - startX;
      const newWidth = Math.min(Math.max(startWidth + delta, MIN_WIDTH), MAX_WIDTH);

      // 使用多种方式设置宽度，确保生效
      menu.style.flex = `0 0 ${newWidth}px`;
      menu.style.flexBasis = newWidth + 'px';
      menu.style.width = newWidth + 'px';
      menu.style.minWidth = newWidth + 'px';
      menu.style.maxWidth = newWidth + 'px';

      updateHandlePosition();
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        handle.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        const finalWidth = menu.offsetWidth;
        console.log('Menu resize: Finished dragging, final width:', finalWidth);

        // 保存宽度
        localStorage.setItem(STORAGE_KEY, finalWidth);
      }
    });
  }

  // 页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMenuResize);
  } else {
    initMenuResize();
  }
})();
