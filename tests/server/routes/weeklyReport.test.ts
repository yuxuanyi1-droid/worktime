import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WeeklyReportService } from '@server/services/weeklyReportService';
import { AccessPolicyService } from '@server/services/accessPolicyService';
import { createRouteTestApp } from '../helpers/http';

vi.mock('@server/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 4, username: 'weekly-user', realName: '周报用户', roles: ['employee'] };
    req.userPermissions = new Set([
      'weekly_report:view:self', 'weekly_report:create', 'weekly_report:submit:self',
    ]);
    next();
  },
}));

const { weeklyReportRoutes } = await import('@server/routes/weeklyReport');
const app = createRouteTestApp('/weekly-reports', weeklyReportRoutes);

describe('周报路由契约', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('列表使用服务端分页，且用户标识不可由客户端覆盖', async () => {
    const getByUser = vi.spyOn(WeeklyReportService.prototype, 'getByUser').mockResolvedValue({
      list: [], total: 0, page: 2, pageSize: 10,
    });
    const response = await request(app).get('/weekly-reports/my?userId=999&page=2&pageSize=10');
    expect(response.status).toBe(200);
    expect(getByUser).toHaveBeenCalledWith(4, { page: 2, pageSize: 10 });
  });

  it('保存周报只采信当前用户，工时合计由服务层重算', async () => {
    const save = vi.spyOn(WeeklyReportService.prototype, 'createOrUpdate').mockResolvedValue({ id: 6 } as any);
    const response = await request(app).post('/weekly-reports').send({
      userId: 999,
      weekStart: '2026-07-20', weekEnd: '2026-07-26',
      content: '本周完成了核心功能', summary: '按计划进行', totalDays: 99,
    });
    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledWith({
      userId: 4,
      weekStart: '2026-07-20', weekEnd: '2026-07-26',
      content: '本周完成了核心功能', summary: '按计划进行',
    });
  });

  it('在服务调用前拒绝非法日期和超长内容', async () => {
    const save = vi.spyOn(WeeklyReportService.prototype, 'createOrUpdate');
    const invalidDate = await request(app).post('/weekly-reports').send({
      weekStart: '2026-02-30', weekEnd: '2026-03-07', content: '内容',
    });
    expect(invalidDate.status).toBe(400);

    const tooLong = await request(app).post('/weekly-reports').send({
      weekStart: '2026-07-20', weekEnd: '2026-07-26', content: 'a'.repeat(20001),
    });
    expect(tooLong.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('提交时仅传入当前用户与正整数周报 ID', async () => {
    const submit = vi.spyOn(WeeklyReportService.prototype, 'submit').mockResolvedValue(true);
    const invalid = await request(app).post('/weekly-reports/submit').send({ id: 0 });
    expect(invalid.status).toBe(400);
    expect(submit).not.toHaveBeenCalled();

    const valid = await request(app).post('/weekly-reports/submit').send({ id: 9, userId: 999 });
    expect(valid.status).toBe(200);
    expect(submit).toHaveBeenCalledWith(9, 4);
  });

  it('按周查看先执行对象级授权，并锁定目标用户', async () => {
    const canAccess = vi.spyOn(AccessPolicyService.prototype, 'canAccessUserData').mockResolvedValue(true);
    const getByWeek = vi.spyOn(WeeklyReportService.prototype, 'getByWeek').mockResolvedValue({ id: 2 } as any);
    const allowed = await request(app).get('/weekly-reports/week?userId=9&weekStart=2026-07-20');
    expect(allowed.status).toBe(200);
    expect(canAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }), 9, expect.objectContaining({
      departmentPermissions: ['weekly_report:view:department'],
      groupPermissions: ['weekly_report:view:group'],
    }));
    expect(getByWeek).toHaveBeenCalledWith(9, '2026-07-20');

    canAccess.mockResolvedValue(false);
    expect((await request(app).get('/weekly-reports/week?userId=10&weekStart=2026-07-20')).status).toBe(403);
    expect(getByWeek).toHaveBeenCalledTimes(1);
  });
});
