import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { NotificationService } from '@server/services/notificationService';
import { createRouteTestApp } from '../helpers/http';

vi.mock('@server/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 7, username: 'tester', realName: '测试用户', roles: ['employee'] };
    next();
  },
}));

const { notificationRoutes } = await import('@server/routes/notification');
const app = createRouteTestApp('/notifications', notificationRoutes);

describe('通知路由契约', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('严格校验已读查询值', async () => {
    const service = vi.spyOn(NotificationService.prototype, 'getByUser');
    const response = await request(app).get('/notifications?isRead=yes');
    expect(response.status).toBe(400);
    expect(service).not.toHaveBeenCalled();
  });

  it('标记已读时去重 ID', async () => {
    const service = vi.spyOn(NotificationService.prototype, 'markAsRead').mockResolvedValue(undefined);
    const response = await request(app).put('/notifications/read').send({ ids: [2, 2, 3] });
    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith(7, [2, 3]);
  });

  it.each([{}, { ids: [] }, { ids: [0] }])('拒绝无效已读参数 %#', async (body) => {
    const service = vi.spyOn(NotificationService.prototype, 'markAsRead');
    const response = await request(app).put('/notifications/read').send(body);
    expect(response.status).toBe(400);
    expect(service).not.toHaveBeenCalled();
  });

  it('列表和未读数量始终查询当前用户', async () => {
    const list = vi.spyOn(NotificationService.prototype, 'getByUser').mockResolvedValue({
      list: [], total: 0, page: 2, pageSize: 5,
    });
    const count = vi.spyOn(NotificationService.prototype, 'getUnreadCount').mockResolvedValue(3);

    expect((await request(app).get('/notifications?page=2&pageSize=5&isRead=false')).status).toBe(200);
    expect(list).toHaveBeenCalledWith(7, { isRead: false, page: 2, pageSize: 5 });
    expect((await request(app).get('/notifications/unread-count')).body.data.count).toBe(3);
    expect(count).toHaveBeenCalledWith(7);
  });

  it('全部已读和删除操作均绑定当前用户', async () => {
    const markAll = vi.spyOn(NotificationService.prototype, 'markAllAsRead').mockResolvedValue(undefined);
    const remove = vi.spyOn(NotificationService.prototype, 'delete').mockResolvedValue(undefined);

    expect((await request(app).put('/notifications/read-all')).status).toBe(200);
    expect(markAll).toHaveBeenCalledWith(7);
    expect((await request(app).delete('/notifications/11')).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(7, 11);
  });
});
