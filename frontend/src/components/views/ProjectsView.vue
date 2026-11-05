<script setup>
/* 项目管理：项目是任务的一等维度，任务必须挂在项目下 */

import { ref, onMounted } from 'vue';
import { api, translateError } from '../../api.js';
import { t } from '../../i18n.js';
import { useUiStore } from '../../stores/ui.js';

const ui = useUiStore();

const name = ref('');
const projects = ref([]);
const loading = ref(true);

async function loadProjects() {
  loading.value = true;
  try {
    const res = await api.get('/api/v1/projects');
    projects.value = res.projects || [];
  } catch (err) {
    ui.toast(translateError(err), true);
    projects.value = [];
  } finally {
    loading.value = false;
  }
}

async function create() {
  const n = name.value.trim();
  if (!n) return;
  try {
    await api.post('/api/v1/projects', { name: n });
    name.value = '';
    ui.toast(t('project.createdToast'));
    await loadProjects();
  } catch (err) {
    ui.toast(translateError(err), true);
  }
}

async function removeProject(p) {
  const ok = await ui.confirmAction({
    title: t('project.deleteTitle', { name: p.name }),
    text: t('project.deleteText', { count: p.task_count ?? 0 }),
    okLabel: t('project.delete'),
  });
  if (!ok) return;
  try {
    await api.del(`/api/v1/projects/${p.id}`);
    ui.toast(t('project.deletedToast'));
    await loadProjects();
  } catch (err) {
    ui.toast(translateError(err), true);
  }
}

onMounted(loadProjects);
</script>

<template>
  <section class="page">
    <div class="page-head">
      <button class="btn btn-sm btn-quiet" type="button" @click="ui.setView('tasks')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
        <span>{{ t('page.back') }}</span>
      </button>
      <h2>{{ t('page.projectsTitle') }}</h2>
    </div>
    <div class="page-body">
      <div class="mgmt-card">
        <p class="hint">{{ t('project.hint') }}</p>

        <div v-if="loading" class="hint">{{ t('rules.loading') }}</div>
        <div v-else-if="projects.length === 0" class="hint">{{ t('project.empty') }}</div>
        <div v-else>
          <div v-for="p in projects" :key="p.id" class="token-row">
            <div class="token-info">
              <div class="token-name">
                {{ p.name }}
                <span v-if="p.is_default" class="tag">{{ t('project.defaultBadge') }}</span>
              </div>
              <div class="token-meta">{{ t('project.taskCount', { count: p.task_count ?? 0 }) }}</div>
            </div>
            <div class="token-actions">
              <button
                v-if="!p.is_default"
                class="btn btn-sm btn-quiet btn-danger"
                type="button"
                @click="removeProject(p)"
              >{{ t('project.delete') }}</button>
            </div>
          </div>
        </div>

        <input
          v-model="name"
          class="input"
          type="text"
          maxlength="120"
          style="margin-top: 14px"
          :placeholder="t('project.namePlaceholder')"
          @keyup.enter="create"
        >
        <button class="btn btn-primary btn-block" type="button" style="margin-top: 10px" @click="create">
          {{ t('project.create') }}
        </button>
      </div>
    </div>
  </section>
</template>
