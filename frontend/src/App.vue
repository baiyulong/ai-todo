<script setup>
/* AI Todo · 根组件：登录态分流、全局快捷键、SSE 实时流、全局对话框 */

import { watch, onMounted, onUnmounted } from 'vue';
import { useUiStore } from './stores/ui.js';
import { useSessionStore } from './stores/session.js';
import { useTasksStore } from './stores/tasks.js';
import { setUnauthorizedHandler } from './api.js';
import { t } from './i18n.js';
import {
  registerServiceWorker,
  refreshNotifyPermission,
  playNotifySound,
  showDesktopNotification,
} from './composables/notify.js';
import { startHackerFx, stopHackerFx } from './composables/hackerFx.js';
import { startPaperFx, stopPaperFx } from './composables/paperFx.js';

import LoginView from './components/views/LoginView.vue';
import TopBar from './components/layout/TopBar.vue';
import Banners from './components/layout/Banners.vue';
import TasksView from './components/views/TasksView.vue';
import UsersView from './components/views/UsersView.vue';
import TokensView from './components/views/TokensView.vue';
import ProjectsView from './components/views/ProjectsView.vue';
import AppDrawer from './components/layout/AppDrawer.vue';
import ToastCenter from './components/layout/ToastCenter.vue';
import TaskFormDrawer from './components/dialogs/TaskFormDrawer.vue';
import ConfirmDialog from './components/dialogs/ConfirmDialog.vue';
import WechatBindDialog from './components/dialogs/WechatBindDialog.vue';
import TokenDialog from './components/dialogs/TokenDialog.vue';
import HelpDialog from './components/dialogs/HelpDialog.vue';

const ui = useUiStore();
const session = useSessionStore();
const tasks = useTasksStore();

/* ---------------- SSE 实时流 ---------------- */

let es = null;
let esWatchdog = null;
let esRetryTimer = null;
let pollTimer = null;

/**
 * 轮询兜底：SSE 被平台网关缓冲/拦截时（onopen/onerror 都不触发，状态永远停在
 * 「连接中」），改用定时拉取保证数据仍然新鲜；SSE 握上后自动停掉。
 */
function startPolling(on) {
  if (on && !pollTimer) {
    pollTimer = setInterval(async () => {
      if (document.hidden) return;
      try {
        await tasks.loadTasks();
        await session.loadMe();
      } catch { /* 下轮再试 */ }
    }, 30_000);
  } else if (!on && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function connectStream() {
  if (es) es.close();
  clearTimeout(esRetryTimer);
  ui.setLive('connecting');
  es = new EventSource('/api/v1/stream', { withCredentials: true });
  es.onopen = () => {
    clearTimeout(esWatchdog);
    ui.setLive('live');
    startPolling(false);
  };
  es.onerror = () => {
    clearTimeout(esWatchdog);
    ui.setLive('down');
    startPolling(true);
  };
  es.addEventListener('notification', (e) => {
    try {
      onNotification(JSON.parse(e.data));
    } catch { /* 忽略坏包 */ }
  });

  // 看门狗：EventSource 停在 CONNECTING 时既不触发 onopen 也不触发 onerror
  // （网关握着连接不吐响应头）。8 秒没握上就判死：标记断开、开轮询、稍后重试建流。
  esWatchdog = setTimeout(() => {
    if (ui.live === 'live') return;
    es?.close();
    es = null;
    ui.setLive('down');
    startPolling(true);
    esRetryTimer = setTimeout(connectStream, 30_000);
  }, 8_000);
}

async function onNotification(payload) {
  playNotifySound();
  await showDesktopNotification(payload);
  await tasks.loadTasks();
  await session.loadMe();
}

// 登录态切换：进入主界面建流，回到登录页断流
watch(
  () => session.authed,
  (authed) => {
    if (authed) {
      connectStream();
      registerServiceWorker();
      refreshNotifyPermission();
      tasks.applyDeepLink();
    } else if (es) {
      es.close();
      es = null;
    }
  },
);

/* ---------------- 全局快捷键 ---------------- */

function onKeydown(e) {
  if (e.target.matches('input, textarea, select')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === '/') {
    e.preventDefault();
    document.getElementById('filter-q')?.focus();
    return;
  }
  if (e.key === 'Escape') {
    if (ui.drawerMode) {
      ui.closeDrawer();
      return;
    }
    // 管理界面里按 Esc 也能回到任务列表，不用非得去点返回按钮
    if (ui.view !== 'tasks') ui.setView('tasks');
    return;
  }
  if (!session.authed) return;

  const index = tasks.tasks.findIndex((x) => x.id === tasks.selectedId);
  if (e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    if (tasks.tasks.length === 0) return;
    const dir = e.key === 'j' ? 1 : -1;
    const next = index < 0 ? 0 : Math.min(tasks.tasks.length - 1, Math.max(0, index + dir));
    tasks.selectTask(tasks.tasks[next].id);
    return;
  }
  if ((e.key === 'a' || e.key === 'd') && tasks.selectedId) {
    e.preventDefault();
    const task = tasks.tasks.find((x) => x.id === tasks.selectedId);
    if (!task) return;
    if (e.key === 'a' && task.status === 'pending') tasks.setStatus(task.id, 'ack');
    if (e.key === 'd' && task.status !== 'done') tasks.setStatus(task.id, 'done');
  }
}

/* 主题专属动态效果只在该主题下运行，切走即停 */
watch(
  () => ui.theme,
  (th) => {
    if (th === 'hacker') startHackerFx();
    else stopHackerFx();
    if (th === 'pixel') startPaperFx();
    else stopPaperFx();
  },
  { immediate: true },
);

/* ---------------- 启动 ---------------- */

onMounted(async () => {
  setUnauthorizedHandler(() => session.showLogin());
  document.addEventListener('keydown', onKeydown);
  await session.loadAuthProviders();
  await session.tryLogin();
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  stopHackerFx();
  stopPaperFx();
  clearTimeout(esWatchdog);
  clearTimeout(esRetryTimer);
  if (pollTimer) clearInterval(pollTimer);
  if (es) es.close();
});
</script>

<template>
  <!-- 登录页 -->
  <LoginView v-if="session.booted && !session.authed" />

  <!-- 主界面 -->
  <div v-else-if="session.authed" class="app">
    <TopBar />
    <Banners />

    <TasksView v-if="ui.view === 'tasks'" />
    <UsersView v-else-if="ui.view === 'users'" />
    <TokensView v-else-if="ui.view === 'tokens'" />
    <ProjectsView v-else-if="ui.view === 'projects'" />

    <!-- 手动新增任务（仅任务视图显示） -->
    <button
      v-if="ui.view === 'tasks'"
      class="fab"
      type="button"
      :title="t('task.addTitle')"
      @click="ui.openTaskDialog()"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14" /></svg>
    </button>
  </div>

  <!-- 抽屉与全局对话框挂在根层，视图切换不影响它们 -->
  <AppDrawer />
  <TaskFormDrawer />
  <ConfirmDialog />
  <WechatBindDialog />
  <TokenDialog />
  <HelpDialog />
  <ToastCenter />
</template>
