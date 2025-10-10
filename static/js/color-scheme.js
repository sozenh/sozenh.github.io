/**
 * ============================================================================
 * color-scheme.js - 配色方案选择器
 * ============================================================================
 *
 * 职责: 管理配色方案的选择、切换和持久化
 *
 * 功能:
 * - 渲染配色方案选择器 UI
 * - 处理配色方案切换
 * - 保存用户选择到 localStorage
 * - 页面加载时恢复上次的配色
 *
 * 配合文件:
 * - CSS: /static/css/color-schemes.css (配色定义)
 * - CSS: /static/css/color-picker.css (选择器样式)
 *
 * 详细说明: 参见 /FILE_ORGANIZATION.md
 * ============================================================================
 */

(function() {
  'use strict';

  const STORAGE_KEY = 'color-scheme';
  const schemes = [
    { id: 'default', name: '柔和蓝灰', color: '#5b7c99' },
    { id: 'misty', name: '雾霾蓝', color: '#6b8cae' },
    { id: 'moss', name: '苔藓绿', color: '#6b8e6f' },
    { id: 'warm', name: '暖灰棕', color: '#8d7b68' },
    { id: 'dusty', name: '淡紫灰', color: '#8b7e8f' },
    { id: 'slate', name: '石板青', color: '#5f8a8b' },
    { id: 'desert', name: '沙漠米', color: '#9b8b7e' },
    { id: 'ocean', name: '深海蓝', color: '#4a6fa5' },
    { id: 'olive', name: '橄榄绿', color: '#758467' },
    { id: 'charcoal', name: '炭灰色', color: '#6d7278' }
  ];

  // 获取当前配色
  function getColorScheme() {
    return localStorage.getItem(STORAGE_KEY) || 'default';
  }

  // 应用配色
  function applyColorScheme(schemeId) {
    const root = document.documentElement;
    const body = document.body;

    // 移除所有配色方案
    schemes.forEach(scheme => {
      root.removeAttribute('data-color-scheme');
    });

    // 应用新配色（default 是默认，不需要 data 属性）
    if (schemeId !== 'default') {
      root.setAttribute('data-color-scheme', schemeId);
      body.setAttribute('data-color-scheme', schemeId);
    }

    localStorage.setItem(STORAGE_KEY, schemeId);
  }

  // 创建配色选择器下拉菜单
  function createColorPicker() {
    const picker = document.createElement('div');
    picker.className = 'color-scheme-picker';
    picker.innerHTML = `
      <button class="color-scheme-btn" id="color-scheme-toggle" title="选择配色方案">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>
        </svg>
      </button>
      <div class="color-scheme-dropdown" id="color-scheme-dropdown">
        <div class="dropdown-header">选择配色</div>
        <div class="scheme-grid">
          ${schemes.map(scheme => `
            <button class="scheme-option ${scheme.id === getColorScheme() ? 'active' : ''}"
                    data-scheme="${scheme.id}"
                    title="${scheme.name}">
              <span class="scheme-color" style="background: ${scheme.color}"></span>
              <span class="scheme-name">${scheme.name}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `;

    return picker;
  }

  // 填充配色选项
  function populateSchemeGrid(gridElement, currentScheme) {
    gridElement.innerHTML = schemes.map(scheme => `
      <button class="scheme-option ${scheme.id === currentScheme ? 'active' : ''}"
              data-scheme="${scheme.id}"
              title="${scheme.name}">
        <span class="scheme-color" style="background: ${scheme.color}"></span>
      </button>
    `).join('');
  }

  // 绑定配色选择事件
  function bindColorPickerEvents(container) {
    const toggleBtn = container.querySelector('#color-scheme-toggle');
    const dropdown = container.querySelector('#color-scheme-dropdown');
    const schemeGrid = container.querySelector('#scheme-grid');

    if (!toggleBtn || !dropdown || !schemeGrid) return;

    // 填充配色选项
    populateSchemeGrid(schemeGrid, getColorScheme());

    // 切换下拉菜单
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('show');
    });

    // 点击外部关闭下拉菜单
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        dropdown.classList.remove('show');
      }
    });

    // 配色选择
    schemeGrid.addEventListener('click', (e) => {
      const option = e.target.closest('.scheme-option');
      if (!option) return;

      const schemeId = option.dataset.scheme;
      applyColorScheme(schemeId);

      // 更新激活状态
      schemeGrid.querySelectorAll('.scheme-option').forEach(opt =>
        opt.classList.remove('active')
      );
      option.classList.add('active');

      // 关闭下拉菜单
      dropdown.classList.remove('show');
    });
  }

  // 初始化配色选择器
  function initColorPicker() {
    // 应用保存的配色
    const currentScheme = getColorScheme();
    applyColorScheme(currentScheme);

    // 查找已存在的配色选择器容器
    const existingPicker = document.getElementById('color-picker-container');
    if (existingPicker) {
      bindColorPickerEvents(existingPicker);
      return;
    }

    // 如果没有现成的容器，动态创建（用于文档页面）
    const headerControls = document.querySelector('.header-controls');
    if (headerControls) {
      const picker = createColorPicker();
      const themeToggle = headerControls.querySelector('#theme-toggle');
      if (themeToggle) {
        headerControls.insertBefore(picker, themeToggle);
      } else {
        headerControls.appendChild(picker);
      }
      bindColorPickerEvents(picker);
    }
  }

  // 页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initColorPicker);
  } else {
    initColorPicker();
  }
})();
