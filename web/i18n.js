/* ============================================================
   AI Todo · 轻量 i18n 引擎（零第三方依赖）
   ------------------------------------------------------------
   用法：
     import { t, initLocale, setLocale, getLocale, applyI18n } from './i18n.js';

   静态文案在 HTML 上用 data-i18n 系列属性标记，引擎负责套用；
   动态文案直接调 t('key', { 占位符 })。

   语言包用静态 import 而不是动态 import：首屏不闪一下英文再跳中文。
   ============================================================ */

import { dict as zhCN } from './locales/zh-CN.js';
import { dict as enUS } from './locales/en-US.js';

const STORAGE_KEY = 'ai_todo_locale';
const DEFAULT_LOCALE = 'zh-CN';

const DICTS = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

/** 可选语言。label 是语言自己的名字（不翻译）。 */
export const LOCALES = {
  'zh-CN': { label: '中文', htmlLang: 'zh-CN' },
  'en-US': { label: 'English', htmlLang: 'en' },
};

let current = DEFAULT_LOCALE;
let dict = DICTS[DEFAULT_LOCALE];

/**
 * 语言判定优先级：用户显式选择 > 浏览器语言 > 默认中文。
 * 只认精确匹配，zh-* 归到中文，其余一律英文。
 */
function detectLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && DICTS[saved]) return saved;
  } catch {
    /* 隐私模式下 localStorage 可能抛错，忽略即可 */
  }
  const nav = navigator.language || DEFAULT_LOCALE;
  if (DICTS[nav]) return nav;
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function getLocale() {
  return current;
}

/**
 * 取译文。缺键时返回键名本身——这样漏翻译会直接显示在界面上，
 * 比静默回退到中文更容易被发现。
 */
export function t(key, params) {
  let s = dict[key];
  if (typeof s !== 'string') return key;
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, name) =>
      params[name] === undefined || params[name] === null ? m : String(params[name]),
    );
  }
  return s;
}

/**
 * 把 HTML 上标记好的静态文案套用当前语言。
 * 只碰 textContent / 属性，绝不碰 innerHTML。
 * 带子节点的元素别用 data-i18n（会被整体替换掉），拆成多个叶子节点。
 */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'));
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  }
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  }
}

/**
 * 切换语言。套用静态文案后广播一个事件，
 * 由应用层决定哪些动态内容需要重绘（列表、抽屉等）。
 */
export function setLocale(locale) {
  if (!DICTS[locale] || locale === current) return false;
  current = locale;
  dict = DICTS[locale];
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* 忽略：存不下不影响本次会话 */
  }
  document.documentElement.lang = LOCALES[locale].htmlLang;
  applyI18n(document);
  window.dispatchEvent(new CustomEvent('ai-todo:localechange', { detail: { locale } }));
  return true;
}

/** 首屏初始化：尽早定语言并套用静态文案。 */
export function initLocale() {
  const locale = detectLocale();
  current = locale;
  dict = DICTS[locale];
  document.documentElement.lang = LOCALES[locale].htmlLang;
  applyI18n(document);
  return locale;
}
