<script setup>
/* 令牌管理：签发 / 删除 MCP 访问令牌，支持随时复制。
 * 令牌必须绑定项目：通过令牌推送的任务都落进令牌的项目。 */

import { ref, onMounted } from 'vue';
import { api, translateError } from '../../api.js';
import { t } from '../../i18n.js';
import { useUiStore } from '../../stores/ui.js';
import { useSessionStore } from '../../stores/session.js';
import { copyText } from '../../composables/clipboard.js';

const ui = useUiStore();
const session = useSessionStore();

const name = ref('');
const projectId = ref('');
const projects = ref([]);
const tokens = ref([]);
const loading = ref(true);

async function loadProjects() {
  try {
    const res = await api.get('/api/v1/projects');
    projects.value = res.projects || [];
    // 默认选中默认项目（后端把 is_default 排最前）
    if (!projectId.value && projects.value.length) {
      projectId.value = projects.value[0].id;
    }
  } catch (err) {
    ui.toast(translateError(err), true);
  }
}

async function loadTokens() {
  loading.value = true;
  try {
    const res = await api.get('/api/v1/tokens');
    tokens.value = res.tokens || [];
  } catch (err) {
    ui.toast(translateError(err), true);
    tokens.value = [];
  } finally {
    loading.value = false;
  }
}

async function issue() {
  try {
    const res = await api.post('/api/v1/tokens', {
      name: name.value.trim() || 'mcp-client',
      project_id: projectId.value || undefined,
    });
    session.lastToken = res.token;
    name.value = '';
    ui.toast(t('token.issuedToast'));
    await loadTokens();
  } catch (err) {
    ui.toast(translateError(err), true);
  }
}

async function removeToken(tk) {
  try {
    await api.del(`/api/v1/tokens/${tk.id}`);
    ui.toast(t('token.deletedToast'));
    await loadTokens();
  } catch (err) {
    ui.toast(translateError(err), true);
  }
}

function formatTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const lastUsed = (tk) =>
  tk.last_used_at ? t('token.lastUsed', { time: formatTime(tk.last_used_at) }) : t('token.neverUsed');

const displayToken = (tk) => tk.token || `${tk.prefix}…`;

async function copySecret(value) {
  const ok = await copyText(value);
  ui.toast(ok ? t('token.copiedToast') : t('token.copyFailedToast'), !ok);
}

onMounted(() => {
  loadTokens();
  loadProjects();
});
</script>

<template>
  <section class="page">
    <div class="page-head">
      <button class="btn btn-sm btn-quiet" type="button" @click="ui.setView('tasks')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
        <span>{{ t('page.back') }}</span>
      </button>
      <h2>{{ t('page.tokensTitle') }}</h2>
    </div>
    <div class="page-body">
      <div class="mgmt-card">
        <p class="hint">{{ t('token.hint') }}</p>

        <div v-if="loading" class="hint">{{ t('rules.loading') }}</div>
        <div v-else-if="tokens.length === 0" class="hint">{{ t('token.empty') }}</div>
        <div v-else>
          <div v-for="tk in tokens" :key="tk.id" class="token-row">
            <div class="token-info">
              <div class="token-name">{{ tk.name }}</div>
              <code class="token-value" :title="tk.token ?? undefined">{{ displayToken(tk) }}</code>
              <div class="token-meta">
                <template v-if="tk.project_name">
                  <span>{{ tk.project_name }}</span>
                  <span> · </span>
                </template>
                {{ tk.revoked_at ? t('token.revoked') : t('token.valid') }} · {{ lastUsed(tk) }}
              </div>
            </div>
            <div class="token-actions">
              <button
                v-if="tk.token"
                class="btn btn-sm btn-quiet"
                type="button"
                @click="copySecret(tk.token)"
              >{{ t('token.copy') }}</button>
              <button
                class="btn btn-sm btn-quiet btn-danger"
                type="button"
                @click="removeToken(tk)"
              >{{ t('token.delete') }}</button>
            </div>
          </div>
        </div>

        <input
          v-model="name"
          class="input"
          type="text"
          maxlength="120"
          style="margin-top: 14px"
          :placeholder="t('token.namePlaceholder')"
        >
        <label class="field" style="margin-top: 10px">
          <span>{{ t('token.fieldProject') }}</span>
          <select v-model="projectId" class="select" required>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
        <button class="btn btn-primary btn-block" type="button" style="margin-top: 10px" @click="issue">
          {{ t('token.issue') }}
        </button>
      </div>
    </div>
  </section>
</template>
