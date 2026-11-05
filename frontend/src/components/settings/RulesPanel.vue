<script setup>
/* 规则抽屉：提醒规则（最低严重度 / 冷却 / 分组 / 免打扰 / 摘要时刻） */

import { reactive, computed, watch } from 'vue';
import { api, translateError } from '../../api.js';
import { t } from '../../i18n.js';
import { useUiStore } from '../../stores/ui.js';
import { useSessionStore } from '../../stores/session.js';

const ui = useUiStore();
const session = useSessionStore();

const form = reactive({
  min_severity: 'need_human',
  cooldown_sec: 300,
  group_by: 'source_session',
  quiet_hours: '',
  digest_hour: '',
});

// 每次打开抽屉（或 rules 更新）时同步表单
const rules = computed(() => session.rules || session.me?.rules);
watch(
  rules,
  (r) => {
    if (!r) return;
    form.min_severity = r.min_severity;
    form.cooldown_sec = r.cooldown_sec ?? 300;
    form.group_by = r.group_by;
    form.quiet_hours = r.quiet_hours ? `${r.quiet_hours.start} - ${r.quiet_hours.end}` : '';
    form.digest_hour = r.digest_hour === null || r.digest_hour === undefined ? '' : String(r.digest_hour);
  },
  { immediate: true },
);

async function save() {
  let quiet = null;
  const qhText = form.quiet_hours.trim();
  if (qhText) {
    const m = /^(\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})$/.exec(qhText);
    if (!m) { ui.toast(t('rules.quietHoursFormat'), true); return; }
    quiet = { start: m[1], end: m[2] };
  }
  try {
    const res = await api.put('/api/v1/rules', {
      min_severity: form.min_severity,
      cooldown_sec: Number(form.cooldown_sec) || 0,
      group_by: form.group_by,
      quiet_hours: quiet,
      digest_hour: form.digest_hour === '' ? null : Number(form.digest_hour),
    });
    session.rules = res.rules;
    ui.toast(t('rules.savedToast'));
  } catch (err) {
    ui.toast(translateError(err), true);
  }
}
</script>

<template>
  <div v-if="!rules" class="hint">{{ t('rules.loading') }}</div>

  <template v-else>
    <label class="field" :data-help="t('rules.minSeverityHint')">
      <span>{{ t('rules.minSeverity') }}</span>
      <select v-model="form.min_severity" class="select">
        <option value="info">{{ t('rules.minSeverityInfo') }}</option>
        <option value="need_human">{{ t('rules.minSeverityNeedHuman') }}</option>
        <option value="blocker">{{ t('rules.minSeverityBlocker') }}</option>
      </select>
    </label>

    <label class="field" :data-help="t('rules.cooldownHint')">
      <span>{{ t('rules.cooldown') }}</span>
      <input v-model="form.cooldown_sec" class="input" type="number" min="0" max="86400">
    </label>

    <label class="field" :data-help="t('rules.groupByHint')">
      <span>{{ t('rules.groupBy') }}</span>
      <select v-model="form.group_by" class="select">
        <option value="source_session">{{ t('rules.groupBySession') }}</option>
        <option value="project">{{ t('rules.groupByProject') }}</option>
        <option value="none">{{ t('rules.groupByNone') }}</option>
      </select>
    </label>

    <label class="field" :data-help="t('rules.quietHoursHint')">
      <span>{{ t('rules.quietHours') }}</span>
      <input v-model="form.quiet_hours" class="input" placeholder="23:00 - 08:00">
    </label>

    <label class="field" :data-help="t('rules.digestHourHint')">
      <span>{{ t('rules.digestHour') }}</span>
      <input v-model="form.digest_hour" class="input" type="number" min="0" max="23">
    </label>

    <button class="btn btn-primary btn-block" type="button" @click="save">{{ t('rules.save') }}</button>
  </template>
</template>
