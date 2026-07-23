import { BusinessError } from '../../utils/errors';

function validateRedirectUriBase(base: string): void {
  let candidate: URL;
  try {
    candidate = new URL(base);
  } catch {
    throw new BusinessError('redirectUriBase 格式无效', 400);
  }
  if (candidate.username || candidate.password || !['http:', 'https:'].includes(candidate.protocol)) {
    throw new BusinessError('redirectUriBase 不受信任', 400);
  }
  if (candidate.search || candidate.hash) {
    throw new BusinessError('redirectUriBase 不能包含 query 或 hash', 400);
  }
}

function configuredOrigin(value: string): string {
  let candidate: URL;
  try {
    candidate = new URL(value.trim());
  } catch {
    throw new BusinessError('OIDC_REDIRECT_ORIGINS 配置格式无效', 500);
  }
  if (
    candidate.username ||
    candidate.password ||
    !['http:', 'https:'].includes(candidate.protocol) ||
    candidate.pathname !== '/' ||
    candidate.search ||
    candidate.hash
  ) {
    throw new BusinessError('OIDC_REDIRECT_ORIGINS 只能配置协议、域名和端口', 500);
  }
  return candidate.origin;
}

/** 使用服务端固定 origin + BASE_PATH 构造回调地址。 */
export function buildFixedRedirectUri(origin: string, basePath: string): string {
  validateRedirectUriBase(origin);
  const candidate = new URL(origin);
  if (candidate.pathname !== '/' || candidate.search || candidate.hash) {
    throw new BusinessError('OIDC_REDIRECT_ORIGIN 只能填写协议、域名和端口', 400);
  }
  const normalizedBasePath = basePath.trim().replace(/\/+$/, '');
  if (normalizedBasePath && !normalizedBasePath.startsWith('/')) {
    throw new BusinessError('BASE_PATH 必须为空或以 / 开头', 500);
  }
  return `${candidate.origin}${normalizedBasePath}/oidc/callback`;
}

/** 校验 OIDC 回调基地址，防止把授权码回调到任意外部站点。 */
export function buildTrustedRedirectUri(
  base: string,
  requestOrigin: string,
  configuredOrigins: string[],
  trustRequestOrigin = true,
): string {
  validateRedirectUriBase(base);
  const candidate = new URL(base);

  const trustedOrigins = new Set(
    configuredOrigins.map(value => value.trim()).filter(Boolean).map(configuredOrigin),
  );
  if (trustRequestOrigin && requestOrigin) trustedOrigins.add(configuredOrigin(requestOrigin));
  if (!trustedOrigins.has(candidate.origin)) {
    throw new BusinessError('redirectUriBase 不在允许列表中', 400);
  }
  const basePath = candidate.pathname === '/' ? '' : candidate.pathname.replace(/\/+$/, '');
  return `${candidate.origin}${basePath}/oidc/callback`;
}

/** 服务端对登录完成跳转目标做同样的站内路径约束，避免只依赖浏览器端校验。 */
export function safeInternalRedirect(value?: string | null, fallback = '/'): string {
  if (!value || !value.startsWith('/') || /[\u0000-\u001f\u007f]/.test(value)) return fallback;
  let decoded = value;
  try {
    for (let i = 0; i < 2; i += 1) decoded = decodeURIComponent(decoded);
  } catch {
    return fallback;
  }
  if (decoded.startsWith('//') || decoded.includes('\\')) return fallback;
  return value;
}
