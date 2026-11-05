/* UI 全局状态：提示、确认框、抽屉、视图切换、主题、实时连接与通知权限 */

import { defineStore } from 'pinia';
import { ref } from 'vue';

const THEME_KEY = 'ai_todo_theme';

export const useUiStore = defineStore('ui', () => {
  /* ---------------- toast ---------------- */
  const toasts = ref([]);
  let toastSeq = 0;

  function toast(message, isError = false, ms = isError ? 4200 : 2400) {
    const id = ++toastSeq;
    toasts.value.push({ id, message, isError });
    setTimeout(() => {
      const el = toasts.value.find((x) => x.id === id);
      if (el) {
        el.leaving = true;
        setTimeout(() => {
          toasts.value = toasts.value.filter((x) => x.id !== id);
        }, 320);
      }
    }, ms);
  }

  /* ---------------- 确认框（替代 window.confirm 的统一入口） ---------------- */
  const confirmState = ref(null); // { title, text, okLabel, danger }
  let confirmResolve = null;

  function confirmAction({ title, text, okLabel, danger = true }) {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      confirmState.value = { title, text, okLabel: okLabel || '', danger };
    });
  }

  function resolveConfirm(ok) {
    confirmState.value = null;
    if (confirmResolve) {
      confirmResolve(ok);
      confirmResolve = null;
    }
  }

  /* ---------------- 手动新增任务对话框 ---------------- */
  const taskDialogOpen = ref(false);
  function openTaskDialog() {
    taskDialogOpen.value = true;
  }
  function closeTaskDialog() {
    taskDialogOpen.value = false;
  }

  /* ---------------- 抽屉：rules / settings / null ---------------- */
  const drawerMode = ref(null);

  function openDrawer(mode) {
    drawerMode.value = mode;
  }
  function closeDrawer() {
    drawerMode.value = null;
  }

  /* ---------------- 主区视图：tasks / users / tokens ---------------- */
  const view = ref('tasks');

  function setView(v) {
    view.value = v;
  }

  /* ---------------- 主题 ---------------- */
  const theme = ref(readTheme());

  function readTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved && ['product', 'pixel', 'hacker'].includes(saved)) return saved;
    } catch { /* 隐私模式忽略 */ }
    return 'pixel';
  }

  function setTheme(value) {
    theme.value = value;
    try {
      localStorage.setItem(THEME_KEY, value);
    } catch { /* 忽略 */ }
    document.documentElement.dataset.theme = value;
    // theme-color 跟随主题，PWA 状态栏观感一致
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const colors = { product: '#f5f5f7', pixel: '#1a1c2c', hacker: '#000000' };
      meta.setAttribute('content', colors[value] || '#f5f5f7');
    }
  }

  /* ---------------- 实时连接状态 ---------------- */
  const live = ref('connecting'); // live / down / connecting
  function setLive(stateName) {
    live.value = stateName;
  }

  /* ---------------- 通知权限（Permissions API 的实时值） ---------------- */
  const notifyPerm = ref('Notification' in window ? (window.isSecureContext ? Notification.permission : 'insecure') : 'unsupported');
  // 用户点过「稍后再说」就不再打扰；权限变化或重新授权后重置
  const notifyBannerDismissed = ref(false);

  function setNotifyPerm(stateName) {
    notifyPerm.value = stateName;
  }

  return {
    toasts,
    toast,
    confirmState,
    confirmAction,
    resolveConfirm,
    drawerMode,
    openDrawer,
    closeDrawer,
    taskDialogOpen,
    openTaskDialog,
    closeTaskDialog,
    view,
    setView,
    theme,
    setTheme,
    live,
    setLive,
    notifyPerm,
    setNotifyPerm,
    notifyBannerDismissed,
  };
});
