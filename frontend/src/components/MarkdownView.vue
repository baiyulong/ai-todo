<script>
/* Markdown 渲染组件：把 md.js 解析出的块数组渲染成 VNode 树。
   不用 v-html / innerHTML——文本节点由 Vue 自动转义，零注入面。 */
import { h } from 'vue';
import { parseMarkdown } from '../composables/md.js';

function renderSegs(segs) {
  return segs.map((s) => (s.code ? h('code', s.s) : s.b ? h('strong', s.s) : s.s));
}

export default {
  name: 'MarkdownView',
  props: { src: { type: String, default: '' } },
  render() {
    const blocks = parseMarkdown(this.src);
    return h(
      'div',
      { class: 'md-body' },
      blocks.map((b) => {
        if (b.t === 'h') return h(`h${b.level}`, renderSegs(b.segs));
        if (b.t === 'p') return h('p', renderSegs(b.segs));
        if (b.t === 'ul' || b.t === 'ol') {
          return h(b.t, b.items.map((segs) => h('li', renderSegs(segs))));
        }
        if (b.t === 'pre') return h('pre', h('code', b.code));
        return null;
      }),
    );
  },
};
</script>
