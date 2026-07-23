import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { TimesheetService } from '@server/services/timesheetService';
import { AccessPolicyService } from '@server/services/accessPolicyService';
import { createRouteTestApp } from '../helpers/http';

vi.mock('@server/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 1, username: 'employee', realName: '工时用户', roles: ['employee'] };
    req.userPermissions = new Set([
      'timesheet:view:self', 'timesheet:create', 'timesheet:update:self',
      'timesheet:delete:self', 'timesheet:submit:self',
    ]);
    next();
  },
}));

const { timesheetRoutes } = await import('@server/routes/timesheet');
const app = createRouteTestApp('/timesheets', timesheetRoutes);

describe('工时路由契约', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('单边日期会传入服务层，反向日期在查询前被拒绝', async () => {
    const service = vi.spyOn(TimesheetService.prototype, 'getByUser').mockResolvedValue({
      list: [], total: 0, page: 1, pageSize: 50,
    });

    const valid = await request(app).get('/timesheets/my?startDate=2026-07-01');
    expect(valid.status).toBe(200);
    expect(service).toHaveBeenCalledWith(1, expect.objectContaining({
      startDate: '2026-07-01', endDate: undefined,
    }));

    service.mockClear();
    const invalid = await request(app).get('/timesheets/my?startDate=2026-07-31&endDate=2026-07-01');
    expect(invalid.status).toBe(400);
    expect(invalid.body.message).toBe('startDate不能晚于endDate');
    expect(service).not.toHaveBeenCalled();
  });

  it('批量提交去重 ID，避免重复选择被误判为记录不存在', async () => {
    const service = vi.spyOn(TimesheetService.prototype, 'submit').mockResolvedValue(true);
    const response = await request(app).post('/timesheets/submit').send({ ids: [3, 3, 5] });

    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith([3, 5], 1);
  });

  it('工时列表允许按已撤回状态筛选', async () => {
    const service = vi.spyOn(TimesheetService.prototype, 'getByUser').mockResolvedValue({
      list: [], total: 0, page: 1, pageSize: 50,
    });
    const response = await request(app).get('/timesheets/my?status=withdrawn');

    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'withdrawn' }));
  });

  it('整周草稿通过单个原子替换调用保存', async () => {
    const replace = vi.spyOn(TimesheetService.prototype, 'replaceWeekDrafts').mockResolvedValue([]);
    const response = await request(app).post('/timesheets/drafts/replace').send({
      weekStart: '2026-07-20',
      items: [{ projectId: 2, date: '2026-07-20', days: 0.5, description: '开发' }],
    });
    expect(response.status).toBe(200);
    expect(replace).toHaveBeenCalledWith(1, '2026-07-20', [{
      projectId: 2, date: '2026-07-20', days: 0.5, description: '开发',
    }]);
  });

  it('拒绝超过单日上限的工时和空工作内容行', async () => {
    const create = vi.spyOn(TimesheetService.prototype, 'create');
    const tooManyDays = await request(app).post('/timesheets').send({
      projectId: 2, date: '2026-07-20', days: 1.5, description: '开发',
    });
    expect(tooManyDays.status).toBe(400);
    expect(create).not.toHaveBeenCalled();

    const submitRows = vi.spyOn(TimesheetService.prototype, 'submitByRows');
    const emptyDescription = await request(app).post('/timesheets/submit-rows').send({
      rows: [{
        projectId: 2,
        description: '   ',
        weekStart: '2026-07-20',
        entries: [{ date: '2026-07-20', days: 1 }],
      }],
    });
    expect(emptyDescription.status).toBe(400);
    expect(submitRows).not.toHaveBeenCalled();
  });

  it('周汇总先做对象级授权，再查询目标用户', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'canAccessUserData').mockResolvedValue(true);
    const summary = vi.spyOn(TimesheetService.prototype, 'getWeeklySummary').mockResolvedValue({ totalDays: 3 } as any);
    const response = await request(app).get(
      '/timesheets/weekly-summary?userId=7&weekStart=2026-07-20&weekEnd=2026-07-26',
    );
    expect(response.status).toBe(200);
    expect(summary).toHaveBeenCalledWith(7, '2026-07-20', '2026-07-26');

    vi.mocked(AccessPolicyService.prototype.canAccessUserData).mockResolvedValue(false);
    expect((await request(app).get(
      '/timesheets/weekly-summary?userId=8&weekStart=2026-07-20&weekEnd=2026-07-26',
    )).status).toBe(403);
    expect(summary).toHaveBeenCalledTimes(1);
  });

  it('单条与批量创建始终使用当前用户', async () => {
    const create = vi.spyOn(TimesheetService.prototype, 'create').mockResolvedValue({ id: 2 } as any);
    const batch = vi.spyOn(TimesheetService.prototype, 'batchCreate').mockResolvedValue([{ id: 3 }] as any);
    const item = { userId: 999, projectId: 2, date: '2026-07-20', days: 0.5, description: '开发' };
    expect((await request(app).post('/timesheets').send(item)).status).toBe(200);
    expect(create).toHaveBeenCalledWith({ projectId: 2, date: '2026-07-20', days: 0.5, description: '开发', userId: 1 });
    expect((await request(app).post('/timesheets/batch').send({ items: [item] })).status).toBe(200);
    expect(batch).toHaveBeenCalledWith(1, [{ projectId: 2, date: '2026-07-20', days: 0.5, description: '开发' }]);
  });

  it('更新、删除和按行提交均绑定当前用户', async () => {
    const update = vi.spyOn(TimesheetService.prototype, 'update').mockResolvedValue({ id: 4 } as any);
    const remove = vi.spyOn(TimesheetService.prototype, 'delete').mockResolvedValue({ affected: 1 } as any);
    const submitRows = vi.spyOn(TimesheetService.prototype, 'submitByRows').mockResolvedValue(true);
    const modify = vi.spyOn(TimesheetService.prototype, 'modifySubmitted').mockResolvedValue(true);

    expect((await request(app).put('/timesheets/4').send({
      userId: 999, status: 'approved', projectId: 3, days: 1, description: '调整',
    })).status).toBe(200);
    expect(update).toHaveBeenCalledWith(4, 1, { projectId: 3, days: 1, description: '调整' });
    expect((await request(app).delete('/timesheets/4')).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(4, 1);

    const rows = [{
      projectId: 3, description: '开发', weekStart: '2026-07-20',
      entries: [{ date: '2026-07-20', days: 1 }],
    }];
    expect((await request(app).post('/timesheets/submit-rows').send({ rows })).status).toBe(200);
    expect(submitRows).toHaveBeenCalledWith(1, rows);
    expect((await request(app).post('/timesheets/modify').send({ rows })).status).toBe(200);
    expect(modify).toHaveBeenCalledWith(1, rows);
  });
});
