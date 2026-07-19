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
): string {
  validateRedirectUriBase(base);
  const candidate = new URL(base);

  const trustedOrigins = new Set(
    configuredOrigins.map(value => value.trim().replace(/\/+$/, '')).filter(Boolean),
  );
  trustedOrigins.add(requestOrigin);
  if (!trustedOrigins.has(candidate.origin)) {
    throw new BusinessError('redirectUriBase 不在允许列表中', 400);
  }
  return `${base.replace(/\/+$/, '')}/oidc/callback`;
}
