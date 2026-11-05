/* AI Todo · 前端 API 封装
 *
 * 与旧版行为一致：
 * - 统一带 cookie（same-origin 会话）
 * - 非 2xx 抛 Error，error.code / error.details 带服务端错误码，
 *   界面按 code 翻译，不依赖服务端文案
 * - 401 统一触发 showLogin（由 session store 处理）
 */

import { t } from './i18n.js';

/** 401 时的回调，由 session store 注册（避免循环依赖） */
let onUnauthorized = () => {};

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null; // 非 JSON 的错误页，按状态码兜底
    }
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    // 把服务端的错误码带出来：界面按 code 翻译，不依赖服务端文案。
    // 401 也要带 code——登录接口的错误密码正是 401。
    err.code = data?.error?.code || '';
    err.details = data?.error?.details || null;
    if (res.status === 401) {
      err.code = err.code || 'unauthorized';
      onUnauthorized();
    }
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => call('GET', p),
  post: (p, b) => call('POST', p, b),
  patch: (p, b) => call('PATCH', p, b),
  put: (p, b) => call('PUT', p, b),
  del: (p) => call('DELETE', p),
};

/**
 * 把服务端错误翻成当前语言的文案。
 * 查不到 code 对应的译文时退回服务端 message。
 */
export function translateError(err) {
  if (!err) return '';
  const code = err.code;
  if (code) {
    if (code === 'invalid_argument' && err.details?.kind === 'enum') {
      return t('error.invalid_argument.enum', err.details);
    }
    if (code === 'invalid_argument' && err.details?.kind === 'uuid') {
      return t('error.invalid_argument.uuid', err.details);
    }
    const key = `error.${code}`;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return err.message || '';
}
