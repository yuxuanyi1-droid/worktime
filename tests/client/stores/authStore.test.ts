import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@client/stores/authStore';
import type { UserInfo } from '@client/types';

const testUser: UserInfo = {
  id: 7,
  username: 'employee7',
  realName: '员工七',
  department: null,
  group: null,
  roles: [],
  permissions: [],
};

beforeEach(() => {
  act(() => useAuthStore.getState().clearAuth());
});

describe('authStore', () => {
  it('登录状态同时写入内存和 localStorage', () => {
    act(() => useAuthStore.getState().setAuth('jwt-token', testUser));

    expect(useAuthStore.getState().token).toBe('jwt-token');
    expect(useAuthStore.getState().user).toEqual(testUser);
    expect(localStorage.getItem('token')).toBe('jwt-token');
    expect(JSON.parse(localStorage.getItem('user') || '{}')).toEqual(testUser);
    expect(useAuthStore.getState().isLoggedIn()).toBe(true);
  });

  it('退出时清理全部认证状态', () => {
    act(() => useAuthStore.getState().setAuth('jwt-token', testUser));
    act(() => useAuthStore.getState().clearAuth());

    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
  });

  it('响应其它标签页触发的 storage 事件', () => {
    localStorage.setItem('token', 'other-tab-token');
    localStorage.setItem('user', JSON.stringify(testUser));
    window.dispatchEvent(new StorageEvent('storage', { key: 'token' }));

    expect(useAuthStore.getState().token).toBe('other-tab-token');
    expect(useAuthStore.getState().user).toEqual(testUser);
  });
});
