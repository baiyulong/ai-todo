<script setup>
/* 手动新增任务：左侧抽屉表单 */

import { ref, watch, nextTick, onUnmounted } from 'vue';
import { useUiStore } from '../../stores/ui.js';
import { useTasksStore } from '../../stores/tasks.js';
import { t } from '../../i18n.js';

const ui = useUiStore();
const tasks = useTasksStore();

const title = ref('');
const detail = ref('');
const project = ref('');
const severity = ref('need_human');
const notify = ref(true);
const titleInput = ref(null);

// 每次打开重置表单，并把焦点放到标题输入框
watch(
  () => ui.taskDialogOpen,
  async (open) => {
    if (open) {
      title.value = '';
      detail.value = '';
      project.value = '';
      severity.value = 'need_human';
      notify.value = true;
      await nextTick();
      titleInput.value?.focus();
      document.addEventListener('keydown', onKeydown);
    } else {
      document.removeEventListener('keydown', onKeydown);
    }
  },
);

function onKeydown(e) {
  if (e.key === 'Escape') close();
}

onUnmounted(() => document.removeEventListener('keydown', onKeydown));

function close() {
  ui.closeTaskDialog();
}

async function submit() {
  const t0 = title.value.trim();
  if (!t0) return;
  try {
    // 所有字段读取要落在第一个 await 之前：抽屉一旦关闭，模型就重置了
    const payload = {
      title: t0,
      detail: detail.value.trim() || undefined,
      severity: severity.value,
      project: project.value.trim() || undefined,
      notify: notify.value,
    };
    close();
    await tasks.addTask(payload);
  } catch (err) {
    ui.toast(err.message || String(err), true);
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="ui.taskDialogOpen">
      <div class="drawer-backdrop" @click="close"></div>
      <aside class="drawer drawer-left" :aria-label="t('taskDialog.title')">
        <div class="drawer-head">
          <h2>{{ t('taskDialog.title') }}</h2>
          <button class="icon-btn" type="button" :aria-label="t('drawer.close')" @click="close">✕</button>
        </div>
        <div class="drawer-body">
          <form class="task-drawer-form" @submit.prevent="submit">
            <label class="field">
              <span>{{ t('taskDialog.fieldTitle') }}</span>
              <input ref="titleInput" v-model="title" class="input" required maxlength="200" :placeholder="t('taskDialog.titlePlaceholder')">
            </label>
            <label class="field">
              <span>{{ t('taskDialog.fieldDetail') }}</span>
              <textarea v-model="detail" class="input" rows="5" maxlength="8000" :placeholder="t('taskDialog.detailPlaceholder')"></textarea>
            </label>
            <label class="field">
              <span>{{ t('taskDialog.fieldSeverity') }}</span>
              <select v-model="severity" class="select">
                <option value="need_human">{{ t('severity.need_human') }}</option>
                <option value="blocker">{{ t('severity.blocker') }}</option>
                <option value="info">{{ t('severity.info') }}</option>
              </select>
            </label>
            <label class="field">
              <span>{{ t('taskDialog.fieldProject') }}</span>
              <input v-model="project" class="input" maxlength="120" :placeholder="t('taskDialog.projectPlaceholder')">
            </label>
            <label class="check">
              <input v-model="notify" type="checkbox">
              <span>{{ t('taskDialog.notify') }}</span>
            </label>
            <div class="drawer-actions">
              <button class="btn" type="button" @click="close">{{ t('confirm.cancel') }}</button>
              <button class="btn btn-primary" type="submit">{{ t('taskDialog.submit') }}</button>
            </div>
          </form>
        </div>
      </aside>
    </div>
  </Teleport>
</template>
