import { BusinessError } from '../../utils/errors';

/** 校验 OIDC 回调基地址，防止把授权码回调到任意外部站点。 */
export function buildTrustedRedirectUri(
  base: string,
  requestOrigin: string,
  configuredOrigins: string[],
): string {
  let candidate: URL;
  try {
    candidate = new URL(base);
  } catch {
    throw new BusinessError('redirectUriBase 格式无效', 400);
  }
  if (candidate.username || candidate.password || !['http:', 'https:'].includes(candidate.protocol)) {
    throw new BusinessError('redirectUriBase 不受信任', 400);
  }

  const trustedOrigins = new Set(
    configuredOrigins.map(value => value.trim().replace(/\/+$/, '')).filter(Boolean),
  );
  trustedOrigins.add(requestOrigin);
  if (!trustedOrigins.has(candidate.origin)) {
    throw new BusinessError('redirectUriBase 不在允许列表中', 400);
  }
  return `${base.replace(/\/+$/, '')}/oidc/callback`;
}
