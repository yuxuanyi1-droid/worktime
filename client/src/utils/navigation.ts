/** 只允许当前站点内的绝对路径，防止登录回跳参数被用于外部跳转。 */
export function safeInternalRedirect(value?: string | null, fallback = '/'): string {
  if (!value || !value.startsWith('/') || /[\u0000-\u001f\u007f]/.test(value)) {
    return fallback;
  }
  let decoded = value;
  try {
    // 检查两层编码，拒绝 /%252f%252fevil 这类经路由/代理重复解码后变成 //evil 的值。
    for (let i = 0; i < 2; i += 1) decoded = decodeURIComponent(decoded);
  } catch {
    return fallback;
  }
  if (decoded.startsWith('//') || decoded.includes('\\')) return fallback;
  return value;
}
