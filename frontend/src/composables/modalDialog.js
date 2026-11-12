/* <dialog> 模态化组合式函数 */

import { ref, watch } from 'vue';

/**
 * 把 <dialog :open="..."> 升级为真正的模态对话框。
 *
 * 为什么不能只用 :open 绑定：Vue 绑定 open 属性只是「非模态展示」——
 * 对话框不进浏览器顶层（top layer）、不自动居中、::backdrop 遮罩不生效，
 * 整个对话框按普通块级元素排在文档流里，页面一长就掉到末尾，
 * 不滚动根本看不见（项目管理页的删除确认框就是这么「消失」的）。
 *
 * 用法：
 *   const dlg = useModalDialog(() => !!state);
 *   <dialog ref="dlg" class="dialog" @cancel.prevent="close">…
 *
 * showModal() 带来的附带收益：原生 ESC 触发 @cancel、半透明遮罩、
 * 对话框天然在所有内容之上（无需管理 z-index）。
 */
export function useModalDialog(open) {
  const el = ref(null);
  watch(
    open,
    (value) => {
      const dlg = el.value;
      if (!dlg) return;
      if (value && !dlg.open) dlg.showModal();
      else if (!value && dlg.open) dlg.close();
    },
    { flush: 'post' }, // 状态变化先落 DOM，再操作原生元素
  );
  return el;
}
