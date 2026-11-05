<script setup>
/* 任务视图：状态标签页 + 筛选工具栏 + 任务列表 + 空态 */

import { computed, onMounted, ref, watch } from 'vue';
import { useUiStore } from '../../stores/ui.js';
import { useSessionStore } from '../../stores/session.js';
import { useTasksStore } from '../../stores/tasks.js';
import { api } from '../../api.js';
import { t } from '../../i18n.js';
import TaskCard from '../tasks/TaskCard.vue';

const ui = useUiStore();
const session = useSessionStore();
const tasks = useTasksStore();

const TABS = ['pending', 'acked', 'done', 'all'];

const tabLabel = (s) => t(`tab.${s}`);

const agentOptions = computed(() => {
  // 选项按 agent 去重：一个工具可能有多个会话，但用户想筛的是「哪个工具」
  return [...new Set([...session.sources.values()].map((s) => s.agent))].sort();
});

const archivedCount = computed(() => session.me?.archived ?? 0);

/* 项目筛选：选项来自项目列表（任务都挂在项目下） */
const projectOptions = ref([]);
onMounted(async () => {
  try {
    const res = await api.get('/api/v1/projects');
    projectOptions.value = res.projects || [];
  } catch { /* 筛选项拉不到不影响列表 */ }
});

let searchTimer = null;
function onSearchInput(e) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    tasks.q = e.target.value.trim();
    tasks.loadTasks();
  }, 220);
}

function setTab(s) {
  tasks.status = s;
  tasks.loadTasks();
}

/** 点任务卡上的来源 chip：一键按该来源筛选 */
function filterByAgent(agent) {
  tasks.source = agent;
  tasks.loadTasks();
}

onMounted(() => {
  tasks.loadTasks();
});

// 来源列表可能后到（loadSources 异步），到了以后重新校验当前筛选值
watch(agentOptions, (agents) => {
  if (tasks.source && !agents.includes(tasks.source)) {
    tasks.source = '';
  }
});
</script>

<template>
  <!-- 工具栏 -->
  <div class="toolbar">
    <div class="tabs">
      <button
        v-for="s in TABS"
        :key="s"
        class="tab"
        :class="{ 'is-active': tasks.status === s }"
        type="button"
        @click="setTab(s)"
      >
        {{ tabLabel(s) }}
      </button>
    </div>
    <div class="toolbar-right">
      <!-- 没有已归档任务时整个按钮藏起来——一个永远点了没反应的按钮比没有更糟 -->
      <button
        v-if="archivedCount > 0"
        class="btn btn-sm btn-quiet btn-danger"
        type="button"
        @click="tasks.clearArchived()"
      >
        {{ t('toolbar.clearArchivedCount', { count: archivedCount }) }}
      </button>
      <select v-model="tasks.severity" class="select" :aria-label="t('toolbar.filterSeverity')" @change="tasks.loadTasks()">
        <option value="">{{ t('toolbar.allSeverities') }}</option>
        <option value="blocker">{{ t('severity.blocker') }}</option>
        <option value="need_human">{{ t('severity.need_human') }}</option>
        <option value="info">{{ t('severity.info') }}</option>
      </select>
      <!-- 项目筛选：任务都挂在项目下，按项目名过滤 -->
      <select v-model="tasks.project" class="select" :aria-label="t('toolbar.filterProject')" @change="tasks.loadTasks()">
        <option value="">{{ t('toolbar.allProjects') }}</option>
        <option v-for="p in projectOptions" :key="p.id" :value="p.name">{{ p.name }}</option>
      </select>
      <!-- 来源筛选：选项来自 /api/v1/me 的 sources（哪些 AI 工具推过任务） -->
      <select v-model="tasks.source" class="select" :aria-label="t('toolbar.filterSource')" @change="tasks.loadTasks()">
        <option value="">{{ t('toolbar.allSources') }}</option>
        <option v-for="agent in agentOptions" :key="agent" :value="agent">{{ agent }}</option>
      </select>
      <input
        id="filter-q"
        v-bind:value="tasks.q"
        class="input"
        type="search"
        :placeholder="t('toolbar.searchPlaceholder')"
        :aria-label="t('toolbar.searchLabel')"
        @input="onSearchInput"
      >
    </div>
  </div>

  <!-- 列表 -->
  <main class="main">
    <div class="list">
      <TaskCard
        v-for="task in tasks.tasks"
        :key="task.id"
        :task="task"
        :expanded="tasks.selectedId === task.id"
        :selected="tasks.selectedId === task.id"
        @filter-agent="filterByAgent"
      />
    </div>
    <div v-if="tasks.tasks.length === 0" class="empty">
      <div class="empty-mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
      </div>
      <p class="empty-title">{{ t('empty.title') }}</p>
      <p class="empty-sub">{{ t('empty.sub') }}</p>
    </div>
  </main>
</template>
