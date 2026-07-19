import { describe, expect, it } from 'vitest';
import { buildFixedRedirectUri, buildTrustedRedirectUri } from './redirectUri';

describe('buildFixedRedirectUri', () => {
  it('固定使用服务端配置的域名，并从 BASE_PATH 读取部署子路径', () => {
    expect(buildFixedRedirectUri('https://sso.qinyuan.cloud', '/worktime'))
      .toBe('https://sso.qinyuan.cloud/worktime/oidc/callback');
  });

  it('支持根路径部署和显式端口', () => {
    expect(buildFixedRedirectUri('https://sso.qinyuan.cloud:8443', ''))
      .toBe('https://sso.qinyuan.cloud:8443/oidc/callback');
  });

  it.each([
    ['javascript:alert(1)', '危险协议'],
    ['https://user:pass@sso.qinyuan.cloud', '带凭据地址'],
    ['https://sso.qinyuan.cloud/worktime', '包含路径'],
    ['not-a-url', '无效地址'],
  ])('拒绝%s（%s）', (origin) => {
    expect(() => buildFixedRedirectUri(origin, '/worktime')).toThrow();
  });
});

describe('buildTrustedRedirectUri', () => {
  it('允许当前请求同源地址并保留部署子路径', () => {
    expect(buildTrustedRedirectUri(
      'https://work.example.com/worktime/',
      'https://work.example.com',
      [],
    )).toBe('https://work.example.com/worktime/oidc/callback');
  });

  it('允许显式配置的开发前端来源', () => {
    expect(buildTrustedRedirectUri(
      'http://127.0.0.1:5174',
      'http://127.0.0.1:3001',
      ['http://127.0.0.1:5174'],
    )).toBe('http://127.0.0.1:5174/oidc/callback');
  });

  it.each([
    ['https://evil.example.com', '外部来源'],
    ['javascript:alert(1)', '危险协议'],
    ['https://user:pass@work.example.com', '带凭据地址'],
    ['not-a-url', '无效地址'],
  ])('拒绝%s（%s）', (base) => {
    expect(() => buildTrustedRedirectUri(base, 'https://work.example.com', []))
      .toThrow();
  });
});
