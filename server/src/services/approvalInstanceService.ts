import { EntityManager, In, MoreThan } from 'typeorm';
import { BusinessError } from '../utils/errors';
import { AppDataSource } from '../config/database';
import { ApprovalInstance, ApprovalInstanceStepSnapshot } from '../entities/ApprovalInstance';
import { ApprovalTask } from '../entities/ApprovalTask';
import { ApprovalRecord } from '../entities/ApprovalRecord';
import { ApprovalTargetType } from '../entities/ApprovalFlowVersion';
import { ApprovalFlowEngine } from './approvalFlowService';
import { Timesheet } from '../entities/Timesheet';

export class ApprovalInstanceService {
  constructor(private manager?: EntityManager) {}

  private get instanceRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalInstance); }
  private get taskRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalTask); }
  private get recordRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalRecord); }
  private get flowEngine() { return new ApprovalFlowEngine(this.manager); }
  private get timesheetRepo() { return (this.manager ?? AppDataSource).getRepository(Timesheet); }

  async start(params: {
    targetType: ApprovalTargetType;
    targetId: number;
    applicantId: number;
    projectId?: number | null;
  }) {
    const version = await this.flowEngine.getDefaultFlowVersion(params.targetType);
    const now = new Date();

    // 无流程版本：直接创建已通过的 instance + auto_approve 记录（统一审计轨迹）
    if (!version || !version.steps?.length) {
      const autoInstance = await this.instanceRepo.save(this.instanceRepo.create({
        targetType: params.targetType,
        targetId: params.targetId,
        applicantId: params.applicantId,
        status: 'approved',
        currentStepOrder: null,
        totalSteps: 0,
        flowId: version?.flowId ?? null,
        flowVersionId: version?.id ?? null,
        flowName: version?.flowName ?? '无审批流程',
        flowVersionNumber: version?.version ?? 0,
        stepsSnapshot: [],
        submittedAt: now,
        finishedAt: now,
      }));
      await this.recordRepo.save(this.recordRepo.create({
        targetType: params.targetType as any,
        targetId: params.targetId,
        instanceId: autoInstance.id,
        taskId: null,
        approverId: params.applicantId,
        approverName: '系统',
        action: 'approve',
        comment: '无审批流程，系统自动通过',
        stepOrder: 0,
        stepType: 'auto' as any,
        stepLabel: '自动通过',
      }));
      return { status: 'approved' as const, instance: autoInstance, firstApproverIds: [] as number[] };
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
          requireAllApprovers: !!(sourceStep as any).requireAllApprovers,
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
      // 自动通过：写一条 auto_approve 审批记录，保留审计轨迹（A5）
      await this.recordRepo.save(this.recordRepo.create({
        targetType: params.targetType as any,
        targetId: params.targetId,
        instanceId: instance.id,
        taskId: null,
        approverId: params.applicantId,
        approverName: '系统',
        action: 'approve',
        comment: '无审批人，系统自动通过',
        stepOrder: 0,
        stepType: 'auto' as any,
        stepLabel: '自动通过',
      }));
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
    // 精确匹配优先
    const direct = await this.instanceRepo.findOne({
      where: { targetType: targetType as ApprovalTargetType, targetId, status: 'pending' },
      relations: ['tasks'],
      order: { id: 'DESC' },
    });
    if (direct) return direct;

    // 工时归一化：一个 submissionGroup 的多行工时共享一个审批实例，
    // 但实例的 targetId 只挂在首行（submitByRows 里 const targetId = records[0].id）。
    // 当按 group 内非首行记录（如详情页从 id=20 进入，而实例挂在 id=16）撤回/审批时，
    // 精确查不到——这里回退到该 group 首行 targetId 再查一次。
    if (targetType === 'timesheet') {
      const seed = await this.timesheetRepo.findOne({ where: { id: targetId } });
      if (seed?.submissionGroupId) {
        // group 内 id 最小的非废弃记录，即实例真正挂载的首行 targetId
        const headRow = await this.timesheetRepo.findOne({
          where: { submissionGroupId: seed.submissionGroupId },
          order: { id: 'ASC' },
        });
        if (headRow && headRow.id !== targetId) {
          return this.instanceRepo.findOne({
            where: { targetType: 'timesheet' as ApprovalTargetType, targetId: headRow.id, status: 'pending' },
            relations: ['tasks'],
            order: { id: 'DESC' },
          });
        }
      }
    }
    return null;
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
      // 只取当前步骤的 task（A7：避免跨步骤同审批人返回历史步骤的 task）
      if (task.instance.currentStepOrder !== null && task.stepOrder !== task.instance.currentStepOrder) continue;
      const existing = byInstance.get(task.instanceId);
      // 优先保留当前步骤的；若已有当前步骤 task 则不覆盖
      if (!existing) byInstance.set(task.instanceId, task);
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
    // 并发安全：用条件更新（WHERE id AND status='pending'），防止两人并发审批同一 task
    // 导致重复审批记录/状态错乱。affected=0 说明 task 已被其它请求处理。
    const updateResult = await this.taskRepo.update(
      { id: actingTask.id, status: 'pending' },
      {
        status: params.action === 'approve' ? 'approved' : 'rejected',
        action: params.action,
        actedById: params.approverId,
        actedByName: params.approverName,
        comment: params.comment ?? null,
        actedAt: now,
      },
    );
    // better-sqlite3 返回 affected 为 number；若已被并发处理则 affected=0
    const affected = (updateResult as any).affected ?? (updateResult as any).raw?.changes ?? 1;
    if (affected === 0) {
      throw new BusinessError('该审批任务已被处理，请刷新列表');
    }
    // 同步内存对象，供后续逻辑读取最新状态
    actingTask.status = params.action === 'approve' ? 'approved' : 'rejected';
    actingTask.action = params.action;
    actingTask.actedById = params.approverId;
    actingTask.actedByName = params.approverName;
    actingTask.comment = params.comment ?? null;
    actingTask.actedAt = now;

    // 判断当前步骤是否为会签（requireAllApprovers）
    const currentStepSnapshot = instance.stepsSnapshot?.find(s => s.stepOrder === instance.currentStepOrder);
    const isCountersign = !!currentStepSnapshot?.requireAllApprovers;

    if (params.action === 'reject') {
      // 驳回：清理当前步骤其余 pending task + 所有 waiting task（A12: 含 pending 防孤儿）
      await this.taskRepo.update(
        { instanceId: instance.id, status: In(['waiting', 'pending']) },
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

    // approve 分支
    if (isCountersign) {
      // 会签：跳过当前步骤其余 task（标记 skipped 不合适——他们没操作）。
      // 会签语义：只有所有人都 approved 才推进。其余 task 仍保持 pending，等待各自处理。
      const remainingPending = currentTasks.filter(t => t.id !== actingTask.id && t.status === 'pending');
      if (remainingPending.length > 0) {
        // 还有人没审批，停留在当前步骤，不推进
        await this.instanceRepo.save(instance);
        return { status: 'submitted' as const, instance, task: actingTask, nextApproverIds: [] as number[] };
      }
      // 所有人均已 approved，推进下一步（fall through 到下方的推进逻辑）
    } else {
      // 或签：任一通过即推进，跳过当前步骤其余 pending task
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
      // 乐观锁：条件更新，防止并发下重复推进
      const r = await this.instanceRepo.update(
        { id: instance.id, status: 'pending' },
        { status: 'approved', currentStepOrder: null, finishedAt: now },
      );
      if (((r as any).affected ?? 1) === 0) throw new BusinessError('审批实例状态已变更，请刷新');
      instance.status = 'approved';
      instance.currentStepOrder = null;
      instance.finishedAt = now;
      return { status: 'approved' as const, instance, task: actingTask, nextApproverIds: [] as number[] };
    }

    const stepTasks = nextTasks.filter(task => task.stepOrder === nextStepOrder);
    await this.taskRepo.update({ id: In(stepTasks.map(task => task.id)) }, { status: 'pending' });
    // 乐观锁：推进 currentStepOrder 时校验未被并发改动
    const r = await this.instanceRepo.update(
      { id: instance.id, status: 'pending', currentStepOrder: instance.currentStepOrder as any },
      { currentStepOrder: nextStepOrder },
    );
    if (((r as any).affected ?? 1) === 0) throw new BusinessError('审批实例状态已变更，请刷新');
    instance.currentStepOrder = nextStepOrder;

    return {
      status: 'submitted' as const,
      instance,
      task: actingTask,
      nextApproverIds: stepTasks.map(task => task.approverId),
    };
  }

  async withdraw(targetType: string, targetId: number, userId: number, userName: string) {
    const instance = await this.getPendingInstance(targetType, targetId);
    // 实例不存在或已结束（approved/rejected/withdrawn）——必须抛错，不能 return null，
    // 否则上层会把已批准的 target 改回 draft（A4 状态不一致修复）
    if (!instance) throw new BusinessError('审批实例不存在或已结束，无法撤回');
    const now = new Date();

    // 原子更新：条件 WHERE status='pending'，affected=0 说明并发下已被审批人处理
    const result = await this.instanceRepo.update(
      { id: instance.id, status: 'pending' },
      { status: 'withdrawn', currentStepOrder: null, finishedAt: now },
    );
    const affected = (result as any).affected ?? 1;
    if (affected === 0) throw new BusinessError('审批已被处理，无法撤回');

    instance.status = 'withdrawn';
    instance.currentStepOrder = null;
    instance.finishedAt = now;

    await this.taskRepo.update(
      { instanceId: instance.id, status: In(['pending', 'waiting']) },
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
