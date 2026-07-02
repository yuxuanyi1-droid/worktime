import DOMPurify from 'dompurify';

/**
 * 富文本内容（周报等）的统一净化。
 * 仅允许安全的格式标签，移除所有事件属性（onerror/onload 等）、脚本、iframe。
 * 用于：①渲染服务端返回的 HTML 前净化 ②保存前净化（纵深防御）。
 *
 * 历史上 WeeklyReport 编辑页直接 innerHTML 写入服务端内容，审批页用正则白名单 sanitizeWeeklyHtml，
 * 正则净化易被 Unicode/编码绕过。此处用 DOMPurify（基于浏览器解析 DOM，行业标准）替代。
 */
const ALLOWED_TAGS = ['strong', 'b', 'i', 'em', 'br', 'p', 'ul', 'ol', 'li', 'span', 'div'];

export function sanitizeHtml(html: string | undefined | null): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: [], // 不允许任何属性，杜绝事件属性/style 注入
    ALLOW_DATA_ATTR: false,
  });
}
