<script setup>
/* 任务卡：收起时只有标题+元信息，点开看详情与操作 */

import { computed, ref } from 'vue';
import { useUiStore } from '../../stores/ui.js';
import { useSessionStore } from '../../stores/session.js';
import { useTasksStore, computeSnooze } from '../../stores/tasks.js';
import { t } from '../../i18n.js';

const props = defineProps({
  task: { type: Object, required: true },
  expanded: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
});
const emit = defineEmits(['filter-agent']);

const ui = useUiStore();
const session = useSessionStore();
const tasks = useTasksStore();

const isArchived = computed(() => props.task.status === 'archived');
const source = computed(() => session.sources.get(props.task.source_id));

/* Lucide 图标路径：垃圾桶 / 垃圾桶带叉 / 机器人 / 文件夹 / 下箭头 */
const TRASH_ICON = ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6'];
const TRASH_X_ICON = ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'm10 11 5 5', 'm15 11-5 5'];
const BOT_ICON = [
  'M12 8V4H8',
  'M9 7h6a5 5 0 0 1 5 5v1a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-1a5 5 0 0 1 5-5Z',
  'M9 12h.01',
  'M15 12h.01',
  'M9 17v2',
  'M15 17v2',
];
const FOLDER_ICON = ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'];
const CHEVRON_ICON = ['m6 9 6 6 6-6'];

const sevLabel = computed(() => {
  const key = `severity.${props.task.severity}`;
  const s = t(key);
  return s === key ? props.task.severity : s;
});
const stLabel = computed(() => {
  const key = `status.${props.task.status}`;
  const s = t(key);
  return s === key ? props.task.status : s;
});

const dueText = computed(() =>
  props.task.due_at ? t('task.remindAt', { time: formatTime(props.task.due_at) }) : '',
);

function formatTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function onHeaderClick() {
  // 在标题上拖选了文字时不切换，避免想复制标题却把卡片收起来了
  const sel = window.getSelection?.();
  if (sel && String(sel).length > 0) return;
  tasks.selectTask(props.task.id);
}

/* ---------------- 贪睡 ---------------- */

const snoozeOpen = ref(false);
const SNOOZE_PRESETS = () => [
  [t('action.snooze1h'), 1],
  [t('action.snoozeTonight'), 'tonight'],
  [t('action.snoozeMorning'), 'morning'],
];

async function snooze(kind) {
  try {
    const until = computeSnooze(kind);
    await tasks.snoozeTask(props.task.id, until);
    snoozeOpen.value = false;
  } catch (err) {
    ui.toast(err.message || String(err), true);
  }
}

/* ---------------- 转交 ---------------- */

const transferTo = ref('');
const transferTargets = computed(() =>
  // 选人下拉排除自己
  session.users.filter((u) => u.id !== session.me?.user_id),
);
const transferDisabled = computed(() => session.users.length <= 1);
const targetLabel = (u) => (u.display_name ? `${u.username}（${u.display_name}）` : u.username);

async function doTransfer() {
  if (!transferTo.value) {
    ui.toast(t('task.transferPick'), true);
    return;
  }
  await tasks.transferTask(props.task.id, transferTo.value);
  transferTo.value = '';
}

/* ---------------- 回复 ---------------- */

/* 回复即完成：AI 侧可能正挂起等待这条回复 */
const replyText = ref('');

async function doReply() {
  const text = replyText.value.trim();
  if (!text) return;
  await tasks.replyTask(props.task.id, text);
  replyText.value = '';
}
</script>

<template>
  <article
    class="task"
    :data-id="task.id"
    :data-severity="task.severity"
    :class="{ 'is-done': task.status === 'done', 'is-archived': isArchived, 'is-selected': selected }"
  >
    <!-- 只有标题行负责展开/收起：卡片内容区保持安静的文本区，可以随意选中复制 -->
    <div class="task-top" @click="onHeaderClick">
      <h3 class="task-title">{{ task.title }}</h3>

      <!-- 删除：右上角图标，鼠标移到卡片上才显现。
           未归档 → 垃圾桶（软删除，可找回）；已归档 → 垃圾桶带叉（彻底删除）。 -->
      <button
        class="task-del"
        :class="{ 'is-hard': isArchived }"
        type="button"
        :title="isArchived ? t('task.hardDeleteTitle') : t('task.deleteTitle')"
        :aria-label="isArchived ? t('task.hardDeleteLabel') : t('task.deleteLabel')"
        @click.stop="isArchived ? tasks.hardDeleteTask(task.id) : tasks.archiveTask(task.id)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="(d, i) in isArchived ? TRASH_X_ICON : TRASH_ICON" :key="i" :d="d" />
        </svg>
      </button>

      <!-- 展开箭头：告诉用户「这张卡片点开还有内容」，展开时翻转朝上 -->
      <span class="task-caret" :class="{ 'is-open': expanded }" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path v-for="(d, i) in CHEVRON_ICON" :key="i" :d="d" />
        </svg>
      </span>
    </div>

    <!-- 元信息（收起状态下也一直可见的基本信息） -->
    <div class="task-meta">
      <span class="tag" :class="`sev-${task.severity}`">{{ sevLabel }}</span>
      <span v-if="task.status !== 'pending'" class="tag" :class="`st-${task.status}`">{{ stLabel }}</span>

      <!-- 来源与项目：两者必须一眼分得开。点来源 chip 就按这个来源筛选 -->
      <button
        v-if="source"
        class="src-chip"
        type="button"
        :title="t('task.sourceTitle', { agent: source.agent, session: source.session_key })"
        @click.stop="emit('filter-agent', source.agent)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="(d, i) in BOT_ICON" :key="i" :d="d" />
        </svg>
        <span>{{ source.label || source.agent }}</span>
      </button>

      <span v-if="task.project" class="src-chip is-project" :title="t('task.projectTitle', { project: task.project })">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="(d, i) in FOLDER_ICON" :key="i" :d="d" />
        </svg>
        <span>{{ task.project }}</span>
      </span>

      <span v-if="dueText" class="meta-sep">·</span>
      <span v-if="dueText">{{ dueText }}</span>

      <a
        v-for="(link, i) in task.links || []"
        :key="i"
        class="link-chip"
        :href="link.url"
        target="_blank"
        rel="noopener noreferrer"
        :title="link.url"
      >{{ link.label || link.url }}</a>
    </div>

    <!-- 展开区：详情和操作按钮只在点开卡片后出现 -->
    <template v-if="expanded">
      <p v-if="task.detail" class="task-detail">{{ task.detail }}</p>

      <!-- 已有回复：气泡展示（回复过任务 = 已完成并答复了 AI） -->
      <div v-if="task.reply_text" class="task-reply">
        <div class="task-reply-head">{{ t('task.replyLabel') }} · {{ formatTime(task.replied_at) }}</div>
        <div class="task-reply-body">{{ task.reply_text }}</div>
      </div>

      <div class="task-actions">
        <button v-if="task.status === 'pending'" class="btn" type="button" @click.stop="tasks.setStatus(task.id, 'ack')">
          {{ t('action.ack') }}
        </button>
        <button v-if="task.status !== 'done' && task.status !== 'archived'" class="btn" type="button" @click.stop="tasks.setStatus(task.id, 'done')">
          {{ t('action.done') }}
        </button>
        <button v-if="task.status === 'pending'" class="btn" type="button" @click.stop="snoozeOpen = !snoozeOpen">
          {{ t('action.snooze') }}
        </button>

        <!-- 转交：选人 + 转交按钮。目标用户会收到站内通知和邮件。 -->
        <span v-if="task.status === 'pending' || task.status === 'acked'" class="task-transfer">
          <select
            v-model="transferTo"
            class="select"
            :aria-label="t('task.transferLabel')"
            :disabled="transferDisabled"
            :title="transferDisabled ? t('task.transferDisabledHint') : undefined"
          >
            <option value="">{{ t('task.transferPlaceholder') }}</option>
            <option v-for="u in transferTargets" :key="u.id" :value="u.id">{{ targetLabel(u) }}</option>
          </select>
          <button class="btn" type="button" :disabled="transferDisabled" @click.stop="doTransfer">
            {{ t('task.transfer') }}
          </button>
        </span>
      </div>

      <!-- 贪睡预设行 -->
      <div v-if="snoozeOpen" class="snooze-row task-actions">
        <button
          v-for="[label, kind] in SNOOZE_PRESETS()"
          :key="kind"
          class="btn btn-sm"
          type="button"
          @click.stop="snooze(kind)"
        >{{ label }}</button>
      </div>

      <!-- 回复输入：多行文本框，Ctrl/Cmd+Enter 或按钮提交；回复后任务标记完成，等待中的 AI 会立刻收到 -->
      <div v-if="task.status === 'pending' || task.status === 'acked'" class="task-reply-row">
        <textarea
          v-model="replyText"
          class="input"
          rows="3"
          maxlength="8000"
          :placeholder="t('task.replyPlaceholder')"
          :aria-label="t('task.replyLabel')"
          @keydown.ctrl.enter.prevent="doReply"
          @keydown.meta.enter.prevent="doReply"
        ></textarea>
        <button class="btn btn-primary" type="button" :disabled="!replyText.trim()" @click="doReply">
          {{ t('task.reply') }}
        </button>
      </div>
    </template>
  </article>
</template>
