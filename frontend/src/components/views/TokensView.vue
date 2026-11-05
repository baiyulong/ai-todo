<script setup>
/* 令牌管理：签发 / 吊销 MCP 访问令牌 */

import { ref, onMounted } from 'vue';
import { api, translateError } from '../../api.js';
import { t } from '../../i18n.js';
import { useUiStore } from '../../stores/ui.js';
import { useSessionStore } from '../../stores/session.js';
import { copyText } from '../../composables/clipboard.js';

const ui = useUiStore();
const session = useSessionStore();

const name = ref('');
const tokens = ref([]);
const loading = ref(true);

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
    const res = await api.post('/api/v1/tokens', { name: name.value.trim() || 'mcp-client' });
    session.lastToken = res.token;
    name.value = '';
    ui.toast(t('token.issuedToast'));
    await loadTokens();
  } catch (err) {
    ui.toast(translateError(err), true);
  }
}

async function revoke(tk) {
  try {
    await api.del(`/api/v1/tokens/${tk.id}`);
    ui.toast(t('token.revokedToast'));
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

async function copySecret(value) {
  const ok = await copyText(value);
  ui.toast(ok ? t('token.copiedToast') : t('token.copyFailedToast'), !ok);
}

onMounted(loadTokens);
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
              <div class="token-meta">{{ tk.revoked_at ? t('token.revoked') : t('token.valid') }} · {{ lastUsed(tk) }}</div>
            </div>
            <button
              v-if="!tk.revoked_at"
              class="btn btn-sm btn-quiet btn-danger"
              type="button"
              @click="revoke(tk)"
            >{{ t('token.revoke') }}</button>
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
        <button class="btn btn-primary btn-block" type="button" style="margin-top: 10px" @click="issue">
          {{ t('token.issue') }}
        </button>
      </div>

      <!-- 刚签发的令牌（只显示这一次） -->
      <div v-if="session.lastToken" class="mgmt-card token-secret">
        <div class="token-secret-label">{{ t('token.freshLabel') }}</div>
        <div class="qr-token-row">
          <code>{{ session.lastToken }}</code>
          <button class="btn btn-sm" type="button" @click="copySecret(session.lastToken)">{{ t('token.copy') }}</button>
        </div>
      </div>
    </div>
  </section>
</template>
