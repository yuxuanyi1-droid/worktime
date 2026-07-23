import { describe, it, expect } from 'vitest';
import { expandPermissionCodes, permissionImplications } from '@server/config/permissionDefinitions';

describe('expandPermissionCodes', () => {
  it('返回输入码本身', () => {
    const result = expandPermissionCodes(['timesheet:access']);
    expect(result.has('timesheet:access')).toBe(true);
  });

  it('业务操作权限不会自动获得入口权限', () => {
    const result = expandPermissionCodes(['timesheet:submit:self']);
    expect(result.has('timesheet:submit:self')).toBe(true);
    expect(result.has('timesheet:access')).toBe(false);
  });

  it('多级蕴含传递', () => {
    const result = expandPermissionCodes(['system:announcement:create']);
    expect(result.has('system:announcement:create')).toBe(true);
    expect(result.has('system:announcement:view')).toBe(true);
    expect(result.has('system:access')).toBe(false);
  });

  it('空输入返回空集合', () => {
    const result = expandPermissionCodes([]);
    expect(result.size).toBe(0);
  });

  it('多个权限码合并', () => {
    const result = expandPermissionCodes(['timesheet:access', 'overtime:access']);
    expect(result.has('timesheet:access')).toBe(true);
    expect(result.has('overtime:access')).toBe(true);
  });

  it('permissionImplications 不包含业务动作到入口的隐式映射', () => {
    expect(permissionImplications['timesheet:submit:self']).toBeUndefined();
    expect(permissionImplications['report:export']).toBeUndefined();
  });

  it('权限目录不再包含没有实际控制点的旧权限', async () => {
    const { permissionDefinitions } = await import('@server/config/permissionDefinitions');
    const codes = new Set(permissionDefinitions.map(item => item.code));
    expect(codes.has('timesheet:export')).toBe(false);
    expect(codes.has('overtime:export')).toBe(false);
    expect(codes.has('approval:view:all')).toBe(false);
  });
});
