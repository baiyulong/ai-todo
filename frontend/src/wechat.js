/* 微信扫码：登录与绑定共用一套「start → 画二维码 → 轮询」流程 */

import { ref } from 'vue';
import { api, translateError } from './api.js';
import { t } from './i18n.js';
import { useUiStore } from './stores/ui.js';
import { useSessionStore } from './stores/session.js';
import { qrSvg } from './qr.js';

/* ---------------- 模块级响应式状态（登录页与设置抽屉共用） ---------------- */

/** 登录页的扫码面板 */
export const loginQr = ref({ panel: false, svg: '', ok: false, tip: '', polling: false });

/** 登录页表单错误信息（空串 = 无错误） */
export const loginError = ref('');

/** 微信绑定弹窗：null = 关闭 */
export const bindDialog = ref(null);

/** 首次微信登录自动签发令牌的展示弹窗：null = 关闭 */
export const tokenDialogToken = ref('');

/**
 * 扫码登录的轮询定时器。
 * 用递归 setTimeout 而不是 setInterval：请求慢的时候不会攒下一堆并发请求。
 */
let wechatTimer = null;

export function stopWechatPoll() {
  if (wechatTimer) {
    clearTimeout(wechatTimer);
    wechatTimer = null;
  }
}

/**
 * 把授权地址渲染成二维码 SVG 字符串。
 * qrSvg 由本地 qr.js 生成，内容完全本地可控。
 * 二维码画不出来时 svg 为空串，组件给「直接打开链接」的兜底。
 */
export function makeQr(text) {
  try {
    const svg = qrSvg(text, { ecc: 'M' });
    return { svg, ok: !!svg };
  } catch {
    return { svg: '', ok: false };
  }
}

/**
 * 轮询扫码结果。
 * 桌面端发起、手机端授权，两台设备之间只能靠服务端中转，所以这里只能轮询。
 *
 * @param {string} state 服务端签发的轮询凭据
 * @param {'login'|'bind'} purpose 登录还是绑定
 * @param {(update:string) => void} onUpdate 状态回调（confirmed 之外的文本/状态）
 */
export async function pollWechatStatus(state, purpose, onUpdate) {
  try {
    const res = await api.get(`/api/v1/auth/wechat/status?state=${encodeURIComponent(state)}`);
    if (res.status === 'confirmed') {
      stopWechatPoll();
      onUpdate('confirmed');
      if (purpose === 'bind') onWechatBound();
      else onWechatSignedIn(res);
      return;
    }
    if (res.status === 'expired' || res.status === 'failed' || res.status === 'unknown') {
      stopWechatPoll();
      let msg = res.status === 'expired' ? t('login.wechatExpired') : t('login.wechatFailed');
      if (res.error_code) msg = translateError({ code: res.error_code });
      onUpdate(msg);
      return;
    }
  } catch {
    /* 网络抖动：下一轮继续轮询，不打断用户 */
  }
  wechatTimer = setTimeout(() => pollWechatStatus(state, purpose, onUpdate), 2000);
}

/**
 * 扫码授权成功：直接进主界面。
 * 首次微信登录会自动签发一枚 MCP 令牌，明文只此一次，
 * 用弹窗把它摊开给用户复制；顺带存进 session.lastToken，
 * 设置页的 MCP 配置块就能直接用上真令牌而不是占位符。
 */
async function onWechatSignedIn(res) {
  const session = useSessionStore();
  if (res.token) {
    session.lastToken = res.token;
    tokenDialogToken.value = res.token;
  }
  await session.bootstrap();
}

/** 绑定微信：把当前微信身份挂到已登录的这个账号上 */
export async function startWechatBind() {
  const ui = useUiStore();
  try {
    const res = await api.post('/api/v1/auth/wechat/bind/start', {});
    const qr = makeQr(res.authorize_url);
    bindDialog.value = { svg: qr.svg, ok: qr.ok, authorizeUrl: res.authorize_url, status: t('wechat.scanTip') };
    pollWechatStatus(res.state, 'bind', (status) => {
      if (status === 'confirmed') return;
      if (bindDialog.value) bindDialog.value.status = status;
    });
  } catch (err) {
    ui.toast(translateError(err), true);
  }
}

export function closeBindDialog() {
  stopWechatPoll();
  bindDialog.value = null;
}

async function onWechatBound() {
  const session = useSessionStore();
  bindDialog.value = null;
  useUiStore().toast(t('wechat.bindDone'));
  await session.loadMe();
}

/** 登录页发起扫码：拿到授权地址后画成二维码，再轮询结果 */
export async function startWechatLogin() {
  loginError.value = '';
  try {
    const res = await api.get('/api/v1/auth/wechat/start');
    const qr = makeQr(res.authorize_url);
    loginQr.value = { panel: true, svg: qr.svg, ok: qr.ok, authorizeUrl: res.authorize_url, tip: t('login.wechatScanTip'), polling: true };
    pollWechatStatus(res.state, 'login', (status) => {
      if (status === 'confirmed') return;
      loginQr.value.tip = status;
      loginQr.value.polling = false;
    });
  } catch (err) {
    loginError.value = translateError(err);
  }
}

export function cancelWechatLogin() {
  stopWechatPoll();
  loginQr.value.panel = false;
}
