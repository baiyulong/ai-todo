/* AI Todo · Vue 前端入口 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { initLocale } from './i18n.js';
import { useUiStore } from './stores/ui.js';

import './styles/base.css';
import './styles/components.css';
import './themes/product.css';
import './themes/pixel.css';
import './themes/hacker.css';

initLocale();

const app = createApp(App);
app.use(createPinia());

// 主题落在 <html data-theme> 上，三套 CSS 变量层按它生效
const ui = useUiStore();
document.documentElement.dataset.theme = ui.theme;

app.mount('#app');
