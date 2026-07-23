import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AuditService } from '@server/services/auditService';
import { PatService } from '@server/services/patService';
import { createRouteTestApp } from '../helpers/http';

vi.mock('@server/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 6, username: 'pat-user', realName: '令牌用户', roles: ['employee'] };
    req.authMethod = 'jwt';
    next();
  },
}));

const { patRoutes } = await import('@server/routes/pat');
const app = createRouteTestApp('/pats', patRoutes);

describe('PAT 路由契约', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(AuditService.prototype, 'log').mockResolvedValue(undefined);
  });

  it('列表与删除始终绑定当前用户', async () => {
    const list = vi.spyOn(PatService.prototype, 'listMine').mockResolvedValue([]);
    const remove = vi.spyOn(PatService.prototype, 'deleteMine').mockResolvedValue(undefined);
    expect((await request(app).get('/pats')).status).toBe(200);
    expect(list).toHaveBeenCalledWith(6);

    expect((await request(app).delete('/pats/9')).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(6, 9);
  });

  it('创建时修剪名称并把本地日期时间转为标准时间', async () => {
    const create = vi.spyOn(PatService.prototype, 'createMine').mockResolvedValue({
      id: 4, name: 'Cursor', tokenPlain: 'wpat_secret',
    } as any);
    const response = await request(app).post('/pats').send({
      name: ' Cursor ', expiresAt: '2026-12-31T18:00:00+08:00',
    });
    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith(6, 'Cursor', new Date('2026-12-31T10:00:00.000Z'));
    expect(AuditService.prototype.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pat:create',
      targetId: 4,
      detail: 'Cursor',
    }));
    expect(JSON.stringify(vi.mocked(AuditService.prototype.log).mock.calls)).not.toContain('wpat_secret');
  });

  it('拒绝非法日期时间与非正整数令牌 ID', async () => {
    const create = vi.spyOn(PatService.prototype, 'createMine');
    expect((await request(app).post('/pats').send({ name: 'Cursor', expiresAt: 'not-a-date' })).status).toBe(400);
    expect(create).not.toHaveBeenCalled();

    const remove = vi.spyOn(PatService.prototype, 'deleteMine');
    expect((await request(app).delete('/pats/0')).status).toBe(400);
    expect(remove).not.toHaveBeenCalled();
  });
});
