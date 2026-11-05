/* 任务状态：列表、筛选、选中/展开、各类任务操作 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, translateError } from '../api.js';
import { t } from '../i18n.js';
import { useUiStore } from './ui.js';
import { useSessionStore } from './session.js';

export const useTasksStore = defineStore('tasks', () => {
  const ui = useUiStore();
  const session = useSessionStore();

  const tasks = ref([]);
  const status = ref('pending');
  const severity = ref('');
  const source = ref('');
  const project = ref('');
  const q = ref('');
  /** 展开（选中）的任务 id；null 表示全部收起 */
  const selectedId = ref(null);

  const loadTasks = async () => {
    const params = new URLSearchParams();
    if (status.value !== 'all') params.set('status', status.value);
    if (severity.value) params.set('severity', severity.value);
    if (source.value) params.set('source', source.value);
    if (project.value) params.set('project', project.value);
    if (q.value) params.set('q', q.value);
    params.set('limit', '200');
    try {
      const { tasks: list } = await api.get(`/api/v1/tasks?${params}`);
      tasks.value = list || [];
    } catch (err) {
      if (err.code !== 'unauthorized') ui.toast(translateError(err), true);
    }
  };

  function selectTask(id) {
    selectedId.value = selectedId.value === id ? null : id;
    history.replaceState(null, '', selectedId.value ? `/t/${selectedId.value}` : '/');
  }

  /** 深链 /t/<uuid>：切到「全部」标签并展开对应卡片 */
  async function applyDeepLink() {
    const m = /^\/t\/([0-9a-f-]{36})/.exec(location.pathname);
    if (!m) return;
    selectedId.value = m[1];
    status.value = 'all';
    await loadTasks();
    // 等卡片渲染出来再滚动定位
    requestAnimationFrame(() => {
      document.querySelector(`.task[data-id="${m[1]}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  async function setStatus(id, taskStatus) {
    try {
      // 调用方传的是状态常量 'ack' / 'done'，接口路径同名。
      const endpoint = taskStatus === 'done' ? 'done' : 'ack';
      await api.post(`/api/v1/tasks/${id}/${endpoint}`);
      await loadTasks();
      await session.loadMe();
    } catch (err) {
      ui.toast(translateError(err), true);
    }
  }

  async function archiveTask(id) {
    try {
      await api.post(`/api/v1/tasks/${id}/archive`);
      await loadTasks();
      await session.loadMe();
      // 必须给反馈：卡片凭空消失、没有提示的话容易被当成「没点上」。
      // 删除提示比默认久一点：它带着「可以去哪儿找回来」的信息。
      ui.toast(t('task.deletedToast'), false, 5000);
    } catch (err) {
      ui.toast(translateError(err), true);
    }
  }

  /** 彻底删除（不可恢复）。只对已归档的任务开放，必须二次确认。 */
  async function hardDeleteTask(id) {
    const ok = await ui.confirmAction({
      title: t('confirm.hardDeleteTitle'),
      text: t('confirm.hardDeleteText'),
      okLabel: t('confirm.hardDeleteOk'),
    });
    if (!ok) return;
    try {
      await api.del(`/api/v1/tasks/${id}`);
      await loadTasks();
      await session.loadMe();
      ui.toast(t('confirm.hardDeletedToast'), false, 2400);
    } catch (err) {
      ui.toast(translateError(err), true);
    }
  }

  async function transferTask(id, toUserId) {
    if (!toUserId) {
      ui.toast(t('task.transferPick'), true);
      return;
    }
    try {
      await api.post(`/api/v1/tasks/${id}/transfer`, { to_user_id: toUserId });
      const target = session.users.find((u) => u.id === toUserId);
      ui.toast(t('task.transferredToast', { user: target?.username ?? '' }));
      await loadTasks();
    } catch (err) {
      ui.toast(translateError(err), true);
    }
  }

  async function snoozeTask(id, until) {
    await api.post(`/api/v1/tasks/${id}/snooze`, { until: until.toISOString() });
    ui.toast(t('action.snoozedToast', { time: formatTime(until.toISOString()) }));
    await loadTasks();
  }

  async function clearArchived() {
    const n = session.me?.archived ?? 0;
    if (n <= 0) return;
    const ok = await ui.confirmAction({
      title: t('confirm.purgeTitle', { count: n }),
      text: t('confirm.purgeText'),
      okLabel: t('confirm.purgeOk'),
    });
    if (!ok) return;
    try {
      const r = await api.del('/api/v1/tasks/archived');
      await loadTasks();
      await session.loadMe();
      ui.toast(t('confirm.purgedToast', { count: r.deleted ?? 0 }), false, 3000);
    } catch (err) {
      ui.toast(translateError(err), true);
    }
  }

  /** 回复任务：写入答复并标记完成——正在等待的 AI 会立刻收到这条回复 */
  async function replyTask(id, text) {
    try {
      await api.post(`/api/v1/tasks/${id}/reply`, { reply: text });
      ui.toast(t('task.repliedToast'));
      await loadTasks();
      await session.loadMe();
    } catch (err) {
      ui.toast(translateError(err), true);
    }
  }

  async function addTask(payload) {
    await api.post('/api/v1/tasks', payload);
    await loadTasks();
    await session.loadMe();
    ui.toast(t('taskDialog.addedToast'));
  }

  return {
    tasks,
    status,
    severity,
    source,
    project,
    q,
    selectedId,
    loadTasks,
    selectTask,
    applyDeepLink,
    setStatus,
    archiveTask,
    hardDeleteTask,
    transferTask,
    snoozeTask,
    clearArchived,
    replyTask,
    addTask,
  };
});

function formatTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 贪睡时间点计算：1 小时后 / 今晚 20:00 / 明早 09:00 */
export function computeSnooze(kind) {
  const d = new Date();
  if (kind === 1) { d.setHours(d.getHours() + 1); return d; }
  if (kind === 'tonight') {
    d.setHours(20, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d;
  }
  d.setHours(9, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

export function formatTimeShort(iso) {
  return formatTime(iso);
}
