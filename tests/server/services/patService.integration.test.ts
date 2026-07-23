import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersonalAccessToken } from '@server/entities/PersonalAccessToken';
import { User } from '@server/entities/User';
import { PatService } from '@server/services/patService';
import { hashPat } from '@server/middleware/auth';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

describe('PatService 集成', () => {
  beforeEach(async () => {
    const dataSource = await setupTestDb();
    await dataSource.getRepository(User).save([
      { id: 1, username: 'pat-user', password: 'hash', realName: '令牌用户', status: 1, roles: [] },
      { id: 2, username: 'other-user', password: 'hash', realName: '其他用户', status: 1, roles: [] },
      { id: 3, username: 'disabled-user', password: 'hash', realName: '停用用户', status: 0, roles: [] },
    ]);
  });
  afterEach(teardownTestDb);

  it('明文只在创建时返回，数据库和列表均不保存可恢复明文', async () => {
    const dataSource = getTestDataSource();
    const service = new PatService(dataSource.manager);
    const created = await service.createMine(1, '  自动化脚本  ', new Date(Date.now() + 60_000));

    expect(created.tokenPlain).toMatch(/^wpat_[a-f0-9]{32}$/);
    const stored = await dataSource.getRepository(PersonalAccessToken).findOneByOrFail({ id: created.id });
    expect(stored).toMatchObject({ name: '自动化脚本', tokenHash: hashPat(created.tokenPlain) });
    expect(stored).not.toHaveProperty('tokenPlain');
    expect(stored.tokenHash).not.toContain(created.tokenPlain);

    const [listed] = await service.listMine(1);
    expect(listed).not.toHaveProperty('tokenHash');
    expect(listed).not.toHaveProperty('tokenPlain');
  });

  it('拒绝过期时间、停用用户和删除他人的令牌', async () => {
    const dataSource = getTestDataSource();
    const service = new PatService(dataSource.manager);
    await expect(service.createMine(1, '过期令牌', new Date(Date.now() - 1_000)))
      .rejects.toThrow('过期时间必须晚于当前时间');
    await expect(service.createMine(3, '停用用户令牌')).rejects.toThrow('用户不存在或已禁用');

    const other = await service.createMine(2, '他人令牌');
    await expect(service.deleteMine(1, other.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await dataSource.getRepository(PersonalAccessToken).exist({ where: { id: other.id } })).toBe(true);
  });

  it('每个用户最多保留 20 个未过期令牌', async () => {
    const dataSource = getTestDataSource();
    const service = new PatService(getTestDataSource().manager);
    for (let index = 1; index <= 20; index += 1) {
      await service.createMine(1, `令牌 ${index}`);
    }
    await expect(service.createMine(1, '第 21 个令牌')).rejects.toThrow('最多保留 20 个');

    const oldest = await dataSource.getRepository(PersonalAccessToken).findOneByOrFail({ name: '令牌 1' });
    await dataSource.getRepository(PersonalAccessToken).update(oldest.id, { expiresAt: new Date(Date.now() - 1_000) });
    await expect(service.createMine(1, '过期记录释放名额')).resolves.toMatchObject({ name: '过期记录释放名额' });
  });

  it('严格校验名称边界，删除不存在的令牌不泄露额外信息', async () => {
    const service = new PatService(getTestDataSource().manager);
    await expect(service.createMine(1, '   ')).rejects.toThrow('令牌名称不能为空');
    await expect(service.createMine(1, '令'.repeat(101))).rejects.toThrow('最多 100 字符');
    await expect(service.deleteMine(1, 999)).rejects.toMatchObject({ statusCode: 404 });
  });
});
