<script setup>
/* 设置抽屉：状态 / 微信绑定 / 密码 / 邮箱 / 语言 / 主题 / MCP / 快捷键 */

import { ref, computed } from 'vue';
import { useUiStore } from '../../stores/ui.js';
import { useSessionStore } from '../../stores/session.js';
import { api, translateError } from '../../api.js';
import { t, getLocale, setLocale, LOCALES } from '../../i18n.js';
import { startWechatBind } from '../../wechat.js';
import { copyText } from '../../composables/clipboard.js';
import { requestNotifyPermission } from '../../composables/notify.js';
import StatusRow from './StatusRow.vue';
import EmailSection from './EmailSection.vue';
import ThemeSection from './ThemeSection.vue';
import RulesPanel from './RulesPanel.vue';

const ui = useUiStore();
const session = useSessionStore();

const permLabel = computed(() => {
  const map = {
    granted: 'perm.granted',
    denied: 'perm.denied',
    default: 'perm.default',
    unsupported: 'perm.unsupported',
    insecure: 'perm.insecure',
  };
  const p = ui.notifyPerm;
  return map[p] ? t(map[p]) : p;
});
const permClass = computed(() => ({ granted: 'ok', denied: 'bad', default: 'warn', unsupported: 'bad', insecure: 'bad' }[ui.notifyPerm] || ''));

const liveText = computed(() => {
  if (ui.live === 'live') return t('topbar.live');
  if (ui.live === 'down') return t('topbar.offline');
  return t('topbar.connecting');
});

/* ---------------- 修改密码 ---------------- */

const pwOld = ref('');
const pwNew = ref('');
const pwConfirm = ref('');

async function savePassword() {
  if (pwNew.value !== pwConfirm.value) {
    ui.toast(t('password.mismatch'), true);
    return;
  }
  try {
    await api.post('/api/v1/me/password', {
      old_password: session.me?.has_password ? pwOld.value : undefined,
      new_password: pwNew.value,
    });
    pwOld.value = '';
    pwNew.value = '';
    pwConfirm.value = '';
    if (session.me) session.me.has_password = true;
    ui.toast(t('password.changedToast'));
  } catch (err) {
    ui.toast(translateError(err), true);
  }
}

/* ---------------- 语言 ---------------- */

function switchLocale(code) {
  setLocale(code);
}

/* ---------------- MCP 配置块 ---------------- */

const httpUrl = `${location.origin}/mcp`;
const mcpToken = computed(() => session.lastToken || t('mcp.tokenPlaceholder'));
const mcpJson = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        'ai-todo': {
          url: httpUrl,
          headers: { Authorization: `Bearer ${mcpToken.value}` },
        },
      },
    },
    null,
    2,
  ),
);
const copied = ref(false);

async function copyMcp() {
  const ok = await copyText(mcpJson.value);
  if (!ok) {
    ui.toast(t('mcp.copyFailed'), true);
    return;
  }
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 1600);
  // 令牌是占位符时提醒一句：复制出去的配置是跑不起来的
  if (mcpJson.value.includes(t('mcp.tokenPlaceholder'))) {
    ui.toast(t('mcp.copyNeedToken'));
  }
}
</script>

<template>
  <!-- 状态 -->
  <div class="drawer-section">
    <h3>{{ t('section.status') }}</h3>
    <StatusRow :k="t('status.notifyPermission')" :v="permLabel" :cls="permClass" />
    <StatusRow :k="t('status.liveConnection')" :v="liveText" :cls="ui.live === 'live' ? 'ok' : 'bad'" />
    <StatusRow :k="t('status.pendingTasks')" :v="String(session.me?.pending ?? 0)" cls="ok" />
    <button
      v-if="ui.notifyPerm === 'default'"
      class="btn btn-sm btn-primary"
      type="button"
      style="margin-top: 10px"
      @click="requestNotifyPermission()"
    >{{ t('banner.enableBtn') }}</button>
  </div>

  <!-- 通知规则（原独立抽屉并入设置） -->
  <div class="drawer-section">
    <h3>{{ t('section.rules') }}</h3>
    <RulesPanel />
  </div>

  <!-- 微信绑定：已登录的账号可以把自己的微信挂上来，之后就能直接扫码登录 -->
  <div v-if="session.wechat.enabled" class="drawer-section">
    <h3>{{ t('section.wechat') }}</h3>
    <StatusRow
      :k="t('status.wechatBound')"
      :v="session.me?.wechat_bound ? t('status.wechatYes') : t('status.wechatNo')"
      :cls="session.me?.wechat_bound ? 'ok' : ''"
    />
    <button class="btn btn-block" type="button" style="margin-top: 10px" @click="startWechatBind()">
      {{ session.me?.wechat_bound ? t('wechat.rebind') : t('wechat.bind') }}
    </button>
  </div>

  <!-- 账号信息在顶栏头像下拉里，退出也走那里；设置里不再重复 -->

  <!-- 修改密码：微信-only 账号（没设过密码）第一次是「设置密码」，不用填旧密码 -->
  <div v-if="session.me" class="drawer-section">
    <h3>{{ session.me.has_password ? t('password.change') : t('password.set') }}</h3>
    <input v-if="session.me.has_password" v-model="pwOld" class="input" type="password" autocomplete="current-password" :placeholder="t('password.old')" style="margin-bottom: 8px">
    <input v-model="pwNew" class="input" type="password" autocomplete="new-password" :placeholder="`${t('password.new')} · ${t('password.newPlaceholder')}`" style="margin-bottom: 8px">
    <input v-model="pwConfirm" class="input" type="password" autocomplete="new-password" :placeholder="t('password.confirm')" style="margin-bottom: 10px">
    <button class="btn btn-primary btn-block" type="button" @click="savePassword">{{ t('password.save') }}</button>
  </div>

  <!-- 邮箱：任务通知与转交通知都发到这里 -->
  <EmailSection />

  <!-- 语言 -->
  <div class="drawer-section">
    <h3>{{ t('section.language') }}</h3>
    <button
      v-for="(meta, code) in LOCALES"
      :key="code"
      class="btn btn-sm"
      :class="{ 'btn-primary': getLocale() === code }"
      type="button"
      style="margin-right: 8px"
      @click="switchLocale(code)"
    >{{ meta.label }}</button>
  </div>

  <!-- 主题：产品（Apple 风）/ 像素 / 黑客 -->
  <ThemeSection />

  <!-- MCP 接入（令牌在独立的「令牌管理」界面里签发） -->
  <div class="drawer-section">
    <h3>{{ t('section.mcp') }}</h3>
    <p class="hint">{{ t('mcp.hint') }}</p>
    <div class="code-block-wrap">
      <div class="code-block-head">
        <span class="code-block-title">{{ t('mcp.httpTitle') }}</span>
        <button class="btn btn-sm btn-quiet code-copy" type="button" @click="copyMcp">
          {{ copied ? t('mcp.copied') : t('mcp.copy') }}
        </button>
      </div>
      <p class="hint">{{ t('mcp.httpHint') }}</p>
      <pre class="code-block">{{ mcpJson }}</pre>
    </div>
    <p class="hint">{{ t('mcp.isolation') }}</p>
    <p class="hint">{{ t('mcp.sourceHint') }}</p>
  </div>

  <!-- 快捷键 -->
  <div class="drawer-section">
    <h3>{{ t('section.shortcuts') }}</h3>
    <StatusRow k="j / k" :v="t('shortcut.move')" />
    <StatusRow k="a" :v="t('shortcut.ack')" />
    <StatusRow k="d" :v="t('shortcut.done')" />
    <StatusRow k="/" :v="t('shortcut.search')" />
  </div>
</template>
