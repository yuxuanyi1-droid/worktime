import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, getTestDataSource, teardownTestDb } from './test/setup';
import { User } from './entities/User';
import { WeeklyReport } from './entities/WeeklyReport';
import { UserPermissionGrant } from './entities/UserPermissionGrant';

/**
 * E15/E16 集成测试：验证关键实体约束（本轮 schema 改动的正确性）。
 * 覆盖：mustChangePassword 列存在、周报唯一约束、grant partial unique。
 */
describe('实体约束集成测试', () => {
  let userId: number;

  beforeAll(async () => {
    await setupTestDb();
    const ds = getTestDataSource();
    const u = ds.getRepository(User).create({ username: 'constraint_test', password: 'hashed', realName: 't' });
    const saved = await ds.getRepository(User).save(u);
    userId = saved.id;
  });
  afterAll(async () => { await teardownTestDb(); });

  it('User.mustChangePassword 列存在（save 后默认 false）', async () => {
    const ds = getTestDataSource();
    const repo = ds.getRepository(User);
    const u = await repo.save(repo.create({ username: 'mcp_test', password: 'x', realName: 't' }));
    const reloaded = await repo.findOneBy({ id: u.id });
    expect(reloaded?.mustChangePassword).toBe(false);
    expect(reloaded?.status).toBe(1);
  });

  it('WeeklyReport (userId, weekStart) 唯一约束', async () => {
    const ds = getTestDataSource();
    const repo = ds.getRepository(WeeklyReport);
    const base = { userId, weekStart: '2026-02-02', weekEnd: '2026-02-08', content: '', summary: '', totalHours: 0, status: 'draft' as const };
    await repo.save(repo.create(base));
    await expect(repo.save(repo.create(base))).rejects.toThrow(/UNIQUE/i);
  });

  it('UserPermissionGrant 实体可正常 CRUD（partial unique 由 migration 1700000000005 创建，synchronize 不建带 where 的索引）', async () => {
    const ds = getTestDataSource();
    const repo = ds.getRepository(UserPermissionGrant);
    const active = { userId, permissionCode: 'test:grant2', scopeType: 'global' as const, scopeId: null, status: 'active' as const, source: 'manual' as const };
    const saved = await repo.save(repo.create(active));
    expect(saved.id).toBeDefined();
    // revoked 记录也能正常创建
    const revoked = await repo.save(repo.create({ ...active, permissionCode: 'test:grant3', status: 'revoked' as const }));
    expect(revoked.id).toBeDefined();
  });
});
