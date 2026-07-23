import { EntityManager, In, IsNull, LessThanOrEqual } from 'typeorm';
import { BusinessError } from '../utils/errors';
import { AppDataSource } from '../config/database';
import { permissionDefinitionMap, permissionDefinitions } from '../config/permissionDefinitions';
import { Department } from '../entities/Department';
import { Group } from '../entities/Group';
import { Permission } from '../entities/Permission';
import { ApprovalRecord } from '../entities/ApprovalRecord';
import { PermissionRequest } from '../entities/PermissionRequest';
import { Project } from '../entities/Project';
import { User } from '../entities/User';
import { PermissionScopeType, UserPermissionGrant } from '../entities/UserPermissionGrant';
import { ApprovalInstanceService } from './approvalInstanceService';
import { NotificationPublisher } from './notifications';
import { invalidateAuthUser, invalidateAuthUsers } from '../config/cache';

export type PermissionRequestPayload = {
  permissionCode: string;
  scopeType: PermissionScopeType;
  scopeId?: number | null;
  reason: string;
  expiresAt?: Date | null;
};

export class PermissionGovernanceService {
  constructor(private manager?: EntityManager) {}

  private transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.manager ? work(this.manager) : AppDataSource.transaction(work);
  }

  private get permissionRepo() { return (this.manager ?? AppDataSource).getRepository(Permission); }
  private get requestRepo() { return (this.manager ?? AppDataSource).getRepository(PermissionRequest); }
  private get recordRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalRecord); }
  private get grantRepo() { return (this.manager ?? AppDataSource).getRepository(UserPermissionGrant); }
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }
  private get departmentRepo() { return (this.manager ?? AppDataSource).getRepository(Department); }
  private get groupRepo() { return (this.manager ?? AppDataSource).getRepository(Group); }
  private get projectRepo() { return (this.manager ?? AppDataSource).getRepository(Project); }
  private get approvalInstanceService() { return new ApprovalInstanceService(this.manager); }

  async getGrantableDefinitions() {
    const definitions = permissionDefinitions.filter((definition) => definition.grantable);
    const permissions = await this.permissionRepo.findBy({ code: In(definitions.map((definition) => definition.code)) });
    const permissionByCode = new Map(permissions.map((permission) => [permission.code, permission]));

    return definitions.map((definition) => {
      const permission = permissionByCode.get(definition.code);
      return {
        id: permission?.id ?? 0,
        code: definition.code,
        name: definition.requestName || definition.name,
        description: definition.description,
        module: definition.module,
        action: definition.action,
        grantable: true,
        scopeTypes: definition.scopeTypes ?? [],
      };
    });
  }

  private async resolveScopeName(scopeType: PermissionScopeType, scopeId?: number | null) {
    if (scopeType === 'global' || scopeType === 'self') return null;
    if (!scopeId) throw new BusinessError('请选择权限范围');
    if (scopeType === 'department') {
      const department = await this.departmentRepo.findOneBy({ id: scopeId });
      if (!department) throw new BusinessError('部门不存在');
      return department.name;
    }
    if (scopeType === 'group') {
      const group = await this.groupRepo.findOneBy({ id: scopeId });
      if (!group) throw new BusinessError('组别不存在');
      return group.name;
    }
    if (scopeType === 'project') {
      const project = await this.projectRepo.findOneBy({ id: scopeId });
      if (!project) throw new BusinessError('项目不存在');
      if (project.status !== 'active') throw new BusinessError('只能申请进行中项目的权限');
      return project.name;
    }
    throw new BusinessError('不支持的权限范围');
  }

  private async normalizePayload(payload: PermissionRequestPayload) {
    const definition = permissionDefinitionMap.get(payload.permissionCode);
    if (!definition || !definition.grantable) throw new BusinessError('该权限不支持申请开通');
    if (!definition.scopeTypes?.length || !definition.scopeTypes.includes(payload.scopeType)) {
      throw new BusinessError('权限范围与申请权限不匹配');
    }

    if (payload.expiresAt && payload.expiresAt.getTime() <= Date.now()) {
      throw new BusinessError('权限有效期必须晚于当前时间');
    }

    const permission = await this.permissionRepo.findOne({ where: { code: payload.permissionCode } });
    if (!permission) throw new BusinessError('权限码尚未初始化');

    const scopeId = payload.scopeType === 'global' || payload.scopeType === 'self' ? null : payload.scopeId ?? null;
    const scopeName = await this.resolveScopeName(payload.scopeType, scopeId);
    return { definition, permission, scopeId, scopeName };
  }

  /**
   * 把已经超过有效期、但仍保留 active 状态的历史授权转为 expired。
   * 权限判断本身仍会实时检查 expiresAt；这里用于保证管理列表与唯一约束状态一致。
   */
  private async expireElapsedGrants(userIds?: number[]): Promise<number[]> {
    const where: any = {
      status: 'active',
      expiresAt: LessThanOrEqual(new Date()),
    };
    if (userIds?.length) where.userId = In(userIds);

    const elapsed = await this.grantRepo.find({ where, select: ['id', 'userId'] });
    if (!elapsed.length) return [];
    await this.grantRepo.update(
      { id: In(elapsed.map((grant) => grant.id)) },
      { status: 'expired' },
    );
    return [...new Set(elapsed.map((grant) => grant.userId))];
  }

  private isUniqueViolation(error: unknown, constraint: string): boolean {
    const candidate = error as { driverError?: { code?: string; constraint?: string }; code?: string; constraint?: string };
    const code = candidate.driverError?.code ?? candidate.code;
    const name = candidate.driverError?.constraint ?? candidate.constraint;
    return code === '23505' && name === constraint;
  }

  async createAndSubmit(applicantId: number, payload: PermissionRequestPayload) {
    type PendingNotify = { approverIds: number[]; targetType: string; targetId: number; applicantName: string; title: string };
    const notifications: PendingNotify[] = [];
    let requestId: number;

    try {
      await this.transaction(async (manager) => {
        const txService = new PermissionGovernanceService(manager);
        const { definition, permission, scopeId, scopeName } = await txService.normalizePayload(payload);
        const applicant = await txService.userRepo.findOneBy({ id: applicantId });
        if (!applicant || applicant.status !== 1) throw new BusinessError('申请人不存在或已被禁用');

        await txService.expireElapsedGrants([applicantId]);

        const grantScope = {
          userId: applicantId,
          permissionCode: payload.permissionCode,
          scopeType: payload.scopeType,
          scopeId: scopeId === null ? IsNull() : scopeId,
        };
        const existingGrant = await txService.grantRepo.findOne({
          where: { ...grantScope, status: 'active' },
        });
        if (existingGrant) throw new BusinessError('该范围的权限已经开通');

        const existingRequest = await txService.requestRepo.findOne({
          where: {
            applicantId,
            permissionCode: payload.permissionCode,
            scopeType: payload.scopeType,
            scopeId: scopeId === null ? IsNull() : scopeId,
            status: 'submitted',
          },
        });
        if (existingRequest) throw new BusinessError('同一范围已有审批中的权限申请，请勿重复提交');

        const request = await txService.requestRepo.save(txService.requestRepo.create({
          applicantId,
          permissionId: permission.id,
          permissionCode: payload.permissionCode,
          permissionName: definition.requestName || definition.name,
          scopeType: payload.scopeType,
          scopeId,
          scopeName,
          reason: payload.reason,
          expiresAt: payload.expiresAt ?? null,
          status: 'submitted',
        }));
        requestId = request.id;

        const resolved = await txService.approvalInstanceService.start({
          targetType: 'permission_request',
          targetId: request.id,
          applicantId,
        });

        if (resolved.status === 'submitted' && resolved.instance) {
          await txService.requestRepo.update(request.id, {
            currentStep: resolved.instance.currentStepOrder || 1,
            approvalFlowId: resolved.instance.flowId,
            approvalInstanceId: resolved.instance.id,
            totalSteps: resolved.instance.totalSteps,
          });
          if (resolved.firstApproverIds.length) {
            notifications.push({
              approverIds: resolved.firstApproverIds,
              targetType: 'permission_request',
              targetId: request.id,
              applicantName: applicant.realName,
              title: `权限申请 ${definition.requestName || definition.name}`,
            });
          }
        } else {
          // 保留 SDK 返回类型兼容；当前审批实例服务不允许无流程自动通过。
          const grant = await txService.activateGrant(request.id, null, null);
          await txService.requestRepo.update(request.id, {
            status: 'approved',
            currentStep: 0,
            totalSteps: 0,
            approvalInstanceId: resolved.instance?.id ?? null,
            grantId: grant.id,
          });
        }
      });
    } catch (error) {
      if (this.isUniqueViolation(error, 'uq_permission_requests_submitted_scope')) {
        throw new BusinessError('同一范围已有审批中的权限申请，请勿重复提交');
      }
      throw error;
    }

    await invalidateAuthUser(applicantId);

    const notifier = new NotificationPublisher();
    for (const n of notifications) {
      try { await notifier.notifyApprovalPending(n.approverIds, n.targetType, n.targetId, n.applicantName, n.title); } catch {}
    }

    return this.getRequestById(requestId!);
  }

  async activateGrant(requestId: number, approvalInstanceId: number | null, grantedBy: { id: number; name: string } | null) {
    const request = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!request) throw new BusinessError('权限申请不存在');
    if (request.status !== 'submitted' && request.status !== 'approved') {
      throw new BusinessError('当前权限申请状态不允许授权');
    }
    if (request.expiresAt && request.expiresAt.getTime() <= Date.now()) {
      throw new BusinessError('权限申请的有效期已过，请驳回后重新申请');
    }
    const permission = await this.permissionRepo.findOne({ where: { code: request.permissionCode } });
    if (!permission) throw new BusinessError('申请对应的权限已不存在');

    await this.expireElapsedGrants([request.applicantId]);

    let grant = await this.grantRepo.findOne({
      where: {
        userId: request.applicantId,
        permissionCode: request.permissionCode,
        scopeType: request.scopeType,
        scopeId: request.scopeId === null ? IsNull() : request.scopeId,
        status: 'active',
      },
    });

    if (grant && grant.requestId !== request.id) {
      throw new BusinessError('该范围的权限已通过其他申请开通');
    }

    if (!grant) {
      grant = this.grantRepo.create({
        userId: request.applicantId,
        permissionId: permission.id,
        permissionCode: request.permissionCode,
        scopeType: request.scopeType,
        scopeId: request.scopeId,
        scopeName: request.scopeName,
        source: 'request',
        status: 'active',
        startsAt: new Date(),
        expiresAt: request.expiresAt,
        approvalInstanceId,
        requestId: request.id,
        grantedById: grantedBy?.id ?? null,
        grantedByName: grantedBy?.name ?? null,
        reason: request.reason,
      });
      try {
        grant = await this.grantRepo.save(grant);
      } catch (error) {
        if (this.isUniqueViolation(error, 'uq_user_permission_grants_active_scope')) {
          throw new BusinessError('该范围的权限已通过其他申请开通');
        }
        throw error;
      }
    }

    request.status = 'approved';
    request.grantId = grant.id;
    request.currentStep = 0;
    request.totalSteps = 0;
    request.approvalInstanceId = approvalInstanceId ?? request.approvalInstanceId;
    await this.requestRepo.save(request);
    return grant;
  }

  async markRejected(requestId: number) {
    await this.requestRepo.update(requestId, { status: 'rejected', currentStep: 0 });
  }

  async markSubmitted(requestId: number, currentStep: number) {
    await this.requestRepo.update(requestId, { status: 'submitted', currentStep });
  }

  async withdraw(requestId: number, applicantId: number) {
    return this.transaction(async (manager) => {
      const txService = new PermissionGovernanceService(manager);
      const request = await txService.requestRepo.findOne({ where: { id: requestId } });
      if (!request) throw new BusinessError('权限申请不存在');
      if (request.applicantId !== applicantId) throw new BusinessError('只能撤回自己的权限申请');
      if (request.status !== 'submitted') throw new BusinessError('仅审批中的申请可以撤回');
      const applicant = await txService.userRepo.findOneBy({ id: applicantId });
      const instance = await txService.approvalInstanceService.withdraw('permission_request', requestId, applicantId, applicant?.realName || '');
      await txService.recordRepo.save(txService.recordRepo.create({
        targetType: 'permission_request',
        targetId: requestId,
        instanceId: instance?.id ?? request.approvalInstanceId ?? null,
        taskId: null,
        approverId: applicantId,
        approverName: applicant?.realName || '',
        action: 'withdraw',
        comment: '申请人撤回审批',
        stepOrder: request.currentStep || 1,
        stepType: 'withdraw',
        stepLabel: '撤回',
      }));
      request.status = 'withdrawn';
      request.currentStep = 0;
      await txService.requestRepo.save(request);
      return request;
    });
  }

  async revokeGrant(grantId: number, operatorId: number, reason?: string) {
    const normalizedReason = reason?.trim();
    if (!normalizedReason) throw new BusinessError('请填写撤销原因');

    let affectedUserId = 0;
    const result = await this.transaction(async (manager) => {
      const txService = new PermissionGovernanceService(manager);
      const operator = await txService.userRepo.findOneBy({ id: operatorId, status: 1 });
      if (!operator) throw new BusinessError('操作人不存在或已被禁用');
      const grant = await txService.grantRepo.findOne({ where: { id: grantId } });
      if (!grant) throw new BusinessError('授权记录不存在');
      if (grant.status !== 'active') throw new BusinessError('该授权已失效，无需重复撤销');
      affectedUserId = grant.userId;
      grant.status = 'revoked';
      grant.revokedAt = new Date();
      grant.revokedById = operatorId;
      grant.revokeReason = normalizedReason;
      return txService.grantRepo.save(grant);
    });
    if (!this.manager && affectedUserId) await invalidateAuthUser(affectedUserId);
    return result;
  }

  async getRequestById(id: number) {
    return this.requestRepo.findOne({
      where: { id },
      relations: ['applicant'],
    });
  }

  async getRequests(params: { applicantId?: number; status?: string; page?: number; pageSize?: number }) {
    const { applicantId, status, page = 1, pageSize = 20 } = params;
    const where: any = {};
    if (applicantId) where.applicantId = applicantId;
    if (status) where.status = status;
    const [list, total] = await this.requestRepo.findAndCount({
      where,
      relations: ['applicant'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { list, total, page, pageSize };
  }

  async getGrants(params: { userId?: number; status?: string; page?: number; pageSize?: number }) {
    const { userId, status = 'active', page = 1, pageSize = 20 } = params;
    const where: any = {};
    if (userId) where.userId = userId;
    if (status) where.status = status;
    const expiredUserIds = await this.expireElapsedGrants(userId ? [userId] : undefined);
    if (!this.manager) await invalidateAuthUsers(expiredUserIds);

    const [list, total] = await this.grantRepo.findAndCount({
      where,
      relations: ['user'],
      order: { updatedAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { list, total, page, pageSize };
  }

  async getGrantsByUserIds(userIds: number[]) {
    if (!userIds.length) return [];
    const expiredUserIds = await this.expireElapsedGrants(userIds);
    if (!this.manager) await invalidateAuthUsers(expiredUserIds);
    return this.grantRepo.createQueryBuilder('grant')
      .where('grant.userId IN (:...userIds)', { userIds })
      .andWhere('grant.status = :status', { status: 'active' })
      .andWhere('(grant.startsAt IS NULL OR grant.startsAt <= :now)', { now: new Date() })
      .andWhere('(grant.expiresAt IS NULL OR grant.expiresAt > :now)', { now: new Date() })
      .orderBy('grant.updatedAt', 'DESC')
      .getMany();
  }

  async getUserOptions() {
    const users = await this.userRepo.find({
      where: { status: 1 },
      relations: ['department'],
      order: { realName: 'ASC' },
    });
    return users.map((user) => ({
      id: user.id,
      username: user.username,
      realName: user.realName,
      department: user.department?.name || null,
    }));
  }
}
