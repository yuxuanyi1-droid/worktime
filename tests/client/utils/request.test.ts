import { afterEach, describe, expect, it, vi } from 'vitest';
import request from '@client/utils/request';
import { useAuthStore } from '@client/stores/authStore';

const originalAdapter = request.defaults.adapter;

afterEach(() => {
  request.defaults.adapter = originalAdapter;
  useAuthStore.setState({ token: null, user: null });
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('HTTP 请求封装', () => {
  it('自动注入本地登录令牌', async () => {
    localStorage.setItem('token', 'jwt-token');
    const adapter = vi.fn(async (config: any) => ({
      data: { code: 0, data: { ok: true } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }));
    request.defaults.adapter = adapter;

    await request.get('/test');

    expect(adapter.mock.calls[0][0].headers.Authorization).toBe('Bearer jwt-token');
  });

  it('401 时清除身份并派发一次软跳转事件', async () => {
    useAuthStore.setState({
      token: 'jwt-token',
      user: {
        id: 1,
        username: 'tester',
        realName: '测试用户',
        department: null,
        group: null,
        roles: [],
        permissions: [],
      },
    });
    window.history.replaceState({}, '', '/timesheet');
    const onUnauthorized = vi.fn();
    window.addEventListener('unauthorized', onUnauthorized, { once: true });
    request.defaults.adapter = vi.fn(async (config: any) => Promise.reject({
      message: 'Unauthorized',
      config,
      response: { status: 401, data: { code: 401, message: '登录失效' } },
    }));

    await expect(request.get('/private')).rejects.toMatchObject({ message: 'Unauthorized' });

    expect(useAuthStore.getState()).toMatchObject({ token: null, user: null });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('业务 code 非零时按失败处理', async () => {
    request.defaults.adapter = vi.fn(async (config: any) => ({
      data: { code: 403, message: '没有权限' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }));

    await expect(request.get('/business-error')).rejects.toThrow('没有权限');
  });
});
