<script setup>
/* 邮箱区：绑定 / 修改绑定邮箱（同一个验证码两步流程） */

import { ref } from 'vue';
import { api, translateError } from '../../api.js';
import { t } from '../../i18n.js';
import { useUiStore } from '../../stores/ui.js';
import { useSessionStore } from '../../stores/session.js';
import StatusRow from './StatusRow.vue';

const ui = useUiStore();
const session = useSessionStore();

const email = ref('');
const code = ref('');
const showChangeForm = ref(false);
const sending = ref(false);

async function sendCode() {
  if (!email.value.trim()) { ui.toast(t('email.needEmail'), true); return; }
  sending.value = true;
  try {
    await api.post('/api/v1/me/email/start', { email: email.value.trim() });
    ui.toast(t('email.codeSent'));
  } catch (err) {
    ui.toast(translateError(err), true);
  } finally {
    // 3 秒内别连点：给 SMTP 一点喘息
    setTimeout(() => { sending.value = false; }, 3000);
  }
}

async function confirmBind() {
  if (!code.value.trim()) { ui.toast(t('email.needCode'), true); return; }
  try {
    const res = await api.post('/api/v1/me/email/confirm', {
      email: email.value.trim(),
      code: code.value.trim(),
    });
    if (session.me) session.me.email = res.email;
    email.value = '';
    code.value = '';
    showChangeForm.value = false;
    ui.toast(t('email.boundToast'));
  } catch (err) {
    ui.toast(translateError(err), true);
  }
}
</script>

<template>
  <div v-if="session.me" class="drawer-section">
    <h3>{{ t('email.section') }}</h3>

    <template v-if="session.me.email">
      <StatusRow :k="t('email.current')" :v="session.me.email" cls="ok" />
      <p class="hint">{{ t('email.boundHint') }}</p>

      <!-- 修改绑定邮箱：点按钮展开换绑表单，仍是「新邮箱 + 验证码」两步 -->
      <button class="btn btn-quiet" type="button" @click="showChangeForm = !showChangeForm">
        {{ t('email.change') }}
      </button>
      <div v-if="showChangeForm" style="margin-top: 8px">
        <input v-model="email" class="input" type="email" autocomplete="email" :placeholder="t('email.placeholder')" style="margin-bottom: 8px">
        <div class="email-code-row" style="margin-bottom: 8px">
          <input v-model="code" class="input" inputmode="numeric" maxlength="6" :placeholder="t('email.codePlaceholder')">
          <button class="btn btn-quiet" type="button" :disabled="sending" @click="sendCode">{{ t('email.sendCode') }}</button>
        </div>
        <button class="btn btn-primary btn-block" type="button" @click="confirmBind">{{ t('email.bind') }}</button>
      </div>
    </template>

    <template v-else>
      <p class="hint">{{ t('email.needBind') }}</p>
      <input v-model="email" class="input" type="email" autocomplete="email" :placeholder="t('email.placeholder')" style="margin-bottom: 8px">
      <div class="email-code-row" style="margin-bottom: 8px">
        <input v-model="code" class="input" inputmode="numeric" maxlength="6" :placeholder="t('email.codePlaceholder')">
        <button class="btn btn-quiet" type="button" :disabled="sending" @click="sendCode">{{ t('email.sendCode') }}</button>
      </div>
      <button class="btn btn-primary btn-block" type="button" @click="confirmBind">{{ t('email.bind') }}</button>
    </template>
  </div>
</template>
