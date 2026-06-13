import { In, IsNull } from 'typeorm';
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
import { NotificationService } from './notificationService';

export type PermissionRequestPayload = {
  permissionCode: string;
  scopeType: PermissionScopeType;
  scopeId?: number | null;
  reason: string;
  expiresAt?: Date | null;
};

export class PermissionGovernanceService {
  private permissionRepo = AppDataSource.getRepository(Permission);
  private requestRepo = AppDataSource.getRepository(PermissionRequest);
  private recordRepo = AppDataSource.getRepository(ApprovalRecord);
  private grantRepo = AppDataSource.getRepository(UserPermissionGrant);
  private userRepo = AppDataSource.getRepository(User);
  private departmentRepo = AppDataSource.getRepository(Department);
  private groupRepo = AppDataSource.getRepository(Group);
  private projectRepo = AppDataSource.getRepository(Project);
  private approvalInstanceService = new ApprovalInstanceService();
  private notificationService = new NotificationService();

  async getGrantableDefinitions() {
    const definitions = permissionDefinitions.filter((definition) => definition.grantable);
    const permissions = await this.permissionRepo.findBy({ code: In(definitions.map((definition) => definition.code)) });
    const permissionByCode = new Map(permissions.map((permission) => [permission.code, permission]));

    return definitions.map((definition) => {
      const permission = permissionByCode.get(definition.code);
      return {
        id: permission?.id ?? 0,
        code: definition.code,
        name: definition.name,
        module: definition.module,
        action: definition.action,
        grantable: true,
        scopeTypes: definition.scopeTypes ?? [],
      };
    });
  }

  private async resolveScopeName(scopeType: PermissionScopeType, scopeId?: number | null) {
    if (scopeType === 'global' || scopeType === 'self') return null;
    if (!scopeId) throw new Error('请选择权限范围');
    if (scopeType === 'department') {
      const department = await this.departmentRepo.findOneBy({ id: scopeId });
      if (!department) throw new Error('部门不存在');
      return department.name;
    }
    if (scopeType === 'group') {
      const group = await this.groupRepo.findOneBy({ id: scopeId });
      if (!group) throw new Error('组别不存在');
      return group.name;
    }
    if (scopeType === 'project') {
      const project = await this.projectRepo.findOneBy({ id: scopeId });
      if (!project) throw new Error('项目不存在');
      return project.name;
    }
    throw new Error('不支持的权限范围');
  }

  private async normalizePayload(payload: PermissionRequestPayload) {
    const definition = permissionDefinitionMap.get(payload.permissionCode);
    if (!definition || !definition.grantable) throw new Error('该权限不支持申请开通');
    if (definition.scopeTypes?.length && !definition.scopeTypes.includes(payload.scopeType)) {
      throw new Error('权限范围与申请权限不匹配');
    }

    const permission = await this.permissionRepo.findOne({ where: { code: payload.permissionCode } });
    if (!permission) throw new Error('权限码尚未初始化');

    const scopeId = payload.scopeType === 'global' || payload.scopeType === 'self' ? null : payload.scopeId ?? null;
    const scopeName = await this.resolveScopeName(payload.scopeType, scopeId);
    return { definition, permission, scopeId, scopeName };
  }

  async createAndSubmit(applicantId: number, payload: PermissionRequestPayload) {
    const { definition, permission, scopeId, scopeName } = await this.normalizePayload(payload);
    const applicant = await this.userRepo.findOneBy({ id: applicantId });
    if (!applicant) throw new Error('申请人不存在');

    const existingGrant = await this.grantRepo.findOne({
      where: {
        userId: applicantId,
        permissionCode: payload.permissionCode,
        scopeType: payload.scopeType,
        scopeId: scopeId === null ? IsNull() : scopeId,
        status: 'active',
      },
    });
    if (existingGrant) throw new Error('该权限已经开通');

    const request = await this.requestRepo.save(this.requestRepo.create({
      applicantId,
      permissionId: permission.id,
      permissionCode: payload.permissionCode,
      permissionName: definition.name,
      scopeType: payload.scopeType,
      scopeId,
      scopeName,
      reason: payload.reason,
      expiresAt: payload.expiresAt ?? null,
      status: 'submitted',
    }));

    const resolved = await this.approvalInstanceService.start({
      targetType: 'permission_request',
      targetId: request.id,
      applicantId,
    });

    if (resolved.status === 'submitted' && resolved.instance) {
      await this.requestRepo.update(request.id, {
        currentStep: resolved.instance.currentStepOrder || 1,
        approvalFlowId: resolved.instance.flowId,
        approvalInstanceId: resolved.instance.id,
        totalSteps: resolved.instance.totalSteps,
      });
      if (resolved.firstApproverIds.length) {
        await this.notificationService.notifyApprovalPending(
          resolved.firstApproverIds,
          'permission_request',
          request.id,
          applicant.realName,
          `权限申请 ${definition.name}`,
        );
      }
    } else {
      const grant = await this.activateGrant(request.id, null, null);
      await this.requestRepo.update(request.id, {
        status: 'approved',
        currentStep: 0,
        totalSteps: 0,
        approvalInstanceId: resolved.instance?.id ?? null,
        grantId: grant.id,
      });
    }

    return this.getRequestById(request.id);
  }

  async activateGrant(requestId: number, approvalInstanceId: number | null, grantedBy: { id: number; name: string } | null) {
    const request = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!request) throw new Error('权限申请不存在');
    const permission = await this.permissionRepo.findOne({ where: { code: request.permissionCode } });

    let grant = await this.grantRepo.findOne({
      where: {
        userId: request.applicantId,
        permissionCode: request.permissionCode,
        scopeType: request.scopeType,
        scopeId: request.scopeId === null ? IsNull() : request.scopeId,
        status: 'active',
      },
    });

    if (!grant) {
      grant = this.grantRepo.create({
        userId: request.applicantId,
        permissionId: permission?.id ?? null,
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
      grant = await this.grantRepo.save(grant);
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
    const request = await this.requestRepo.findOne({ where: { id: requestId } });
    if (!request) throw new Error('权限申请不存在');
    if (request.applicantId !== applicantId) throw new Error('只能撤回自己的权限申请');
    if (request.status !== 'submitted') throw new Error('仅审批中的申请可以撤回');
    const applicant = await this.userRepo.findOneBy({ id: applicantId });
    const instance = await this.approvalInstanceService.withdraw('permission_request', requestId, applicantId, applicant?.realName || '');
    await this.recordRepo.save(this.recordRepo.create({
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
    await this.requestRepo.save(request);
    return request;
  }

  async revokeGrant(grantId: number, operatorId: number, reason?: string) {
    const grant = await this.grantRepo.findOne({ where: { id: grantId } });
    if (!grant) throw new Error('授权记录不存在');
    if (grant.status !== 'active') return grant;
    grant.status = 'revoked';
    grant.revokedAt = new Date();
    grant.revokedById = operatorId;
    grant.revokeReason = reason || null;
    return this.grantRepo.save(grant);
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
    return this.grantRepo.find({
      where: { userId: In(userIds), status: 'active' },
      order: { updatedAt: 'DESC' },
    });
  }

  async getUserOptions() {
    const users = await this.userRepo.find({
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
