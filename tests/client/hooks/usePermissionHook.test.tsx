import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { usePermission } from '@client/hooks/usePermission';
import { useAuthStore } from '@client/stores/authStore';

afterEach(() => {
  act(() => useAuthStore.setState({ token: null, user: null }));
});

describe('usePermission hook', () => {
  it('跟随登录用户快照更新权限判断', () => {
    const { result } = renderHook(() => usePermission());
    expect(result.current.hasPermission('timesheet:access')).toBe(false);

    act(() => useAuthStore.setState({
      token: 'token',
      user: {
        id: 1,
        username: 'tester',
        realName: '测试用户',
        department: null,
        group: null,
        roles: [{ id: 1, name: 'employee', label: '员工' }],
        permissions: ['timesheet:access'],
      },
    }));

    expect(result.current.hasPermission('timesheet:access')).toBe(true);
  });
});
