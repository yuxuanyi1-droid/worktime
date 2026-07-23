import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { oidcConfig } from '@server/config/auth';
import { User } from '@server/entities/User';
import { UserExternalIdentity } from '@server/entities/UserExternalIdentity';
import { ExternalIdentityService } from '@server/services/externalIdentityService';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

const supplementalProvider = 'test-supplemental';
const jitProvider = 'test-primary';

describe('ExternalIdentityService 集成', () => {
  beforeEach(async () => {
    const dataSource = await setupTestDb();
    await dataSource.getRepository(User).save([
      { id: 1, username: 'identity-user', password: 'hash', realName: '绑定用户', status: 1, roles: [] },
      { id: 2, username: 'identity-other', password: 'hash', realName: '其他用户', status: 1, roles: [] },
      { id: 3, username: 'identity-disabled', password: 'hash', realName: '停用用户', status: 0, roles: [] },
    ]);
    oidcConfig.providers[supplementalProvider] = {
      enabled: true, label: '补充身份源', type: 'dingtalk', jit: false,
    };
    oidcConfig.providers[jitProvider] = {
      enabled: true, label: '主身份源', type: 'oidc', jit: true,
    };
  });

  afterEach(async () => {
    delete oidcConfig.providers[supplementalProvider];
    delete oidcConfig.providers[jitProvider];
    await teardownTestDb();
  });

  it('绑定对当前用户幂等，并同步展示账号与 SIAM 工号', async () => {
    const dataSource = getTestDataSource();
    const service = new ExternalIdentityService(dataSource.manager);
    const first = await service.bind(1, supplementalProvider, {
      subject: ' external-1 ', username: ' 旧展示名 ', employeeId: ' 10001 ',
    });
    const second = await service.bind(1, supplementalProvider, {
      subject: 'external-1', username: '新展示名', employeeId: '10002',
    });

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ externalUsername: '新展示名', employeeId: '10002', userId: 1 });
    expect(await dataSource.getRepository(UserExternalIdentity).count()).toBe(1);
  });

  it('拒绝会突破数据库字段或组织层级约束的异常身份 claim', async () => {
    const service = new ExternalIdentityService(getTestDataSource().manager);
    await expect(service.bind(1, supplementalProvider, {
      subject: 'x'.repeat(256),
    })).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('唯一标识') });
    await expect(service.bind(1, supplementalProvider, {
      subject: 'valid-subject', employeeId: 'x'.repeat(101),
    })).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('工号') });
    expect(await getTestDataSource().getRepository(UserExternalIdentity).count()).toBe(0);
  });

  it('同一外部账号不能绑定多人，同一用户不能绑定两个同类型账号', async () => {
    const service = new ExternalIdentityService(getTestDataSource().manager);
    await service.bind(1, supplementalProvider, { subject: 'external-shared' });
    await expect(service.bind(2, supplementalProvider, { subject: 'external-shared' }))
      .rejects.toThrow('已绑定到其他用户');
    await expect(service.bind(1, supplementalProvider, { subject: 'external-second' }))
      .rejects.toThrow('已绑定过一个');
  });

  it('拒绝为停用用户绑定，主身份源绑定不能自助解绑', async () => {
    const service = new ExternalIdentityService(getTestDataSource().manager);
    await expect(service.bind(3, supplementalProvider, { subject: 'disabled-subject' }))
      .rejects.toThrow('用户不存在或已被禁用');

    await service.bind(1, jitProvider, { subject: 'primary-subject' });
    await expect(service.unbind(1, jitProvider)).rejects.toMatchObject({ statusCode: 403 });

    await service.bind(2, supplementalProvider, { subject: 'removable-subject' });
    await service.unbind(2, supplementalProvider);
    expect(await getTestDataSource().getRepository(UserExternalIdentity).countBy({ userId: 2 })).toBe(0);
  });

  it('绑定列表标识主身份源，供客户端只读展示', async () => {
    const service = new ExternalIdentityService(getTestDataSource().manager);
    await service.bind(1, jitProvider, { subject: 'primary-list', username: '10001' });
    await service.bind(2, supplementalProvider, { subject: 'supplemental-list', username: 'ding-user' });

    await expect(service.listBindings(1)).resolves.toEqual([
      expect.objectContaining({ provider: jitProvider, providerLabel: '主身份源', jit: true }),
    ]);
    await expect(service.listBindings(2)).resolves.toEqual([
      expect.objectContaining({ provider: supplementalProvider, providerLabel: '补充身份源', jit: false }),
    ]);
  });
});
