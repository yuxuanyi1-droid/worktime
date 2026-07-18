import { EntityManager } from 'typeorm';
import { BusinessError } from '../utils/errors';
import { AppDataSource } from '../config/database';
import { ApprovalFlow } from '../entities/ApprovalFlow';
import { ApprovalFlowStep } from '../entities/ApprovalFlowStep';
import { Group } from '../entities/Group';
import { User } from '../entities/User';
import { Project } from '../entities/Project';
import { ProjectSE } from '../entities/ProjectSE';
import { Department } from '../entities/Department';
import {
  ApprovalFlowStepSnapshot,
  ApprovalFlowVersion,
  ApprovalTargetType,
} from '../entities/ApprovalFlowVersion';
import {
  CacheKeys,
  CacheTtl,
  cacheGet,
  cacheSet,
  invalidateAllDefaultFlows,
  invalidateDefaultFlow,
} from '../config/cache';

type ApprovalFlowStepLike = {
  stepOrder: number;
  stepType: ApprovalFlowStep['stepType'];
  label: string;
  parentLevel?: number;
  customApproverId?: number | null;
};

/** 项目审批用投影（managers + module SE），供 resolveApprovers 缓存 */
export type ProjectApprovalCache = {
  managers: { userId: number; userName: string }[];
  moduleSEs: { groupId: number; userId: number; userName: string }[];
};

/** 默认可审批流版本的可序列化快照 */
type CachedFlowVersion = {
  id: number;
  flowId: number | null;
  flowName: string;
  type: ApprovalTargetType;
  version: number;
  description: string | null;
  isDefault: boolean;
  enabled: boolean;
  steps: ApprovalFlowStepSnapshot[];
};

/**
 * 审批流程引擎
 * 负责解析审批流程配置、匹配审批人
 */
export class ApprovalFlowEngine {
  constructor(private manager?: EntityManager) {}

  private get flowRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalFlow); }
  private get stepRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalFlowStep); }
  private get versionRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalFlowVersion); }
  private get groupRepo() { return (this.manager ?? AppDataSource).getRepository(Group); }
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }
  private get projectRepo() { return (this.manager ?? AppDataSource).getRepository(Project); }
  private get projectSERepo() { return (this.manager ?? AppDataSource).getRepository(ProjectSE); }
  private get deptRepo() { return (this.manager ?? AppDataSource).getRepository(Department); }

  /**
   * 获取某类型的默认审批流程
   */
  async getDefaultFlow(type: ApprovalTargetType): Promise<(ApprovalFlow & { steps: ApprovalFlowStep[] }) | null> {
    const flow = await this.flowRepo.findOne({
      where: { type, isDefault: true, enabled: true },
      relations: ['steps'],
    });
    if (!flow) return null;
    // 按步骤顺序排列
    flow.steps.sort((a, b) => a.stepOrder - b.stepOrder);
    return flow as any;
  }

  /** 加载项目审批配置（managers + SE），带 Redis 缓存 */
  async getProjectApprovalConfig(projectId: number): Promise<ProjectApprovalCache> {
    const cacheKey = CacheKeys.projectApproval(projectId);
    const cached = await cacheGet<ProjectApprovalCache>(cacheKey);
    if (cached) return cached;

    const project = await this.projectRepo.findOne({
      where: { id: projectId },
      relations: ['managers'],
    });
    const ses = await this.projectSERepo.find({
      where: { projectId },
      relations: ['user'],
    });
    const data: ProjectApprovalCache = {
      managers: (project?.managers || []).map((m) => ({ userId: m.id, userName: m.realName })),
      moduleSEs: ses
        .filter((se) => se.user)
        .map((se) => ({ groupId: se.groupId, userId: se.user.id, userName: se.user.realName })),
    };
    await cacheSet(cacheKey, data, CacheTtl.project);
    return data;
  }

  /**
   * 解析审批步骤的实际审批人（支持多人）
   * @returns 审批人列表，空数组表示该步骤不适用（跳过）
   */
  async resolveApprovers(
    step: ApprovalFlowStepLike,
    applicantId: number,
    projectId?: number,
  ): Promise<{ userId: number; userName: string }[]> {
    const applicant = await this.userRepo.findOne({
      where: { id: applicantId },
      relations: ['group', 'department'],
    });
    if (!applicant) return [];

    switch (step.stepType) {
      case 'group_leader': {
        // 直属组长
        const group = applicant.group;
        if (!group) return [];
        const freshGroup = await this.groupRepo.findOne({
          where: { id: group.id },
          relations: ['leader'],
        });
        if (!freshGroup?.leader) return [];
        return [{ userId: freshGroup.leader.id, userName: freshGroup.leader.realName }];
      }

      case 'parent_leader': {
        // 上级组长（向上查找 N 级）
        const level = Math.min(step.parentLevel || 1, 5); // 硬上限 5 级，防止配置错误导致过多查询
        let currentGroup = applicant.group;
        const visited = new Set<number>(); // 环检测：记录已访问的 groupId
        for (let i = 0; i < level; i++) {
          if (!currentGroup) return [];
          if (visited.has(currentGroup.id)) return []; // 检测到循环引用，终止
          visited.add(currentGroup.id);
          const fresh = await this.groupRepo.findOne({
            where: { id: currentGroup.id },
            relations: ['parent', 'leader'],
          });
          if (!fresh?.parent) {
            // 到顶了（当前组即顶级组）：用顶级组负责人兜底，避免顶级组成员无人审批而自动通过。
            // 若顶级组也无负责人，才返回空（仍由上层 start 逻辑判定跳过/自动通过）。
            // 注：若兜底的审批人恰为申请人自己，会被 start 的自排逻辑（approvalInstanceService）排除。
            if (!fresh?.leader) return [];
            return [{ userId: fresh.leader.id, userName: fresh.leader.realName }];
          }
          currentGroup = fresh.parent;
        }
        const targetGroup = await this.groupRepo.findOne({
          where: { id: currentGroup!.id },
          relations: ['leader'],
        });
        if (!targetGroup?.leader) return [];
        return [{ userId: targetGroup.leader.id, userName: targetGroup.leader.realName }];
      }

      case 'dept_leader': {
        // 部门负责人
        const dept = await this.deptRepo.findOne({
          where: { id: applicant.department?.id ?? 0 },
          relations: ['leader'],
        });
        if (!dept?.leader) return [];
        return [{ userId: dept.leader.id, userName: dept.leader.realName }];
      }

      case 'module_se': {
        // 项目模块SE：匹配用户所在组绑定的SE（可能多个）
        if (!projectId) return [];
        if (!applicant.group) return [];

        const projectCfg = await this.getProjectApprovalConfig(projectId);
        // 沿组层级向上查找匹配的SE
        let searchGroupId: number | null = applicant.group.id;
        while (searchGroupId) {
          const validSes = projectCfg.moduleSEs
            .filter((se) => se.groupId === searchGroupId)
            .map((se) => ({ userId: se.userId, userName: se.userName }));
          if (validSes.length > 0) return validSes;

          // 向上一级组查找
          const parentGroup = await this.groupRepo.findOne({
            where: { id: searchGroupId },
            relations: ['parent'],
          });
          searchGroupId = parentGroup?.parent?.id ?? null;
        }
        return [];
      }

      case 'project_manager': {
        // 项目管理员（所有管理员）
        if (!projectId) return [];
        const projectCfg = await this.getProjectApprovalConfig(projectId);
        return projectCfg.managers.map((m) => ({ userId: m.userId, userName: m.userName }));
      }

      case 'custom': {
        // 自定义审批人
        if (!step.customApproverId) return [];
        const user = await this.userRepo.findOne({ where: { id: step.customApproverId } });
        if (!user) return [];
        return [{ userId: user.id, userName: user.realName }];
      }

      default:
        return [];
    }
  }

  /**
   * 初始化审批流程：解析所有步骤并返回有效步骤列表
   * 审批人包含申请人自己时自动排除；若排除后该步骤无审批人则跳过（自动通过）
   */
  async resolveFlow(
    type: ApprovalTargetType,
    applicantId: number,
    projectId?: number,
  ): Promise<{
    flowId: number;
    steps: { stepOrder: number; stepType: string; stepLabel: string; approverIds: number[]; approverNames: string[] }[];
  } | null> {
    const flow = await this.getDefaultFlow(type);
    if (!flow || !flow.steps.length) return null;

    const resolvedSteps: any[] = [];
    for (const step of flow.steps) {
      const approvers = await this.resolveApprovers(step, applicantId, projectId);
      // 过滤掉申请人自己
      const filtered = approvers.filter(a => a.userId !== applicantId);
      if (filtered.length > 0) {
        resolvedSteps.push({
          stepOrder: step.stepOrder,
          stepType: step.stepType,
          stepLabel: step.label,
          approverIds: filtered.map(a => a.userId),
          approverNames: filtered.map(a => a.userName),
        });
      }
      // 过滤后为空则跳过该步骤（自动通过）
    }

    if (!resolvedSteps.length) return null;
    return { flowId: flow.id, steps: resolvedSteps };
  }

  // ==================== CRUD ====================

  async getFlows(type?: string) {
    const where: any = {};
    if (type) where.type = type;
    return this.flowRepo.find({ where, relations: ['steps'], order: { id: 'ASC' } });
  }

  async getFlow(id: number) {
    const flow = await this.flowRepo.findOne({ where: { id }, relations: ['steps'] });
    if (flow?.steps) flow.steps.sort((a, b) => a.stepOrder - b.stepOrder);
    return flow;
  }

  private toStepSnapshot(step: ApprovalFlowStep): ApprovalFlowStepSnapshot {
    return {
      stepOrder: step.stepOrder,
      stepType: step.stepType,
      label: step.label,
      parentLevel: step.parentLevel || 1,
      customApproverId: step.customApproverId ?? null,
      requireAllApprovers: step.requireAllApprovers ?? false,
    };
  }

  async createFlowVersion(flowId: number) {
    const flow = await this.getFlow(flowId);
    if (!flow) throw new BusinessError('Approval flow not found');

    const lastVersion = await this.versionRepo.findOne({
      where: { flowId },
      order: { version: 'DESC' },
    });
    const version = (lastVersion?.version || 0) + 1;

    return this.versionRepo.save(this.versionRepo.create({
      flowId: flow.id,
      flowName: flow.name,
      type: flow.type,
      version,
      description: flow.description ?? null,
      isDefault: flow.isDefault,
      enabled: flow.enabled,
      steps: (flow.steps || []).map(step => this.toStepSnapshot(step)),
    }));
  }

  async getDefaultFlowVersion(type: ApprovalTargetType) {
    const cacheKey = CacheKeys.defaultFlow(type);
    const cached = await cacheGet<CachedFlowVersion>(cacheKey);
    if (cached) {
      // 还原为 ApprovalFlowVersion 形状（下游只读字段）
      return cached as unknown as ApprovalFlowVersion;
    }

    const flow = await this.getDefaultFlow(type);
    if (!flow) return null;

    let version = await this.versionRepo.findOne({
      where: { flowId: flow.id, enabled: true },
      order: { version: 'DESC' },
    });
    if (!version) {
      version = await this.createFlowVersion(flow.id);
    }

    const snap: CachedFlowVersion = {
      id: version.id,
      flowId: version.flowId,
      flowName: version.flowName,
      type: version.type,
      version: version.version,
      description: version.description,
      isDefault: version.isDefault,
      enabled: version.enabled,
      steps: version.steps,
    };
    await cacheSet(cacheKey, snap, CacheTtl.approvalFlow);
    return version;
  }

  async createFlow(data: { name: string; type: string; description?: string; isDefault?: boolean; enabled?: boolean; steps: any[] }) {
    // 如果设为默认，取消同类型其他默认
    if (data.isDefault) {
      await this.flowRepo.update({ type: data.type as any, isDefault: true }, { isDefault: false });
    }

    const flow = this.flowRepo.create({
      name: data.name,
      type: data.type as any,
      description: data.description,
      isDefault: data.isDefault ?? false,
      enabled: data.enabled ?? true,
      steps: data.steps.map((s: any, i: number) => this.stepRepo.create({
        stepOrder: i + 1,
        stepType: s.stepType,
        label: s.label,
        parentLevel: s.parentLevel || 1,
        customApproverId: s.customApproverId || null,
        requireAllApprovers: s.requireAllApprovers ?? false,
      })),
    });
    const saved = await this.flowRepo.save(flow);
    await this.createFlowVersion(saved.id);
    await invalidateDefaultFlow(data.type);
    return this.getFlow(saved.id);
  }

  async updateFlow(id: number, data: { name?: string; description?: string; isDefault?: boolean; enabled?: boolean; steps?: any[] }) {
    const flow = await this.flowRepo.findOne({ where: { id }, relations: ['steps'] });
    if (!flow) throw new BusinessError('审批流程不存在');

    if (data.isDefault) {
      await this.flowRepo.update({ type: flow.type, isDefault: true }, { isDefault: false });
    }

    if (data.name !== undefined) flow.name = data.name;
    if (data.description !== undefined) flow.description = data.description;
    if (data.isDefault !== undefined) flow.isDefault = data.isDefault;
    if (data.enabled !== undefined) flow.enabled = data.enabled;

    if (data.steps) {
      // 删除旧步骤，创建新步骤
      await this.stepRepo.delete({ flowId: id });
      flow.steps = data.steps.map((s: any, i: number) => this.stepRepo.create({
        stepOrder: i + 1,
        stepType: s.stepType,
        label: s.label,
        parentLevel: s.parentLevel || 1,
        customApproverId: s.customApproverId || null,
        requireAllApprovers: s.requireAllApprovers ?? false,
        flowId: id,
      }));
    }

    const saved = await this.flowRepo.save(flow);
    await this.createFlowVersion(saved.id);
    await invalidateDefaultFlow(flow.type);
    return this.getFlow(saved.id);
  }

  async deleteFlow(id: number) {
    const flow = await this.flowRepo.findOne({ where: { id } });
    await this.stepRepo.delete({ flowId: id });
    const result = await this.flowRepo.delete(id);
    if (flow) await invalidateDefaultFlow(flow.type);
    else await invalidateAllDefaultFlows();
    return result;
  }
}
