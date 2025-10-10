/**
 * ============================================================================
 * contact-modal.js - 联系我弹窗功能
 * ============================================================================
 *
 * 职责: 管理联系我弹窗的打开、关闭和交互
 *
 * 功能:
 * - 点击"联系我"链接打开弹窗
 * - 点击关闭按钮关闭弹窗
 * - 点击背景遮罩关闭弹窗
 * - ESC 键关闭弹窗
 * - 弹窗打开时禁止页面滚动
 *
 * 配合文件:
 * - HTML: /layouts/partials/common/contact-modal.html (弹窗HTML)
 * - CSS: /static/css/contact-modal.css (弹窗样式)
 *
 * 详细说明: 参见 /FILE_ORGANIZATION.md
 * ============================================================================
 */

(function() {
  'use strict';

  function initContactModal() {
    const contactLink = document.getElementById('contact-link');
    const modal = document.getElementById('contact-modal');
    const closeBtn = document.querySelector('.modal-close');

    if (!contactLink || !modal || !closeBtn) return;

    // 打开弹窗
    contactLink.addEventListener('click', (e) => {
      e.preventDefault();
      modal.classList.add('show');
      document.body.style.overflow = 'hidden'; // 防止背景滚动
    });

    // 关闭弹窗
    function closeModal() {
      modal.classList.remove('show');
      document.body.style.overflow = '';
    }

    // 点击关闭按钮
    closeBtn.addEventListener('click', closeModal);

    // 点击背景关闭
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal();
      }
    });

    // ESC键关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('show')) {
        closeModal();
      }
    });
  }

  // 页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initContactModal);
  } else {
    initContactModal();
  }
})();
