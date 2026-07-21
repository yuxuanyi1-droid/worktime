import { describe, it, expect } from 'vitest';
import { expandPermissionCodes, permissionImplications } from './permissionDefinitions';

describe('expandPermissionCodes', () => {
  it('返回输入码本身', () => {
    const result = expandPermissionCodes(['timesheet:read']);
    expect(result.has('timesheet:read')).toBe(true);
  });

  it('展开蕴含关系（不动点）', () => {
    const result = expandPermissionCodes(['timesheet:submit:self']);
    expect(result.has('timesheet:submit:self')).toBe(true);
    expect(result.has('timesheet:access')).toBe(true);
  });

  it('多级蕴含传递', () => {
    // 若 A=>B 且 B=>C，则给 A 应得 C
    const result = expandPermissionCodes(['report:export']);
    expect(result.has('report:export')).toBe(true);
    expect(result.has('report:access')).toBe(true);
  });

  it('空输入返回空集合', () => {
    const result = expandPermissionCodes([]);
    expect(result.size).toBe(0);
  });

  it('多个权限码合并', () => {
    const result = expandPermissionCodes(['timesheet:read', 'overtime:read']);
    expect(result.has('timesheet:read')).toBe(true);
    expect(result.has('overtime:read')).toBe(true);
  });

  it('permissionImplications 包含已定义的动作=>访问映射', () => {
    expect(permissionImplications['timesheet:submit:self']).toContain('timesheet:access');
    expect(permissionImplications['report:export']).toContain('report:access');
  });

  it('权限目录不再包含没有实际控制点的旧权限', async () => {
    const { permissionDefinitions } = await import('./permissionDefinitions');
    const codes = new Set(permissionDefinitions.map(item => item.code));
    expect(codes.has('timesheet:export')).toBe(false);
    expect(codes.has('overtime:export')).toBe(false);
    expect(codes.has('approval:view:all')).toBe(false);
  });
});
