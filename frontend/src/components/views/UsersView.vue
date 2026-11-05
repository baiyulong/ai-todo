<script setup>
/* 用户管理（管理员）：新建账号 + 账号列表（重置密码 / 删除） */

import { ref, onMounted } from 'vue';
import { api, translateError } from '../../api.js';
import { t } from '../../i18n.js';
import { useUiStore } from '../../stores/ui.js';
import { useSessionStore } from '../../stores/session.js';
import { copyText } from '../../composables/clipboard.js';
import CredentialsCard from '../tasks/CredentialsCard.vue';

const ui = useUiStore();
const session = useSessionStore();

const newUsername = ref('');
const newEmail = ref('');
const users = ref([]);
const loading = ref(true);

async function loadUsers() {
  loading.value = true;
  try {
    const res = await api.get('/api/v1/admin/users');
    users.value = res.users || [];
  } catch (err) {
    ui.toast(translateError(err), true);
    users.value = [];
  } finally {
    loading.value = false;
  }
}

async function create() {
  const username = newUsername.value.trim().toLowerCase();
  const email = newEmail.value.trim().toLowerCase();
  if (!username) { ui.toast(t('user.needUsername'), true); return; }
  if (!email) { ui.toast(t('user.needEmail'), true); return; }
  try {
    const res = await api.post('/api/v1/admin/users', { username, email });
    newUsername.value = '';
    newEmail.value = '';
    // 初始密码与令牌只显示一次：摊开在页面里，复制按钮伺候
    session.freshUserCredentials = { kind: 'created', username: res.user.username, password: res.password, token: res.token };
    if (res.token) session.lastToken = res.token;
    ui.toast(t('user.createdToast', { username: res.user.username }));
  } catch (err) {
    ui.toast(translateError(err), true);
  }
}

/** 重置密码：服务端随机生成新密码，邮件发给用户本人 */
async function resetPassword(u) {
  const name = u.username || t('user.noUsername');
  const ok = await ui.confirmAction({
    title: t('user.reset'),
    text: t('user.resetConfirm', { username: name }),
    okLabel: t('user.reset'),
  });
  if (!ok) return;
  try {
    const res = await api.post(`/api/v1/admin/users/${u.id}/reset-password`);
    if (res.email_sent) {
      ui.toast(t('user.resetSentToast', { email: res.email }));
    } else {
      // 邮件通道不可用：密码只在这里显示一次，管理员线下转达
      session.freshUserCredentials = { kind: 'reset', username: u.username, password: res.password, token: null };
      ui.toast(t('user.resetFallbackToast'), true);
    }
  } catch (err) {
    ui.toast(translateError(err), true);
  }
}

/** 删除账号：永久清除其所有任务/通知/令牌/会话记录，不可恢复。 */
async function removeUser(u) {
  const name = u.username || t('user.noUsername');
  const ok = await ui.confirmAction({
    title: t('user.delete'),
    text: t('user.deleteConfirm', { username: name }),
    okLabel: t('user.delete'),
  });
  if (!ok) return;
  try {
    await api.del(`/api/v1/admin/users/${u.id}`);
    ui.toast(t('user.deletedToast', { username: name }));
    await loadUsers();
  } catch (err) {
    ui.toast(translateError(err), true);
  }
}

async function copySecret(value) {
  const ok = await copyText(value);
  ui.toast(ok ? t('token.copiedToast') : t('token.copyFailedToast'), !ok);
}

function dismissCredentials() {
  session.freshUserCredentials = null;
}

onMounted(loadUsers);
</script>

<template>
  <section class="page">
    <div class="page-head">
      <button class="btn btn-sm btn-quiet" type="button" @click="ui.setView('tasks')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
        <span>{{ t('page.back') }}</span>
      </button>
      <h2>{{ t('page.usersTitle') }}</h2>
    </div>
    <div class="page-body">
      <!-- 新建账号 -->
      <div class="mgmt-card">
        <h3 class="mgmt-card-title">{{ t('user.newTitle') }}</h3>
        <p class="hint">{{ t('user.hint') }}</p>
        <div class="mgmt-create-row">
          <input
            v-model="newUsername"
            class="input"
            type="text"
            maxlength="32"
            autocapitalize="off"
            spellcheck="false"
            :placeholder="t('user.newUsernamePlaceholder')"
          >
          <input
            v-model="newEmail"
            class="input"
            type="email"
            autocomplete="off"
            :placeholder="t('user.newEmailPlaceholder')"
          >
          <button class="btn btn-primary" type="button" @click="create">{{ t('user.create') }}</button>
        </div>
      </div>

      <!-- 刚创建/重置的账号凭据（只显示这一次） -->
      <CredentialsCard
        v-if="session.freshUserCredentials"
        :creds="session.freshUserCredentials"
        @copy="copySecret"
        @dismiss="dismissCredentials"
      />

      <!-- 账号列表 -->
      <div class="mgmt-card">
        <h3 class="mgmt-card-title">{{ t('user.listTitle') }}</h3>

        <div class="mgmt-row mgmt-row-head">
          <div>{{ t('user.colUsername') }}</div>
          <div>{{ t('user.colRole') }}</div>
          <div>{{ t('user.colStatus') }}</div>
          <div>{{ t('user.colActions') }}</div>
        </div>

        <div v-if="loading" class="hint">{{ t('rules.loading') }}</div>
        <div v-else-if="users.length === 0" class="hint">{{ t('user.empty') }}</div>

        <div v-for="u in users" :key="u.id" class="mgmt-row">
          <div>
            <span class="mgmt-name">{{ u.username || t('user.noUsername') }}</span>
            <span v-if="u.email" class="mgmt-sub">{{ u.email }}</span>
            <span v-else class="mgmt-sub badge-warn">{{ t('user.noEmail') }}</span>
            <span v-if="session.me && u.id === session.me.id" class="mgmt-sub">{{ t('user.self') }}</span>
          </div>
          <div :class="{ 'mgmt-role-admin': u.is_admin }">
            {{ u.is_admin ? t('status.roleAdmin') : t('status.roleUser') }}
          </div>
          <div>
            <span class="tag st-acked">{{ t('user.flagNormal') }}</span>
            <span v-if="u.wechat_openid" class="mgmt-sub">{{ t('user.flagWechat') }}</span>
          </div>
          <div class="mgmt-actions">
            <button
              class="btn btn-sm btn-quiet"
              type="button"
              :title="u.email ? t('user.resetTitle', { email: u.email }) : t('user.resetNoEmailHint')"
              @click="resetPassword(u)"
            >{{ t('user.reset') }}</button>
            <!-- 删除：自己的行不显示——后端也拦，但界面上就不该出现这个按钮 -->
            <button
              v-if="!session.me || u.id !== session.me.id"
              class="btn btn-sm btn-quiet btn-danger"
              type="button"
              :title="t('user.deleteTitle')"
              @click="removeUser(u)"
            >{{ t('user.delete') }}</button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
