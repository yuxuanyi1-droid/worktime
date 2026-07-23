import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalFlowEngine } from '@server/services/approvalFlowService';
import { PermissionGovernanceService } from '@server/services/permissionGovernanceService';
import { AccessPolicyService } from '@server/services/accessPolicyService';
import { Permission } from '@server/entities/Permission';
import { PermissionRequest } from '@server/entities/PermissionRequest';
import { Project } from '@server/entities/Project';
import { User } from '@server/entities/User';
import { UserPermissionGrant } from '@server/entities/UserPermissionGrant';
import { ApprovalRecord } from '@server/entities/ApprovalRecord';
import { ApprovalTask } from '@server/entities/ApprovalTask';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

vi.mock('@server/services/notifications', () => ({
  NotificationPublisher: class {
    notifyApprovalPending = vi.fn().mockResolvedValue(undefined);
  },
}));

describe('PermissionGovernanceService 集成', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  async function createUser(username: string, status = 1) {
    return getTestDataSource().getRepository(User).save({
      username,
      password: await bcrypt.hash('password-123', 4),
      realName: username,
      status,
      roles: [],
    });
  }

  async function seedPermissionFlow() {
    const dataSource = getTestDataSource();
    const permission = await dataSource.getRepository(Permission).save({
      code: 'project:view:managed',
      name: '项目管理-查看负责项目',
      module: 'project',
      action: 'view:managed',
      grantable: true,
      scopeTypes: ['project'],
    });
    const approver = await createUser('permission-approver');
    await new ApprovalFlowEngine(dataSource.manager).createFlow({
      name: '权限申请默认流程',
      type: 'permission_request',
      isDefault: true,
      steps: [{ stepType: 'custom', label: '权限管理员审批', customApproverId: approver.id }],
    });
    return { permission, approver };
  }

  async function createRequest(applicantId: number, projectId: number) {
    const dataSource = getTestDataSource();
    return dataSource.transaction((manager) => new PermissionGovernanceService(manager).createAndSubmit(applicantId, {
      permissionCode: 'project:view:managed',
      scopeType: 'project',
      scopeId: projectId,
      reason: '负责该项目，需要查看项目详情',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }));
  }

  it('同一范围只允许一条审批中申请，且不允许申请非进行中项目', async () => {
    const dataSource = getTestDataSource();
    await seedPermissionFlow();
    const applicant = await createUser('applicant');
    const [activeProject, suspendedProject] = await dataSource.getRepository(Project).save([
      { name: '进行中项目', code: 'ACTIVE', status: 'active', managers: [] },
      { name: '中止项目', code: 'SUSPENDED', status: 'suspended', managers: [] },
    ]);

    const first = await createRequest(applicant.id, activeProject.id);
    expect(first?.status).toBe('submitted');
    await expect(createRequest(applicant.id, activeProject.id))
      .rejects.toThrow('同一范围已有审批中的权限申请');
    await expect(createRequest(applicant.id, suspendedProject.id))
      .rejects.toThrow('只能申请进行中项目的权限');
    expect(await dataSource.getRepository(PermissionRequest).count()).toBe(1);
  });

  it('审批配置缺失时拒绝提交，不允许自动通过', async () => {
    const dataSource = getTestDataSource();
    await dataSource.getRepository(Permission).save({
      code: 'project:view:managed',
      name: '项目管理-查看负责项目',
      module: 'project',
      action: 'view:managed',
      grantable: true,
      scopeTypes: ['project'],
    });
    const applicant = await createUser('no-flow-applicant');
    const project = await dataSource.getRepository(Project).save({
      name: '缺少流程项目', code: 'NOFLOW', status: 'active', managers: [],
    });

    await expect(createRequest(applicant.id, project.id)).rejects.toThrow('未配置可用的默认审批流程');
    // pg-mem 不实现事务回滚语义；生产 PostgreSQL 的回滚由 createAndSubmit 外层事务保证。
  });

  it('自然过期授权会同步为 expired，并允许重新发起同范围申请', async () => {
    const dataSource = getTestDataSource();
    const { permission } = await seedPermissionFlow();
    const applicant = await createUser('expired-applicant');
    const project = await dataSource.getRepository(Project).save({
      name: '续期项目', code: 'RENEW', status: 'active', managers: [],
    });
    const elapsed = await dataSource.getRepository(UserPermissionGrant).save({
      userId: applicant.id,
      permissionId: permission.id,
      permissionCode: permission.code,
      scopeType: 'project',
      scopeId: project.id,
      scopeName: project.name,
      source: 'request',
      status: 'active',
      startsAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const request = await createRequest(applicant.id, project.id);
    expect(request?.status).toBe('submitted');
    expect((await dataSource.getRepository(UserPermissionGrant).findOneByOrFail({ id: elapsed.id })).status)
      .toBe('expired');
  });

  it('撤销授权必须记录原因，重复撤销会明确报错', async () => {
    const dataSource = getTestDataSource();
    const operator = await createUser('grant-manager');
    const applicant = await createUser('grant-user');
    const grant = await dataSource.getRepository(UserPermissionGrant).save({
      userId: applicant.id,
      permissionCode: 'report:view:all',
      scopeType: 'global',
      scopeId: null,
      scopeName: null,
      source: 'manual',
      status: 'active',
      startsAt: new Date(),
      expiresAt: null,
    });

    await expect(new PermissionGovernanceService(dataSource.manager).revokeGrant(grant.id, operator.id, '  '))
      .rejects.toThrow('请填写撤销原因');
    await dataSource.transaction((manager) => new PermissionGovernanceService(manager)
      .revokeGrant(grant.id, operator.id, '岗位职责调整'));
    const revoked = await dataSource.getRepository(UserPermissionGrant).findOneByOrFail({ id: grant.id });
    expect(revoked).toMatchObject({ status: 'revoked', revokedById: operator.id, revokeReason: '岗位职责调整' });
    await expect(dataSource.transaction((manager) => new PermissionGovernanceService(manager)
      .revokeGrant(grant.id, operator.id, '再次撤销'))).rejects.toThrow('无需重复撤销');
  });

  it('授权状态切换时间会参与认证缓存有效期，停用用户不出现在授权选项中', async () => {
    const dataSource = getTestDataSource();
    const activeUser = await createUser('active-user');
    await createUser('disabled-user', 0);
    const expiresAt = new Date(Date.now() + 30_000);
    await dataSource.getRepository(UserPermissionGrant).save({
      userId: activeUser.id,
      permissionCode: 'report:view:all',
      scopeType: 'global',
      scopeId: null,
      scopeName: null,
      source: 'manual',
      status: 'active',
      startsAt: new Date(Date.now() - 1_000),
      expiresAt,
    });

    const snapshot = await new AccessPolicyService(dataSource.manager)
      .getPermissionSnapshotForLoadedUser(activeUser);
    expect(snapshot.permissions.has('report:view:all')).toBe(true);
    expect(snapshot.refreshAt).toBe(expiresAt.getTime());

    const options = await new PermissionGovernanceService(dataSource.manager).getUserOptions();
    expect(options.map((user) => user.username)).toEqual(['active-user']);
  });

  it('可申请权限目录以代码定义为准，并关联已初始化的数据库 ID', async () => {
    const dataSource = getTestDataSource();
    const permission = await dataSource.getRepository(Permission).save({
      code: 'report:view:project', name: '旧名称', module: 'legacy', action: 'legacy',
      grantable: false, scopeTypes: [],
    });
    const definitions = await new PermissionGovernanceService(dataSource.manager).getGrantableDefinitions();
    const project = definitions.find((item) => item.code === 'report:view:project');
    expect(project).toMatchObject({
      id: permission.id,
      name: '报表中心-查看指定项目报表',
      module: 'report',
      action: 'view:project',
      grantable: true,
      scopeTypes: ['project'],
    });
    expect(definitions.every((item) => item.grantable)).toBe(true);
  });

  it('申请前校验权限可申请性、范围匹配、有效期和申请人状态', async () => {
    const dataSource = getTestDataSource();
    await seedPermissionFlow();
    const applicant = await createUser('invalid-applicant');
    const disabled = await createUser('disabled-applicant', 0);
    const project = await dataSource.getRepository(Project).save({
      name: '进行中项目', code: 'VALIDATION', status: 'active', managers: [],
    });
    const service = new PermissionGovernanceService(dataSource.manager);
    await expect(service.createAndSubmit(applicant.id, {
      permissionCode: 'system:user:manage', scopeType: 'global', reason: '越权申请',
    })).rejects.toThrow('该权限不支持申请开通');
    await expect(service.createAndSubmit(applicant.id, {
      permissionCode: 'project:view:managed', scopeType: 'department', scopeId: 1, reason: '范围错误',
    })).rejects.toThrow('权限范围与申请权限不匹配');
    await expect(service.createAndSubmit(applicant.id, {
      permissionCode: 'project:view:managed', scopeType: 'project', scopeId: project.id,
      reason: '过期申请', expiresAt: new Date(Date.now() - 1_000),
    })).rejects.toThrow('权限有效期必须晚于当前时间');
    await expect(service.createAndSubmit(disabled.id, {
      permissionCode: 'project:view:managed', scopeType: 'project', scopeId: project.id, reason: '停用账号',
    })).rejects.toThrow('申请人不存在或已被禁用');
  });

  it('授权激活写入来源、审批人和有效期，并对同一申请保持幂等', async () => {
    const dataSource = getTestDataSource();
    const { approver } = await seedPermissionFlow();
    const applicant = await createUser('grant-applicant');
    const project = await dataSource.getRepository(Project).save({
      name: '授权项目', code: 'GRANT-ACTIVE', status: 'active', managers: [],
    });
    const request = await createRequest(applicant.id, project.id);
    const service = new PermissionGovernanceService(dataSource.manager);
    const grant = await service.activateGrant(request!.id, request!.approvalInstanceId, {
      id: approver.id, name: approver.realName,
    });
    expect(grant).toMatchObject({
      userId: applicant.id,
      permissionCode: 'project:view:managed',
      scopeType: 'project', scopeId: project.id, source: 'request', status: 'active',
      requestId: request!.id, grantedById: approver.id,
    });
    expect(await dataSource.getRepository(PermissionRequest).findOneByOrFail({ id: request!.id }))
      .toMatchObject({ status: 'approved', currentStep: 0, totalSteps: 0, grantId: grant.id });
    await expect(service.activateGrant(request!.id, request!.approvalInstanceId, {
      id: approver.id, name: approver.realName,
    })).resolves.toMatchObject({ id: grant.id });
    expect(await dataSource.getRepository(UserPermissionGrant).count()).toBe(1);
  });

  it('授权激活拒绝不存在、错误状态、过期或权限目录被删除的申请', async () => {
    const dataSource = getTestDataSource();
    const permission = await dataSource.getRepository(Permission).save({
      code: 'report:view:all', name: '全局报表', module: 'report', action: 'view:all',
      grantable: true, scopeTypes: ['global'],
    });
    const applicant = await createUser('activate-invalid');
    const repo = dataSource.getRepository(PermissionRequest);
    const service = new PermissionGovernanceService(dataSource.manager);
    await expect(service.activateGrant(999, null, null)).rejects.toThrow('权限申请不存在');
    const rejected = await repo.save({
      applicantId: applicant.id, permissionId: permission.id, permissionCode: permission.code,
      permissionName: permission.name, scopeType: 'global', scopeId: null, scopeName: null,
      reason: '被驳回', status: 'rejected', currentStep: 0, totalSteps: 0,
    });
    await expect(service.activateGrant(rejected.id, null, null)).rejects.toThrow('当前权限申请状态不允许授权');
    rejected.status = 'submitted';
    rejected.expiresAt = new Date(Date.now() - 1_000);
    await repo.save(rejected);
    await expect(service.activateGrant(rejected.id, null, null)).rejects.toThrow('有效期已过');
    rejected.expiresAt = null;
    await repo.save(rejected);
    await dataSource.getRepository(Permission).delete(permission.id);
    await expect(service.activateGrant(rejected.id, null, null)).rejects.toThrow('权限已不存在');
  });

  it('撤回权限申请同步关闭任务并保留审批记录', async () => {
    const dataSource = getTestDataSource();
    await seedPermissionFlow();
    const applicant = await createUser('withdraw-applicant');
    const project = await dataSource.getRepository(Project).save({
      name: '撤回项目', code: 'WITHDRAW', status: 'active', managers: [],
    });
    const request = await createRequest(applicant.id, project.id);
    const withdrawn = await new PermissionGovernanceService(dataSource.manager).withdraw(request!.id, applicant.id);
    expect(withdrawn).toMatchObject({ status: 'withdrawn', currentStep: 0 });
    expect(await dataSource.getRepository(ApprovalTask).findOneByOrFail({ targetId: request!.id }))
      .toMatchObject({ status: 'withdrawn' });
    expect(await dataSource.getRepository(ApprovalRecord).findOneByOrFail({
      targetType: 'permission_request', targetId: request!.id, action: 'withdraw',
    })).toMatchObject({ approverId: applicant.id, approverName: applicant.realName });
  });

  it('申请和授权列表使用服务端筛选分页，批量授权查询只返回当前有效项', async () => {
    const dataSource = getTestDataSource();
    const userA = await createUser('list-user-a');
    const userB = await createUser('list-user-b');
    const requestRepo = dataSource.getRepository(PermissionRequest);
    await requestRepo.save([
      {
        applicantId: userA.id, permissionCode: 'report:view:all', permissionName: '全局报表',
        scopeType: 'global', scopeId: null, reason: 'A1', status: 'submitted', currentStep: 1, totalSteps: 1,
      },
      {
        applicantId: userA.id, permissionCode: 'report:view:project', permissionName: '项目报表',
        scopeType: 'project', scopeId: 2, reason: 'A2', status: 'rejected', currentStep: 0, totalSteps: 1,
      },
      {
        applicantId: userB.id, permissionCode: 'report:view:all', permissionName: '全局报表',
        scopeType: 'global', scopeId: null, reason: 'B1', status: 'submitted', currentStep: 1, totalSteps: 1,
      },
    ]);
    const grantRepo = dataSource.getRepository(UserPermissionGrant);
    await grantRepo.save([
      {
        userId: userA.id, permissionCode: 'report:view:all', scopeType: 'global', scopeId: null,
        source: 'manual', status: 'active', startsAt: new Date(Date.now() - 10_000), expiresAt: null,
      },
      {
        userId: userB.id, permissionCode: 'report:view:all', scopeType: 'global', scopeId: null,
        source: 'manual', status: 'active', startsAt: new Date(Date.now() + 60_000), expiresAt: null,
      },
    ]);
    const service = new PermissionGovernanceService(dataSource.manager);
    await expect(service.getRequests({ applicantId: userA.id, status: 'submitted', page: 1, pageSize: 1 }))
      .resolves.toMatchObject({ total: 1, page: 1, pageSize: 1, list: [expect.objectContaining({ reason: 'A1' })] });
    await expect(service.getGrants({ userId: userA.id, status: 'active', page: 1, pageSize: 10 }))
      .resolves.toMatchObject({ total: 1, list: [expect.objectContaining({ userId: userA.id })] });
    const active = await service.getGrantsByUserIds([userA.id, userB.id]);
    expect(active.map((grant) => grant.userId)).toEqual([userA.id]);
    await expect(service.getGrantsByUserIds([])).resolves.toEqual([]);
  });
});
