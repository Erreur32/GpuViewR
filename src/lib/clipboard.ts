// Robust clipboard copy. The modern navigator.clipboard.writeText API
// only works in a "secure context" — that means HTTPS, or HTTP against
// localhost/127.0.0.1. As soon as the user opens GpuViewR via a LAN
// IP (`http://192.168.1.42:5181/`), the modern API throws and the
// Copy buttons silently fail.
//
// Fallback: create a hidden <textarea>, select its content, and call
// document.execCommand('copy'). It's deprecated but supported across
// every browser we care about, and works in insecure contexts.

export async function copyText(text: string): Promise<boolean> {
  // 1. Modern path — secure context.
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through
    }
  }
  // 2. Legacy fallback — works in HTTP / LAN IP / insecure contexts.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // Position off-screen so the focus switch is invisible.
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
