import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AuditService } from '@server/services/auditService';
import { createRouteTestApp } from '../helpers/http';

vi.mock('@server/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 1, username: 'auditor', realName: '审计员', roles: ['employee'] };
    req.userPermissions = new Set(['system:audit:view']);
    next();
  },
}));

const { auditRoutes } = await import('@server/routes/audit');
const app = createRouteTestApp('/audit', auditRoutes);

describe('审计日志路由契约', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('拒绝颠倒的日期区间', async () => {
    const service = vi.spyOn(AuditService.prototype, 'getLogs');
    const response = await request(app).get('/audit?startDate=2026-07-20&endDate=2026-07-01');
    expect(response.status).toBe(400);
    expect(service).not.toHaveBeenCalled();
  });

  it('规范化时间并支持单边过滤', async () => {
    const service = vi.spyOn(AuditService.prototype, 'getLogs').mockResolvedValue({
      list: [], total: 0, page: 1, pageSize: 20,
    });
    const response = await request(app).get('/audit?startDate=2026-07-01T08:00:00%2B08:00&action=login');
    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith(expect.objectContaining({
      startDate: '2026-07-01T00:00:00.000Z', endDate: undefined, action: 'login',
    }));
  });
});
