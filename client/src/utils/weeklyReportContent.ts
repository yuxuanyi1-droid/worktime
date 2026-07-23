const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/i;

function decodeCodePoint(raw: string, radix: number, fallback: string) {
  const value = Number.parseInt(raw, radix);
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return fallback;
  return String.fromCodePoint(value);
}

/**
 * 旧版本周报曾保存 contentEditable 产生的 HTML。新版本统一使用纯文本；
 * 这里只做兼容性降级，不把历史内容重新注入 DOM，避免存储型 XSS。
 */
export function weeklyReportContentToText(value?: string): string {
  if (!value || !HTML_TAG_PATTERN.test(value)) return value || '';

  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|h[1-6])>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (match, code) => decodeCodePoint(code, 10, match))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => decodeCodePoint(code, 16, match))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
