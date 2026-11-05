<script setup>
/* 手动新增任务对话框 */

import { ref, watch } from 'vue';
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

// 每次打开重置表单
watch(
  () => ui.taskDialogOpen,
  (open) => {
    if (open) {
      title.value = '';
      detail.value = '';
      project.value = '';
      severity.value = 'need_human';
      notify.value = true;
    }
  },
);

function close() {
  ui.closeTaskDialog();
}

async function submit() {
  const t0 = title.value.trim();
  if (!t0) return;
  try {
    // 所有字段读取要落在第一个 await 之前：对话框一旦关闭，模型就重置了
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
  <dialog :open="ui.taskDialogOpen" class="dialog" @cancel.prevent="close">
    <form class="dialog-inner" @submit.prevent="submit">
      <h2>{{ t('taskDialog.title') }}</h2>
      <label class="field">
        <span>{{ t('taskDialog.fieldTitle') }}</span>
        <input v-model="title" class="input" required maxlength="200" :placeholder="t('taskDialog.titlePlaceholder')">
      </label>
      <label class="field">
        <span>{{ t('taskDialog.fieldDetail') }}</span>
        <textarea v-model="detail" class="input" rows="3" maxlength="8000" :placeholder="t('taskDialog.detailPlaceholder')"></textarea>
      </label>
      <div class="field-row">
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
      </div>
      <label class="check">
        <input v-model="notify" type="checkbox">
        <span>{{ t('taskDialog.notify') }}</span>
      </label>
      <div class="dialog-actions">
        <button class="btn" type="button" @click="close">{{ t('confirm.cancel') }}</button>
        <button class="btn btn-primary" type="submit">{{ t('taskDialog.submit') }}</button>
      </div>
    </form>
  </dialog>
</template>
