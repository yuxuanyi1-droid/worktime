import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOidcIntent,
  setOidcIntent,
  takeOidcIntent,
} from '@client/utils/oidcIntent';

describe('OIDC 浏览器一次性意图', () => {
  beforeEach(() => {
    clearOidcIntent();
    vi.restoreAllMocks();
  });

  it('保存时规范化站内跳转，读取后立即销毁', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    setOidcIntent({ mode: 'login', provider: 'corp-sso', redirect: '//evil.example' });

    expect(takeOidcIntent(2_000)).toEqual({
      mode: 'login', provider: 'corp-sso', redirect: '/', createdAt: 1_000,
    });
    expect(takeOidcIntent(2_000)).toBeNull();
  });

  it('拒绝过期、未来时间、畸形 JSON 和非法 provider', () => {
    sessionStorage.setItem('oidc_pending_intent', JSON.stringify({
      mode: 'login', provider: 'corp', createdAt: 1_000,
    }));
    expect(takeOidcIntent(16 * 60 * 1_000 + 1)).toBeNull();

    sessionStorage.setItem('oidc_pending_intent', JSON.stringify({
      mode: 'login', provider: 'corp', createdAt: 100_000,
    }));
    expect(takeOidcIntent(1_000)).toBeNull();

    sessionStorage.setItem('oidc_pending_intent', '{invalid');
    expect(takeOidcIntent()).toBeNull();
    expect(() => setOidcIntent({ mode: 'login', provider: 'bad/provider' })).toThrow('provider 标识无效');
  });
});
