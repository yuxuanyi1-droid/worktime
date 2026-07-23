import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { OvertimeService } from '@server/services/overtimeService';
import { createRouteTestApp } from '../helpers/http';

vi.mock('@server/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 1, username: 'tester', realName: '测试用户', roles: ['employee'] };
    req.userPermissions = new Set([
      'overtime:view:self', 'overtime:create', 'overtime:update:self',
      'overtime:delete:self', 'overtime:submit:self',
    ]);
    next();
  },
}));

const { overtimeRoutes } = await import('@server/routes/overtime');
const app = createRouteTestApp('/overtime', overtimeRoutes);

describe('加班路由契约', () => {

  beforeEach(() => vi.restoreAllMocks());

  it('拒绝结束日期早于开始日期', async () => {
    const service = vi.spyOn(OvertimeService.prototype, 'getByUser');
    const response = await request(app).get('/overtime/my?startDate=2026-07-20&endDate=2026-07-01');
    expect(response.status).toBe(400);
    expect(response.body.message).toBe('startDate不能晚于endDate');
    expect(service).not.toHaveBeenCalled();
  });

  it('接受撤回状态筛选并传递单边日期', async () => {
    const service = vi.spyOn(OvertimeService.prototype, 'getByUser').mockResolvedValue({
      list: [], total: 0, page: 1, pageSize: 20,
    });
    const response = await request(app).get('/overtime/my?status=withdrawn&startDate=2026-07-01');
    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith(1, expect.objectContaining({
      status: 'withdrawn', startDate: '2026-07-01', endDate: undefined,
    }));
  });

  it('创建加班时项目必填', async () => {
    const service = vi.spyOn(OvertimeService.prototype, 'create');
    const response = await request(app).post('/overtime').send({
      date: '2026-07-20', overtimeType: 'weekday', days: 0.5,
    });
    expect(response.status).toBe(400);
    expect(service).not.toHaveBeenCalled();
  });

  it('批量提交前去重记录 ID', async () => {
    const service = vi.spyOn(OvertimeService.prototype, 'submit').mockResolvedValue(true);
    const response = await request(app).post('/overtime/submit').send({ ids: [3, 3, 5] });
    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith([3, 5], 1);
  });

  it('统计接口校验年月并绑定当前用户', async () => {
    const stats = vi.spyOn(OvertimeService.prototype, 'getStats').mockResolvedValue([{ type: 'weekend' }] as any);
    const response = await request(app).get('/overtime/stats?year=2026&month=7');
    expect(response.status).toBe(200);
    expect(stats).toHaveBeenCalledWith(1, 2026, 7);
    expect((await request(app).get('/overtime/stats?year=2026&month=13')).status).toBe(400);
    expect(stats).toHaveBeenCalledTimes(1);
  });

  it('创建和直接提交均忽略客户端 userId', async () => {
    const create = vi.spyOn(OvertimeService.prototype, 'create').mockResolvedValue({ id: 8 } as any);
    const createAndSubmit = vi.spyOn(OvertimeService.prototype, 'createAndSubmit').mockResolvedValue({ id: 9 } as any);
    const payload = {
      userId: 999, date: '2026-07-20', overtimeType: 'weekday', days: 0.5,
      reason: '发布保障', projectId: 2,
    };
    expect((await request(app).post('/overtime').send(payload)).status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, projectId: 2 }));
    expect((await request(app).post('/overtime/submit-new').send(payload)).status).toBe(200);
    expect(createAndSubmit).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, projectId: 2 }));
  });

  it('更新仅传递白名单字段，删除绑定当前用户', async () => {
    const update = vi.spyOn(OvertimeService.prototype, 'update').mockResolvedValue({ id: 4 } as any);
    const remove = vi.spyOn(OvertimeService.prototype, 'delete').mockResolvedValue({ affected: 1 } as any);
    const response = await request(app).put('/overtime/4').send({
      userId: 999, status: 'approved', days: 1, reason: '更新原因', projectId: 3,
    });
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith(4, 1, {
      date: undefined, overtimeType: undefined, days: 1, reason: '更新原因', projectId: 3,
    });
    expect((await request(app).delete('/overtime/4')).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(4, 1);
  });
});
