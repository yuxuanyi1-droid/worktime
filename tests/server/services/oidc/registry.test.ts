import { afterEach, describe, expect, it, vi } from 'vitest';
import { oidcConfig } from '@server/config/auth';
import {
  assertProviderVisible,
  getProvider,
  getProviderLabel,
  listVisibleProviders,
  signState,
  verifyState,
} from '@server/services/oidc/registry';
import { OidcAdapter } from '@server/services/oidc/oidcAdapter';
import { DingTalkAdapter } from '@server/services/oidc/dingtalkAdapter';
import { SiamAdapter } from '@server/services/oidc/siamAdapter';

describe('OIDC state 签名与结构校验', () => {
  afterEach(() => vi.restoreAllMocks());
  it('合法 state 可往返解析，篡改载荷或签名会被拒绝', () => {
    const state = signState({ mode: 'login', provider: 'authentik', redirect: '/timesheet', nonce: 'nonce' });
    expect(verifyState(state)).toMatchObject({
      mode: 'login', provider: 'authentik', redirect: '/timesheet', nonce: 'nonce',
    });

    const [body, signature] = state.split('.');
    const tamperedBody = `${body[0] === 'A' ? 'B' : 'A'}${body.slice(1)}`;
    const tamperedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    expect(() => verifyState(`${tamperedBody}.${signature}`)).toThrow('签名校验失败');
    expect(() => verifyState(`${body}.${tamperedSignature}`)).toThrow('签名校验失败');
  });

  it('拒绝过期 state 和缺少用户标识的绑定 state', () => {
    const originalTtl = oidcConfig.stateTtlMs;
    try {
      (oidcConfig as any).stateTtlMs = -1;
      expect(() => verifyState(signState({ mode: 'login', provider: 'authentik' })))
        .toThrow('已过期');
    } finally {
      (oidcConfig as any).stateTtlMs = originalTtl;
    }

    const invalidBind = signState({ mode: 'bind', provider: 'authentik' } as any);
    expect(() => verifyState(invalidBind)).toThrow('缺少有效用户标识');
  });

  it('到达过期时间边界时立即失效', () => {
    const start = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(start);
    const state = signState({ mode: 'login', provider: 'corp' });
    vi.mocked(Date.now).mockReturnValue(start + oidcConfig.stateTtlMs);
    expect(() => verifyState(state)).toThrow('已过期');
  });

  it('拒绝超长或危险 provider、nonce 和错误类型 redirect', () => {
    expect(() => verifyState(signState({ mode: 'login', provider: '../corp' }))).toThrow('内容无效');
    expect(() => verifyState(signState({ mode: 'login', provider: 'corp', nonce: 'x'.repeat(501) })))
      .toThrow('nonce 无效');
    expect(() => verifyState(signState({ mode: 'login', provider: 'corp', redirect: 123 as any })))
      .toThrow('redirect 无效');
  });

  it('只公开已启用身份源且不泄露 secret，并保留 JIT 展示属性', () => {
    const enabledName = 'test-visible-provider';
    const disabledName = 'test-hidden-provider';
    oidcConfig.providers[enabledName] = {
      enabled: true,
      label: '企业登录',
      type: 'siam',
      jit: true,
      clientSecret: 'must-not-leak',
    } as any;
    oidcConfig.providers[disabledName] = {
      enabled: false,
      label: '停用登录',
      type: 'oidc',
      jit: false,
      clientSecret: 'hidden-secret',
    } as any;
    try {
      const visible = listVisibleProviders();
      expect(visible).toContainEqual({
        name: enabledName,
        label: '企业登录',
        type: 'siam',
        jit: true,
      });
      expect(visible.find((provider) => provider.name === disabledName)).toBeUndefined();
      expect(JSON.stringify(visible)).not.toContain('must-not-leak');
      expect(getProviderLabel(enabledName)).toBe('企业登录');
      expect(getProviderLabel('missing-provider')).toBe('missing-provider');
    } finally {
      delete oidcConfig.providers[enabledName];
      delete oidcConfig.providers[disabledName];
    }
  });

  it('按 provider 类型创建并缓存适配器，停用或未知入口始终拒绝', () => {
    const providers = {
      'test-registry-oidc': { enabled: true, label: 'OIDC', type: 'oidc' },
      'test-registry-dingtalk': { enabled: true, label: '钉钉', type: 'dingtalk' },
      'test-registry-siam': { enabled: true, label: 'SIAM', type: 'siam' },
      'test-registry-disabled': { enabled: false, label: '停用', type: 'oidc' },
    } as const;
    Object.assign(oidcConfig.providers, providers);
    try {
      const oidc = getProvider('test-registry-oidc');
      expect(oidc).toBeInstanceOf(OidcAdapter);
      expect(getProvider('test-registry-oidc')).toBe(oidc);
      expect(getProvider('test-registry-dingtalk')).toBeInstanceOf(DingTalkAdapter);
      expect(getProvider('test-registry-siam')).toBeInstanceOf(SiamAdapter);
      expect(() => assertProviderVisible('test-registry-disabled')).toThrow('未开放');
      expect(() => getProvider('test-registry-disabled')).toThrow('不支持的登录方式');
      expect(() => getProvider('test-registry-missing')).toThrow('不支持的登录方式');
    } finally {
      for (const name of Object.keys(providers)) delete oidcConfig.providers[name];
    }
  });

  it('拒绝无分隔符、非法模式、非字符串 nonce 和超长 redirect', () => {
    expect(() => verifyState('not-a-token')).toThrow('state 无效');
    expect(() => verifyState(signState({ mode: 'other', provider: 'corp' } as any))).toThrow('内容无效');
    expect(() => verifyState(signState({ mode: 'login', provider: 'corp', nonce: 1 as any })))
      .toThrow('nonce 无效');
    expect(() => verifyState(signState({ mode: 'login', provider: 'corp', redirect: `/${'x'.repeat(500)}` })))
      .toThrow('redirect 无效');
  });
});
