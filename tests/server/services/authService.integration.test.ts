import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authConfig, oidcConfig } from '@server/config/auth';
import { Department } from '@server/entities/Department';
import { Group } from '@server/entities/Group';
import { Role } from '@server/entities/Role';
import { User } from '@server/entities/User';
import { UserExternalIdentity } from '@server/entities/UserExternalIdentity';
import { AuthService } from '@server/services/authService';
import { BusinessError } from '@server/utils/errors';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

describe('AuthService 集成', () => {
  beforeEach(async () => {
    const dataSource = await setupTestDb();
    await dataSource.getRepository(Role).save({
      name: 'employee', label: '员工', description: '默认角色', isSystem: true,
    });
    await dataSource.getRepository(User).save({
      id: 1,
      username: 'auth-user',
      password: await bcrypt.hash('old-password', 4),
      realName: '认证用户',
      status: 1,
    });
  });

  afterEach(teardownTestDb);

  it('改密后递增 tokenVersion，并拒绝错误原密码', async () => {
    const dataSource = getTestDataSource();
    const service = new AuthService(dataSource.manager);

    await expect(service.changePassword(1, 'wrong-password', 'new-password')).rejects.toBeInstanceOf(BusinessError);
    await service.changePassword(1, 'old-password', 'new-password');

    const user = await dataSource.getRepository(User).findOneByOrFail({ id: 1 });
    expect(user.tokenVersion).toBe(1);
    expect(await bcrypt.compare('new-password', user.password)).toBe(true);
  });

  it('AI 访问令牌带有独立 purpose 和短期有效期', async () => {
    const token = await new AuthService(getTestDataSource().manager).issueAgentAccessToken(1);
    const payload = jwt.verify(token, authConfig.jwtSecret) as jwt.JwtPayload;
    expect(payload).toMatchObject({ id: 1, purpose: 'agent', v: 0 });
    expect((payload.exp || 0) - (payload.iat || 0)).toBe(2 * 60 * 60);
  });

  it('密码登录返回最小化用户档案和权限快照，错误凭据与禁用账号使用同一提示', async () => {
    const dataSource = getTestDataSource();
    const role = await dataSource.getRepository(Role).findOneByOrFail({ name: 'employee' });
    const user = await dataSource.getRepository(User).findOneByOrFail({ id: 1 });
    user.roles = [role];
    await dataSource.getRepository(User).save(user);
    const service = new AuthService(dataSource.manager);

    const result = await service.login('auth-user', 'old-password');
    expect(result.token).toEqual(expect.any(String));
    expect(result.user).toMatchObject({
      id: 1,
      username: 'auth-user',
      realName: '认证用户',
      roles: [expect.objectContaining({ name: 'employee' })],
      idpManaged: false,
    });
    expect(result.user).not.toHaveProperty('password');
    await expect(service.login('auth-user', 'wrong-password')).rejects.toMatchObject({
      message: '用户名或密码错误',
    });
    await expect(service.login('missing-user', 'wrong-password')).rejects.toMatchObject({
      message: '用户名或密码错误',
    });

    user.status = 0;
    await dataSource.getRepository(User).save(user);
    await expect(service.login('auth-user', 'old-password')).rejects.toMatchObject({
      message: '用户名或密码错误',
    });
    await expect(service.issueAgentAccessToken(1)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('个人资料更新和登出只作用于当前用户，并让旧 JWT 版本失效', async () => {
    const dataSource = getTestDataSource();
    const service = new AuthService(dataSource.manager);

    const profile = await service.updateProfile(1, {
      realName: '更新姓名',
      email: 'updated@example.com',
      phone: '+86 138-0000-0000',
    });
    expect(profile).toMatchObject({
      id: 1,
      realName: '更新姓名',
      email: 'updated@example.com',
      phone: '+86 138-0000-0000',
      idpManaged: false,
    });

    await service.logout(1);
    expect((await dataSource.getRepository(User).findOneByOrFail({ id: 1 })).tokenVersion).toBe(1);
    await expect(service.getProfile(999)).rejects.toMatchObject({ message: '用户不存在' });
    await expect(service.logout(999)).rejects.toMatchObject({ message: '用户不存在' });
  });

  it('同名分组严格按部门和父级隔离', async () => {
    const dataSource = getTestDataSource();
    const departmentRepo = dataSource.getRepository(Department);
    const groupRepo = dataSource.getRepository(Group);
    const [departmentA, departmentB] = await departmentRepo.save([
      { name: '部门甲' },
      { name: '部门乙' },
    ]);
    const wrongGroup = await groupRepo.save({
      name: '公共组',
      departmentId: departmentA.id,
      parentId: null,
      level: 0,
      path: '',
    });
    const service = new AuthService(dataSource.manager) as any;

    const placement = await service.resolveOrgPlacement('部门乙/公共组');

    expect(placement.department.id).toBe(departmentB.id);
    expect(placement.group.id).not.toBe(wrongGroup.id);
    expect(placement.group.departmentId).toBe(departmentB.id);
    expect(placement.group.parentId).toBeNull();
  });

  it('IdP 未返回 department claim 时保留原组织归属，明确返回空字符串才清空', async () => {
    const dataSource = getTestDataSource();
    const department = await dataSource.getRepository(Department).save({ name: '保留部门' });
    const group = await dataSource.getRepository(Group).save({
      name: '保留分组', departmentId: department.id, parentId: null, level: 0, path: '1',
    });
    let user = await dataSource.getRepository(User).findOneByOrFail({ id: 1 });
    user.department = department;
    user.group = group;
    await dataSource.getRepository(User).save(user);
    const service = new AuthService(dataSource.manager) as any;

    user = await dataSource.getRepository(User).findOneOrFail({
      where: { id: 1 }, relations: ['department', 'group'],
    });
    await service.syncUserProfile(user, { subject: 'subject-without-department' });
    let stored = await dataSource.getRepository(User).findOneOrFail({
      where: { id: 1 }, relations: ['department', 'group'],
    });
    expect(stored.department?.id).toBe(department.id);
    expect(stored.group?.id).toBe(group.id);

    await service.syncUserProfile(stored, { subject: 'subject-empty-department', department: '' });
    stored = await dataSource.getRepository(User).findOneOrFail({
      where: { id: 1 }, relations: ['department', 'group'],
    });
    expect(stored.department).toBeNull();
    expect(stored.group).toBeNull();
  });

  it('JIT 用户名始终满足长度限制，并为本地同名账号生成稳定冲突后缀', async () => {
    const dataSource = getTestDataSource();
    const providerName = 'test-jit';
    oidcConfig.providers[providerName] = {
      enabled: true,
      label: '测试身份源',
      type: 'oidc',
      jit: true,
    };
    const longUsername = 'a'.repeat(80);
    await dataSource.getRepository(User).save({
      username: longUsername.slice(0, 50), password: 'hash', realName: '本地同名用户', status: 1, roles: [],
    });

    try {
      const provisioned = await (new AuthService(dataSource.manager) as any).provisionUser(providerName, {
        subject: 'stable-subject',
        username: longUsername,
        displayName: 'JIT 用户',
      });
      expect(provisioned.username).toHaveLength(50);
      expect(provisioned.username).not.toBe(longUsername.slice(0, 50));
      expect(provisioned.username).toMatch(/_[a-f0-9]{8}$/);
    } finally {
      delete oidcConfig.providers[providerName];
    }
  });

  it('JIT 首次登录原子创建带默认角色的用户和标准化身份绑定', async () => {
    const dataSource = getTestDataSource();
    const providerName = 'test-jit-login';
    oidcConfig.providers[providerName] = {
      enabled: true, label: '测试主身份源', type: 'oidc', jit: true, defaultRole: 'employee',
    };
    try {
      const result = await new AuthService(dataSource.manager).oidcLogin(providerName, {
        subject: '  subject-1001  ',
        username: '  jit-user  ',
        displayName: '  JIT 用户  ',
        employeeId: '  1001  ',
        department: '研发部/平台组',
      });

      expect(result.user).toMatchObject({
        username: 'jit-user', realName: 'JIT 用户', idpManaged: true,
        roles: [expect.objectContaining({ name: 'employee' })],
        department: expect.objectContaining({ name: '研发部' }),
        group: expect.objectContaining({ name: '平台组' }),
      });
      expect(await dataSource.getRepository(UserExternalIdentity).findOneByOrFail({
        provider: providerName, subject: 'subject-1001',
      })).toMatchObject({ externalUsername: 'jit-user', employeeId: '1001' });
    } finally {
      delete oidcConfig.providers[providerName];
    }
  });

  it('非 JIT 身份源只允许既有绑定登录，并同步外部展示字段但不覆盖本地档案', async () => {
    const dataSource = getTestDataSource();
    const providerName = 'test-supplementary-login';
    oidcConfig.providers[providerName] = {
      enabled: true, label: '补充身份源', type: 'oidc', jit: false,
    };
    const user = await dataSource.getRepository(User).findOneByOrFail({ id: 1 });
    await dataSource.getRepository(UserExternalIdentity).save({
      provider: providerName,
      subject: 'bound-subject',
      externalUsername: 'old-external',
      employeeId: null,
      user,
    });
    try {
      await expect(new AuthService(dataSource.manager).oidcLogin(providerName, {
        subject: 'unbound-subject', username: 'unbound',
      })).rejects.toMatchObject({ statusCode: 401, message: expect.stringContaining('未绑定') });

      const result = await new AuthService(dataSource.manager).oidcLogin(providerName, {
        subject: 'bound-subject',
        username: 'new-external',
        employeeId: 'E1001',
        displayName: '不得覆盖本地姓名',
      });
      expect(result.user.realName).toBe('认证用户');
      expect(result.user.idpManaged).toBe(false);
      expect(await dataSource.getRepository(UserExternalIdentity).findOneByOrFail({
        provider: providerName, subject: 'bound-subject',
      })).toMatchObject({ externalUsername: 'new-external', employeeId: 'E1001' });
    } finally {
      delete oidcConfig.providers[providerName];
    }
  });

  it('第三方绑定命中已禁用用户时拒绝签发本地会话', async () => {
    const dataSource = getTestDataSource();
    const providerName = 'test-disabled-bound-user';
    oidcConfig.providers[providerName] = {
      enabled: true, label: '企业身份源', type: 'oidc', jit: false,
    };
    const user = await dataSource.getRepository(User).findOneByOrFail({ id: 1 });
    user.status = 0;
    await dataSource.getRepository(User).save(user);
    await dataSource.getRepository(UserExternalIdentity).save({
      provider: providerName, subject: 'disabled-subject', user,
    });
    try {
      await expect(new AuthService(dataSource.manager).oidcLogin(providerName, {
        subject: 'disabled-subject',
      })).rejects.toMatchObject({ statusCode: 401, message: expect.stringContaining('禁用') });
    } finally {
      delete oidcConfig.providers[providerName];
    }
  });

  it('JIT 默认角色不存在时拒绝留下无权限孤儿账号', async () => {
    const dataSource = getTestDataSource();
    const providerName = 'test-jit-missing-role';
    oidcConfig.providers[providerName] = {
      enabled: true, label: '错误配置身份源', type: 'oidc', jit: true, defaultRole: 'missing-role',
    };
    try {
      await expect((new AuthService(dataSource.manager) as any).provisionUser(providerName, {
        subject: 'missing-role-subject', username: 'orphan-user',
      })).rejects.toMatchObject({ statusCode: 500, message: expect.stringContaining('默认角色') });
      expect(await dataSource.getRepository(User).countBy({ username: 'orphan-user' })).toBe(0);
    } finally {
      delete oidcConfig.providers[providerName];
    }
  });

  it('主身份源临时关闭后既有账号仍保持只读托管', async () => {
    const dataSource = getTestDataSource();
    const providerName = 'test-disabled-jit';
    oidcConfig.providers[providerName] = {
      enabled: false, label: '已关闭主身份源', type: 'oidc', jit: true,
    };
    await dataSource.getRepository(UserExternalIdentity).save({
      provider: providerName, subject: 'managed-subject', userId: 1,
    });
    const service = new AuthService(dataSource.manager);
    try {
      await expect(service.getProfile(1)).resolves.toMatchObject({ idpManaged: true });
      await expect(service.updateProfile(1, { realName: '绕过修改' }))
        .rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('身份源') });
      await expect(service.changePassword(1, 'old-password', 'new-password'))
        .rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('身份源') });
    } finally {
      delete oidcConfig.providers[providerName];
    }
  });
});
