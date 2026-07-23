import { describe, expect, it } from 'vitest';
import { safeInternalRedirect } from '@client/utils/navigation';

describe('safeInternalRedirect', () => {
  it.each(['/timesheet', '/approval?tab=mine', '/worktime/#/dashboard'])('保留站内路径 %s', (path) => {
    expect(safeInternalRedirect(path)).toBe(path);
  });

  it.each([
    'https://evil.example',
    '//evil.example/path',
    '/\\evil.example',
    '/%2f%2fevil.example',
    '/%255c%255cevil.example',
    '/bad%escape',
    `/path\u0000suffix`,
    'javascript:alert(1)',
    '',
  ])('拒绝外部或异常跳转 %s', (path) => {
    expect(safeInternalRedirect(path)).toBe('/');
  });
});
