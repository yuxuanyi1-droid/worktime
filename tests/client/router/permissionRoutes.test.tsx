import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { allMenuItems } from '@client/components/Layout/MainLayout';
import { PermissionRoute, ROUTE_PERMISSIONS } from '@client/router';
import { useAuthStore } from '@client/stores/authStore';

describe('功能入口权限一致性', () => {
  it('所有受控菜单与页面路由使用同一个 access 权限语义', () => {
    const guardedMenuItems = allMenuItems.filter(item => item.permission);
    for (const item of guardedMenuItems) {
      expect(ROUTE_PERMISSIONS[item.key as keyof typeof ROUTE_PERMISSIONS]).toBe(item.permission);
    }
    expect(ROUTE_PERMISSIONS['/project']).toBe('project:access');
  });

  it('缺少入口权限时直接路由访问也不会渲染功能页面', () => {
    useAuthStore.setState({
      token: 'token',
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

    render(
      <MemoryRouter>
        <PermissionRoute permission="project:access"><div>项目管理内容</div></PermissionRoute>
      </MemoryRouter>,
    );

    expect(screen.getByText('无权限')).toBeInTheDocument();
    expect(screen.queryByText('项目管理内容')).not.toBeInTheDocument();
  });
});
