import { EntityManager, In, MoreThan } from 'typeorm';
import { BusinessError } from '../utils/errors';
import { AppDataSource } from '../config/database';
import { ApprovalInstance, ApprovalInstanceStepSnapshot } from '../entities/ApprovalInstance';
import { ApprovalTask } from '../entities/ApprovalTask';
import { ApprovalTargetType } from '../entities/ApprovalFlowVersion';
import { ApprovalFlowEngine } from './approvalFlowService';

export class ApprovalInstanceService {
  constructor(private manager?: EntityManager) {}

  private get instanceRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalInstance); }
  private get taskRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalTask); }
  private get flowEngine() { return new ApprovalFlowEngine(this.manager); }

  async start(params: {
    targetType: ApprovalTargetType;
    targetId: number;
    applicantId: number;
    projectId?: number | null;
  }) {
    const version = await this.flowEngine.getDefaultFlowVersion(params.targetType);
    const now = new Date();

    if (!version || !version.steps?.length) {
      return { status: 'approved' as const, instance: null, firstApproverIds: [] as number[] };
    }

    const steps: ApprovalInstanceStepSnapshot[] = [];
    for (const sourceStep of [...version.steps].sort((a, b) => a.stepOrder - b.stepOrder)) {
      const approvers = await this.flowEngine.resolveApprovers(sourceStep, params.applicantId, params.projectId ?? undefined);
      const uniqueApprovers = new Map<number, string>();

      for (const approver of approvers) {
        if (approver.userId !== params.applicantId) {
          uniqueApprovers.set(approver.userId, approver.userName);
        }
      }

      if (uniqueApprovers.size > 0) {
        steps.push({
          stepOrder: steps.length + 1,
          sourceStepOrder: sourceStep.stepOrder,
          stepType: sourceStep.stepType,
          label: sourceStep.label,
          approvers: Array.from(uniqueApprovers.entries()).map(([id, name]) => ({ id, name })),
        });
      }
    }

    const instance = await this.instanceRepo.save(this.instanceRepo.create({
      targetType: params.targetType,
      targetId: params.targetId,
      applicantId: params.applicantId,
      status: steps.length ? 'pending' : 'approved',
      currentStepOrder: steps.length ? 1 : null,
      totalSteps: steps.length,
      flowId: version.flowId,
      flowVersionId: version.id,
      flowName: version.flowName,
      flowVersionNumber: version.version,
      stepsSnapshot: steps,
      submittedAt: now,
      finishedAt: steps.length ? null : now,
    }));

    if (!steps.length) {
      return { status: 'approved' as const, instance, firstApproverIds: [] as number[] };
    }

    const tasks = steps.flatMap(step => step.approvers.map(approver => this.taskRepo.create({
      instanceId: instance.id,
      targetType: params.targetType,
      targetId: params.targetId,
      stepOrder: step.stepOrder,
      sourceStepOrder: step.sourceStepOrder,
      stepType: step.stepType,
      stepLabel: step.label,
      approverId: approver.id,
      approverName: approver.name,
      status: step.stepOrder === 1 ? 'pending' : 'waiting',
    })));
    await this.taskRepo.save(tasks);

    return {
      status: 'submitted' as const,
      instance,
      firstApproverIds: steps[0].approvers.map(approver => approver.id),
    };
  }

  async getLatestInstance(targetType: string, targetId: number) {
    return this.instanceRepo.findOne({
      where: { targetType: targetType as ApprovalTargetType, targetId },
      relations: ['tasks'],
      order: { id: 'DESC' },
    });
  }

  async getInstanceById(id: number) {
    return this.instanceRepo.findOne({
      where: { id },
      relations: ['tasks'],
    });
  }

  /** 批量按 id 查询实例（避免 N+1）。注意：不带 tasks 关系以保持轻量。 */
  async getInstanceByIds(ids: number[]): Promise<ApprovalInstance[]> {
    if (!ids.length) return [];
    return this.instanceRepo.find({
      where: { id: In(ids) },
    });
  }

  /** 批量按 (targetType, targetId) 取每个 target 的最新实例（避免 N+1）。 */
  async getLatestInstances(targetType: string, targetIds: number[]): Promise<ApprovalInstance[]> {
    if (!targetIds.length) return [];
    // 取所有候选后内存去重保留 id 最大；targetIds 通常不大（一页范围内）
    const all = await this.instanceRepo.find({
      where: { targetType: targetType as ApprovalTargetType, targetId: In(targetIds) },
      order: { id: 'DESC' },
    });
    const seen = new Map<number, ApprovalInstance>();
    for (const inst of all) {
      if (!seen.has(inst.targetId)) seen.set(inst.targetId, inst);
    }
    return [...seen.values()];
  }

  async getPendingInstance(targetType: string, targetId: number) {
    return this.instanceRepo.findOne({
      where: { targetType: targetType as ApprovalTargetType, targetId, status: 'pending' },
      relations: ['tasks'],
      order: { id: 'DESC' },
    });
  }

  async getPendingTasks(approverId: number, params: { targetType?: string; isAdmin?: boolean }) {
    const where: any = { status: 'pending' };
    if (!params.isAdmin) where.approverId = approverId;
    if (params.targetType) where.targetType = params.targetType;

    const tasks = await this.taskRepo.find({
      where,
      relations: ['instance'],
      order: { updatedAt: 'DESC' },
    });

    const byInstance = new Map<number, ApprovalTask>();
    for (const task of tasks) {
      if (task.instance?.status !== 'pending') continue;
      if (!byInstance.has(task.instanceId)) byInstance.set(task.instanceId, task);
    }
    return Array.from(byInstance.values());
  }

  async getTasksForInstance(instanceId: number) {
    return this.taskRepo.find({
      where: { instanceId },
      order: { stepOrder: 'ASC', id: 'ASC' },
    });
  }

  async userHasTask(targetType: string, targetId: number, userId: number) {
    const count = await this.taskRepo.count({
      where: { targetType: targetType as ApprovalTargetType, targetId, approverId: userId },
    });
    return count > 0;
  }

  async userHasPendingTask(targetType: string, targetId: number, userId: number) {
    const count = await this.taskRepo.count({
      where: { targetType: targetType as ApprovalTargetType, targetId, approverId: userId, status: 'pending' },
    });
    return count > 0;
  }

  async act(params: {
    targetType: string;
    targetId: number;
    approverId: number;
    approverName: string;
    action: 'approve' | 'reject';
    comment?: string;
    isAdmin?: boolean;
  }) {
    const instance = await this.getPendingInstance(params.targetType, params.targetId);
    if (!instance) throw new BusinessError('审批实例不存在或已结束');
    if (instance.applicantId === params.approverId) throw new BusinessError('不能审批自己的申请');
    if (!instance.currentStepOrder) throw new BusinessError('审批实例当前步骤异常');

    const currentTasks = await this.taskRepo.find({
      where: {
        instanceId: instance.id,
        stepOrder: instance.currentStepOrder,
        status: 'pending',
      },
      order: { id: 'ASC' },
    });
    if (!currentTasks.length) throw new BusinessError('当前步骤没有待审批任务');

    const actingTask = currentTasks.find(task => task.approverId === params.approverId) || (params.isAdmin ? currentTasks[0] : null);
    if (!actingTask) throw new BusinessError('您不是当前步骤的审批人');

    const now = new Date();
    actingTask.status = params.action === 'approve' ? 'approved' : 'rejected';
    actingTask.action = params.action;
    actingTask.actedById = params.approverId;
    actingTask.actedByName = params.approverName;
    actingTask.comment = params.comment ?? null;
    actingTask.actedAt = now;
    await this.taskRepo.save(actingTask);

    const skippedCurrentTasks = currentTasks.filter(task => task.id !== actingTask.id);
    if (skippedCurrentTasks.length) {
      await this.taskRepo.update({ id: In(skippedCurrentTasks.map(task => task.id)) }, {
        status: 'skipped',
        action: 'skip',
        actedById: params.approverId,
        actedByName: params.approverName,
        comment: `${params.approverName} 已处理该步骤`,
        actedAt: now,
      });
    }

    if (params.action === 'reject') {
      await this.taskRepo.update(
        { instanceId: instance.id, status: 'waiting' },
        {
          status: 'skipped',
          action: 'skip',
          actedById: params.approverId,
          actedByName: params.approverName,
          comment: '审批已驳回',
          actedAt: now,
        },
      );
      instance.status = 'rejected';
      instance.finishedAt = now;
      await this.instanceRepo.save(instance);
      return { status: 'rejected' as const, instance, task: actingTask, nextApproverIds: [] as number[] };
    }

    const nextTasks = await this.taskRepo.find({
      where: {
        instanceId: instance.id,
        stepOrder: MoreThan(instance.currentStepOrder),
        status: 'waiting',
      },
      order: { stepOrder: 'ASC', id: 'ASC' },
    });
    const nextStepOrder = nextTasks[0]?.stepOrder ?? null;

    if (!nextStepOrder) {
      instance.status = 'approved';
      instance.currentStepOrder = null;
      instance.finishedAt = now;
      await this.instanceRepo.save(instance);
      return { status: 'approved' as const, instance, task: actingTask, nextApproverIds: [] as number[] };
    }

    const stepTasks = nextTasks.filter(task => task.stepOrder === nextStepOrder);
    await this.taskRepo.update({ id: In(stepTasks.map(task => task.id)) }, { status: 'pending' });
    instance.currentStepOrder = nextStepOrder;
    await this.instanceRepo.save(instance);

    return {
      status: 'submitted' as const,
      instance,
      task: actingTask,
      nextApproverIds: stepTasks.map(task => task.approverId),
    };
  }

  async withdraw(targetType: string, targetId: number, userId: number, userName: string) {
    const instance = await this.getPendingInstance(targetType, targetId);
    if (!instance) return null;
    const now = new Date();

    instance.status = 'withdrawn';
    instance.currentStepOrder = null;
    instance.finishedAt = now;
    await this.instanceRepo.save(instance);

    await this.taskRepo.update(
      { instanceId: instance.id, status: 'pending' },
      {
        status: 'withdrawn',
        action: 'withdraw',
        actedById: userId,
        actedByName: userName,
        comment: '申请人撤回审批',
        actedAt: now,
      },
    );
    await this.taskRepo.update(
      { instanceId: instance.id, status: 'waiting' },
      {
        status: 'withdrawn',
        action: 'withdraw',
        actedById: userId,
        actedByName: userName,
        comment: '申请人撤回审批',
        actedAt: now,
      },
    );

    return instance;
  }
}
