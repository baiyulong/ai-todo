/* 极简 Markdown 解析器：只为帮助文档服务。
   支持的语法刻意保持最小：标题（##/###）、无序/有序列表、围栏代码块、
   行内代码、加粗、普通段落。
   输出是结构化的块数组（不是 HTML 字符串），由 MarkdownView 组件渲染成
   Vue VNode——文本节点由 Vue 自动转义，天然没有注入面，也不需要 v-html。 */

/** 行内文本 → 片段数组：{ s: 文本, code?: true, b?: true } */
function parseInline(text) {
  const segs = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ s: text.slice(last, m.index) });
    if (m[1] !== undefined) segs.push({ s: m[1], code: true });
    else segs.push({ s: m[2], b: true });
    last = re.lastIndex;
  }
  if (last < text.length) segs.push({ s: text.slice(last) });
  return segs.length ? segs : [{ s: '' }];
}

/**
 * 解析 Markdown → 块数组：
 *   { t: 'h', level: 3|4, segs }   ## → h3，### → h4（文档大标题占 h2）
 *   { t: 'p', segs }
 *   { t: 'ul' | 'ol', items: [segs, ...] }
 *   { t: 'pre', code }
 */
export function parseMarkdown(src) {
  const lines = String(src).split(/\r?\n/);
  const blocks = [];
  let para = [];
  let list = null; // 'ul' | 'ol' | null
  let inCode = false;
  let codeBuf = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ t: 'p', segs: parseInline(para.join('\n')) });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ t: list, items: listItems });
      listItems = [];
      list = null;
    }
  };
  let listItems = [];

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (inCode) {
      if (/^```/.test(line.trim())) {
        blocks.push({ t: 'pre', code: codeBuf.join('\n') });
        codeBuf = [];
        inCode = false;
      } else {
        codeBuf.push(raw);
      }
      continue;
    }

    if (/^\s*```/.test(line)) {
      flushPara();
      flushList();
      inCode = true;
      continue;
    }

    const h = line.match(/^(#{2,4})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ t: 'h', level: h[1].length + 1, segs: parseInline(h[2]) });
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (list !== 'ul') {
        flushList();
        list = 'ul';
      }
      listItems.push(parseInline(ul[1]));
      continue;
    }

    const ol = line.match(/^\s*\d+[.、)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (list !== 'ol') {
        flushList();
        list = 'ol';
      }
      listItems.push(parseInline(ol[1]));
      continue;
    }

    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }

    para.push(line);
  }

  if (inCode && codeBuf.length) {
    blocks.push({ t: 'pre', code: codeBuf.join('\n') });
  }
  flushPara();
  flushList();
  return blocks;
}
