import { describe, expect, it } from 'vitest';
import { createPermissionChecker } from '@client/hooks/usePermission';
import type { UserInfo } from '@client/types';

function user(permissions: string[], roles: string[] = ['employee']): UserInfo {
  return {
    id: 1,
    username: 'tester',
    realName: '测试用户',
    department: null,
    group: null,
    permissions,
    roles: roles.map((name, index) => ({ id: index + 1, name, label: name })),
  };
}

describe('createPermissionChecker', () => {
  it('严格区分入口、查看和操作权限', () => {
    const checker = createPermissionChecker(user(['timesheet:access']));

    expect(checker.hasPermission('timesheet:access')).toBe(true);
    expect(checker.hasPermission('timesheet:view:self')).toBe(false);
    expect(checker.hasPermission('timesheet:update:self')).toBe(false);
  });

  it('展开保留的业务蕴含关系，但不反向推导入口权限', () => {
    const checker = createPermissionChecker(user(['report:view:all']));

    expect(checker.hasPermission('report:view:self')).toBe(true);
    expect(checker.hasPermission('report:view:department')).toBe(true);
    expect(checker.hasPermission('report:access')).toBe(false);
  });

  it('管理员拥有全部权限和角色判断能力', () => {
    const checker = createPermissionChecker(user([], ['admin']));

    expect(checker.isAdmin).toBe(true);
    expect(checker.hasPermission('arbitrary:permission')).toBe(true);
    expect(checker.hasAllPermissions('a', 'b')).toBe(true);
    expect(checker.hasRole('manager')).toBe(true);
  });

  it('任一与全部权限判断语义正确', () => {
    const checker = createPermissionChecker(user(['a', 'b']));

    expect(checker.hasAnyPermission('x', 'b')).toBe(true);
    expect(checker.hasAnyPermission('x', 'y')).toBe(false);
    expect(checker.hasAllPermissions('a', 'b')).toBe(true);
    expect(checker.hasAllPermissions('a', 'c')).toBe(false);
  });
});
