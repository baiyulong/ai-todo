/* ============================================================
   AI Todo · 轻量 i18n 引擎（Vue 适配版）
   ------------------------------------------------------------
   逻辑与旧版一致：语言判定 用户显式选择 > 浏览器语言 > 默认中文；
   缺键返回键名本身，漏翻译直接显示在界面上。

   Vue 适配点：t() 内部会读 localeRef.value，
   于是所有调用 t() 的 computed / 模板都自动依赖语言状态，
   切语言即全量重渲染，不再需要 applyI18n / localechange 事件。
   ============================================================ */

import { ref } from 'vue';
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

/** 响应式的当前语言：t() 读它，模板/computed 依赖它 */
export const localeRef = ref(detectLocale());

export function getLocale() {
  return localeRef.value;
}

/**
 * 取译文。缺键时返回键名本身——这样漏翻译会直接显示在界面上，
 * 比静默回退到中文更容易被发现。
 */
export function t(key, params) {
  // 读取响应式语言：语言切换时依赖 t() 的视图自动更新
  localeRef.value;
  let s = DICTS[localeRef.value]?.[key];
  if (typeof s !== 'string') return key;
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, name) =>
      params[name] === undefined || params[name] === null ? m : String(params[name]),
    );
  }
  return s;
}

/** 切换语言并持久化。 */
export function setLocale(locale) {
  if (!DICTS[locale]) return false;
  localeRef.value = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* 忽略：存不下不影响本次会话 */
  }
  document.documentElement.lang = LOCALES[locale].htmlLang;
  return true;
}

/** 应用启动时调用：把检测到的语言正式落到 <html lang>。 */
export function initLocale() {
  document.documentElement.lang = LOCALES[localeRef.value].htmlLang;
  return localeRef.value;
}
