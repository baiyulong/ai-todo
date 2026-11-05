/**
 * 复制文本到剪贴板。
 *
 * navigator.clipboard 只在「安全上下文」里可用——HTTPS 或 localhost。
 * 通过局域网 IP 用 http:// 访问时它压根不存在，
 * 所以必须留 execCommand 这条老路兜底，否则复制按钮在真实部署里直接失效。
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
