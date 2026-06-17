import { describe, it, expect } from 'vitest';
import { expandPermissionCodes, permissionImplications } from './permissionDefinitions';

describe('expandPermissionCodes', () => {
  it('返回输入码本身', () => {
    const result = expandPermissionCodes(['timesheet:read']);
    expect(result.has('timesheet:read')).toBe(true);
  });

  it('展开蕴含关系（不动点）', () => {
    // permissionImplications 里 timesheet:export => timesheet:access
    const result = expandPermissionCodes(['timesheet:export']);
    expect(result.has('timesheet:export')).toBe(true);
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

  it('permissionImplications 至少包含已定义的导出=>访问映射', () => {
    expect(permissionImplications['timesheet:export']).toContain('timesheet:access');
    expect(permissionImplications['report:export']).toContain('report:access');
  });
});
