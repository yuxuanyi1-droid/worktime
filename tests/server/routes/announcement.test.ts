import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AnnouncementService } from '@server/services/announcementService';
import { AuditService } from '@server/services/auditService';
import { createRouteTestApp } from '../helpers/http';

vi.mock('@server/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 5, username: 'admin', realName: '管理员', roles: ['admin'] };
    req.userPermissions = new Set();
    next();
  },
}));

vi.mock('@server/middleware/permission', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  getUserOrgInfo: vi.fn().mockResolvedValue({ departmentId: 10, groupId: 20, roleNames: [] }),
}));

const { announcementRoutes } = await import('@server/routes/announcement');
const app = createRouteTestApp('/announcements', announcementRoutes);

describe('公告路由契约', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(AuditService.prototype, 'log').mockResolvedValue(undefined);
  });

  it.each([
    { title: '部门公告', targetScope: 'department' },
    { title: '分组公告', targetScope: 'group' },
    { title: '指定用户', targetScope: 'user', targetUserIds: [] },
  ])('按公告范围要求对应目标参数：%#', async (body) => {
    const service = vi.spyOn(AnnouncementService.prototype, 'create');
    const response = await request(app).post('/announcements/admin').send(body);
    expect(response.status).toBe(400);
    expect(service).not.toHaveBeenCalled();
  });

  it('创建公告时保留正文空白并传入创建人', async () => {
    const service = vi.spyOn(AnnouncementService.prototype, 'create').mockResolvedValue({
      id: 1,
      title: '公告',
      content: '  第一行\n第二行  ',
      type: 'info',
      targetScope: 'all',
      ttStatus: 'skipped',
    } as any);
    const response = await request(app).post('/announcements/admin').send({
      title: '公告', content: '  第一行\n第二行  ', targetScope: 'all',
    });
    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith(expect.objectContaining({
      content: '  第一行\n第二行  ', createdById: 5,
    }));
    expect(AuditService.prototype.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'announcement.create', targetId: 1,
    }));
  });

  it('读取公告时严格解析 isRead', async () => {
    const service = vi.spyOn(AnnouncementService.prototype, 'getForUser');
    const response = await request(app).get('/announcements/my?isRead=1');
    expect(response.status).toBe(400);
    expect(service).not.toHaveBeenCalled();
  });

  it('管理端列表使用规范化分页参数', async () => {
    const service = vi.spyOn(AnnouncementService.prototype, 'getList').mockResolvedValue({
      list: [], total: 0, page: 2, pageSize: 10,
    });
    const response = await request(app).get('/announcements/admin/list?page=2&pageSize=10');
    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith({ page: 2, pageSize: 10 });
  });

  it('更新、删除和统计接口严格传递公告 ID', async () => {
    const update = vi.spyOn(AnnouncementService.prototype, 'update').mockResolvedValue({ id: 8 } as any);
    const remove = vi.spyOn(AnnouncementService.prototype, 'delete').mockResolvedValue(undefined);
    const stats = vi.spyOn(AnnouncementService.prototype, 'getReadStats').mockResolvedValue({
      targetCount: 2, readCount: 1, unreadCount: 1, readRate: 50, readUsers: [],
    });

    expect((await request(app).put('/announcements/admin/8').send({
      title: '更新公告', content: '正文', type: 'important', targetScope: 'department', targetDeptId: 3,
    })).status).toBe(200);
    expect(update).toHaveBeenCalledWith(8, expect.objectContaining({
      title: '更新公告', targetScope: 'department', targetDeptId: 3,
    }));

    expect((await request(app).get('/announcements/admin/8/stats')).status).toBe(200);
    expect(stats).toHaveBeenCalledWith(8);

    expect((await request(app).delete('/announcements/admin/8')).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(8);
  });

  it('用户端列表、计数、单条已读和全部已读均绑定当前用户组织', async () => {
    const list = vi.spyOn(AnnouncementService.prototype, 'getForUser').mockResolvedValue({
      list: [], total: 0, page: 3, pageSize: 5,
    });
    const count = vi.spyOn(AnnouncementService.prototype, 'getUnreadCount').mockResolvedValue(4);
    const mark = vi.spyOn(AnnouncementService.prototype, 'markAsRead').mockResolvedValue(undefined);
    const markAll = vi.spyOn(AnnouncementService.prototype, 'markAllAsRead').mockResolvedValue(undefined);

    const listResponse = await request(app).get('/announcements/my?page=3&pageSize=5&isRead=false');
    expect(listResponse.status).toBe(200);
    expect(list).toHaveBeenCalledWith(5, 10, 20, { page: 3, pageSize: 5, isRead: false });

    expect((await request(app).get('/announcements/my/unread-count')).body.data.count).toBe(4);
    expect(count).toHaveBeenCalledWith(5, 10, 20);

    expect((await request(app).put('/announcements/my/read/9')).status).toBe(200);
    expect(mark).toHaveBeenCalledWith(5, 9, 10, 20);

    expect((await request(app).put('/announcements/my/read-all')).status).toBe(200);
    expect(markAll).toHaveBeenCalledWith(5, 10, 20);
  });
});
