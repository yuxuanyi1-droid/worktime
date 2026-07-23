import { describe, expect, it } from 'vitest';
import { hashPat, isAgentRequestAllowed } from '@server/middleware/auth';

describe('认证中间件安全边界', () => {
  it('PAT 哈希稳定且不泄露明文', () => {
    const token = 'wpat_secret-value';
    const hash = hashPat(token);
    expect(hash).toHaveLength(64);
    expect(hash).toBe(hashPat(token));
    expect(hash).not.toContain(token);
  });

  it.each([
    '/api/v1/timesheets/my',
    '/worktime/api/v1/overtime/stats?year=2026',
    '/api/v1/weekly-reports/week?weekStart=2026-07-20',
    '/api/v1/approvals/pending?page=1',
    '/api/v1/reports/department?startDate=2026-07-01',
  ])('允许 AI 令牌读取白名单接口：%s', (url) => {
    expect(isAgentRequestAllowed('GET', url)).toBe(true);
  });

  it.each([
    ['POST', '/api/v1/timesheets/submit-rows'],
    ['DELETE', '/api/v1/pats/1'],
    ['GET', '/api/v1/auth/profile'],
    ['GET', '/api/v1/system/users'],
    ['GET', '/api/v2/timesheets/my'],
  ])('拒绝 AI 令牌越权访问：%s %s', (method, url) => {
    expect(isAgentRequestAllowed(method, url)).toBe(false);
  });
});
