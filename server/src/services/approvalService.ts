import { EntityManager, In, Not, Repository } from 'typeorm';
import { AppDataSource } from '../config/database';
import { ApprovalRecord } from '../entities/ApprovalRecord';
import { Timesheet } from '../entities/Timesheet';
import { OvertimeApplication } from '../entities/OvertimeApplication';
import { WeeklyReport } from '../entities/WeeklyReport';
import { User } from '../entities/User';
import { Group } from '../entities/Group';
import { ApprovalTask } from '../entities/ApprovalTask';
import { ApprovalInstance } from '../entities/ApprovalInstance';
import { ApprovalInstanceService } from './approvalInstanceService';
import { NotificationPublisher } from './notifications';
import { PermissionRequest } from '../entities/PermissionRequest';
import { PermissionGovernanceService } from './permissionGovernanceService';
import { ProjectWorkloadAllocation } from '../entities/ProjectWorkloadAllocation';
import { BusinessError, isUniqueViolation } from '../utils/errors';
import { round2 } from '../utils/validation';
import { sumConsumption } from '../utils/timesheetConsumption';
import { invalidateAuthUsers } from '../config/cache';

type TargetType = 'timesheet' | 'overtime' | 'weekly_report' | 'permission_request';

/**
 * 审批目标实体的公共形状（判别联合的公共部分）。
 * 收敛原先的 any，约束实际被读取的字段，保留各类型特有字段为可选。
 */
interface ApprovalTargetLike {
  id: number;
  status: string;
  userId?: number;
  applicantId?: number;
  projectId?: number | null;
  currentStep?: number;
  totalSteps?: number;
  approvalInstanceId?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
  // timesheet 特有
  submissionGroupId?: number | null;
  previousGroupId?: number | null;
  // overtime / weekly_report / permission_request 特有
  date?: string;
  days?: number;
  overtimeType?: string;
  reason?: string;
  weekStart?: string;
  weekEnd?: string;
  totalDays?: number;
  content?: string;
  summary?: string;
  permissionCode?: string;
  permissionName?: string;
  scopeType?: string;
  scopeId?: number | null;
  scopeName?: string | null;
  expiresAt?: Date | null;
  grantId?: number | null;
}

/** 通知动作（事务提交后统一发送） */
type PendingNotification =
  | { kind: 'pending'; approverIds: number[]; targetType: string; targetId: number; applicantName: string; title: string }
  | { kind: 'result'; applicantId: number; targetType: string; targetId: number; approved: boolean; comment?: string };

/** 批量审批部分成功时，单条失败项的描述（附加在 approve 返回结构的 failed 字段，向后兼容） */
type FailedApprovalItem = { targetType: string; targetId: number; action: string; reason: string };

export class ApprovalService {
  constructor(private manager?: EntityManager) {}

  private transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.manager ? work(this.manager) : AppDataSource.transaction(work);
  }

  private get recordRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalRecord); }
  private get timesheetRepo() { return (this.manager ?? AppDataSource).getRepository(Timesheet); }
  private get overtimeRepo() { return (this.manager ?? AppDataSource).getRepository(OvertimeApplication); }
  private get weeklyReportRepo() { return (this.manager ?? AppDataSource).getRepository(WeeklyReport); }
  private get permissionRequestRepo() { return (this.manager ?? AppDataSource).getRepository(PermissionRequest); }
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }
  private get allocationRepo() { return (this.manager ?? AppDataSource).getRepository(ProjectWorkloadAllocation); }
  private get groupRepo() { return (this.manager ?? AppDataSource).getRepository(Group); }
  private get instanceRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalInstance); }
  private get approvalInstanceService() { return new ApprovalInstanceService(this.manager); }
  private get permissionGovernanceService() { return new PermissionGovernanceService(this.manager); }

  private async isAdminUser(userId: number): Promise<boolean> {
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: ['roles'] });
    return (user?.roles?.map(role => role.name) ?? []).includes('admin');
  }

  private async getTargetInfo(targetType: string, targetId: number): Promise<{
    target: ApprovalTargetLike | null;
    applicantId: number;
    repo: Repository<any> | null;
    projectId: number | null;
  }> {
    let target: ApprovalTargetLike | null = null;
    let repo: Repository<any> | null = null;

    if (targetType === 'timesheet') {
      target = await this.timesheetRepo.findOne({ where: { id: targetId } }) as ApprovalTargetLike | null;
      repo = this.timesheetRepo;
    } else if (targetType === 'overtime') {
      target = await this.overtimeRepo.findOne({ where: { id: targetId } }) as ApprovalTargetLike | null;
      repo = this.overtimeRepo;
    } else if (targetType === 'weekly_report') {
      target = await this.weeklyReportRepo.findOne({ where: { id: targetId } }) as ApprovalTargetLike | null;
      repo = this.weeklyReportRepo;
    } else if (targetType === 'permission_request') {
      target = await this.permissionRequestRepo.findOne({ where: { id: targetId } }) as ApprovalTargetLike | null;
      repo = this.permissionRequestRepo;
    }

    return {
      target,
      applicantId: target?.userId ?? target?.applicantId ?? 0,
      repo,
      projectId: target?.projectId ?? null,
    };
  }

  private async getTargetInstance(targetType: string, target: ApprovalTargetLike | null, targetId: number) {
    if (target?.approvalInstanceId) {
      const byId = await this.approvalInstanceService.getInstanceById(target.approvalInstanceId);
      if (byId) return byId;
    }
    return this.approvalInstanceService.getLatestInstance(targetType, targetId);
  }

  private async canViewApprovalTarget(targetType: string, target: ApprovalTargetLike, targetId: number, viewerId: number, records?: ApprovalRecord[]) {
    if ((target.userId ?? target.applicantId) === viewerId) return true;
    if (await this.isAdminUser(viewerId)) return true;

    const approvalRecords = records ?? await this.recordRepo.find({ where: { targetType: targetType as TargetType, targetId } });
    if (approvalRecords.some(record => record.approverId === viewerId)) return true;

    return this.approvalInstanceService.userHasTask(targetType, targetId, viewerId);
  }

  private buildStepInfo(instance: ApprovalInstance | null) {
    if (!instance) return null;
    const currentStep = instance.stepsSnapshot.find(step => step.stepOrder === instance.currentStepOrder);
    if (!currentStep) return null;
    return {
      stepType: currentStep.stepType,
      stepLabel: currentStep.label,
      approverIds: currentStep.approvers.map(approver => approver.id),
      approverNames: currentStep.approvers.map(approver => approver.name),
    };
  }

  private async buildListItem(targetType: TargetType, target: ApprovalTargetLike, instance: ApprovalInstance | null, applicant?: User | null) {
    const applicantPrefix = applicant?.realName ? `${applicant.realName} - ` : '';
    const base: any = {
      targetType,
      targetId: target.id,
      instanceId: instance?.id ?? target.approvalInstanceId ?? null,
      status: target.status,
      applicant: applicant?.realName,
      applicantId: applicant?.id,
      department: applicant?.department?.name,
      currentStep: target.currentStep,
      totalSteps: target.totalSteps,
      createdAt: instance?.submittedAt || target.updatedAt || target.createdAt,
    };

    if (targetType === 'timesheet') {
      const ts = (target as any).project ? (target as any) : await this.timesheetRepo.findOne({ where: { id: target.id }, relations: ['project'] });
      if (ts?.submissionGroupId) {
        const groupRecords = await this.timesheetRepo.find({
          where: { submissionGroupId: ts.submissionGroupId },
          relations: ['project'],
          order: { date: 'ASC' },
        });
        const project = groupRecords[0]?.project || ts.project;
        const dates = groupRecords.map(record => record.date);
        base.title = `${applicantPrefix}${project?.name || ''} - ${dates[0] || ''}~${dates[dates.length - 1] || ''}`;
        base.date = dates[0] || ts.date;
        base.weekStart = dates[0] || ts.date;
        base.weekEnd = dates[dates.length - 1] || ts.date;
        base.days = round2(groupRecords.reduce((sum, record) => sum + Number(record.days), 0));
        base.description = groupRecords[0]?.description;
        base.projectId = ts.projectId;
        base.submissionGroupId = ts.submissionGroupId;
      } else {
        base.title = `${applicantPrefix}${ts?.project?.name || ''} - ${ts?.date || ''}`;
        base.date = ts?.date;
        base.days = ts?.days;
        base.description = ts?.description;
        base.projectId = ts?.projectId;
      }
    } else if (targetType === 'overtime') {
      base.title = `${applicantPrefix}${target.date} 加班申请`;
      base.date = target.date;
      base.days = target.days;
      base.overtimeType = target.overtimeType;
      base.reason = target.reason;
    } else if (targetType === 'weekly_report') {
      base.title = `${applicantPrefix}${target.weekStart}~${target.weekEnd} 周报`;
      base.weekStart = target.weekStart;
      base.weekEnd = target.weekEnd;
      base.totalDays = target.totalDays;
      base.summary = target.summary;
    } else if (targetType === 'permission_request') {
      base.title = `${applicantPrefix}申请开通 ${target.permissionName}`;
      base.permissionCode = target.permissionCode;
      base.permissionName = target.permissionName;
      base.scopeType = target.scopeType;
      base.scopeId = target.scopeId;
      base.scopeName = target.scopeName;
      base.reason = target.reason;
      base.expiresAt = target.expiresAt;
    }

    const stepInfo = this.buildStepInfo(instance);
    if (stepInfo) {
      base.currentStepLabel = stepInfo.stepLabel;
      base.currentStepApprover = stepInfo.approverNames.join('、');
      base.currentStepApproverIds = stepInfo.approverIds;
    }

    return base;
  }

  async getPendingList(approverId: number, params: { targetType?: string; page?: number; pageSize?: number }) {
    const { targetType, page = 1, pageSize = 20 } = params;
    const isAdmin = await this.isAdminUser(approverId);
    // 在数据库完成范围过滤和分页，避免管理员请求加载公司全部待办。
    const { items: pageTasks, total: rawTotal } = await this.approvalInstanceService.getPendingTasks(
      approverId,
      { targetType, isAdmin, page, pageSize },
    );

    // 过滤掉 target 已非 submitted 的孤儿任务（记录被废弃/撤回但 pending task 残留），
    // 并批量加载 target 信息。
    const { items: validTasks, targetMap } = await this.loadValidPendingTasks(pageTasks);

    // total 校准：当本页存在被过滤的孤儿任务时，全量（不分页）过滤一次得到准确 total，
    // 避免分页按未过滤的 DB 窗口计算导致翻页空页/漏项。
    let total = rawTotal;
    if (validTasks.length !== pageTasks.length) {
      const { items: allTasks } = await this.approvalInstanceService.getPendingTasks(
        approverId,
        { targetType, isAdmin, page: 1, pageSize: 1_000_000 },
      );
      const { items: validAll } = await this.loadValidPendingTasks(allTasks);
      total = validAll.length;
    }

    // 批量加载 applicant：收集所有 applicantId 一次性查
    const applicantIds = new Set<number>();
    for (const task of validTasks) {
      const target = targetMap.get(`${task.targetType}_${task.targetId}`);
      if (target) applicantIds.add(target.userId ?? target.applicantId ?? 0);
    }
    const applicantMap = new Map<number, User>();
    if (applicantIds.size) {
      const applicants = await this.userRepo.find({
        where: { id: In([...applicantIds].filter(Boolean)) },
        relations: ['department', 'group'],
      });
      for (const a of applicants) applicantMap.set(a.id, a);
    }

    const results: any[] = [];
    for (const task of validTasks) {
      const target = targetMap.get(`${task.targetType}_${task.targetId}`);
      if (!target) continue;
      const applicant = applicantMap.get(target.userId ?? target.applicantId) ?? null;
      const item = await this.buildListItem(task.targetType as TargetType, target, task.instance, applicant);
      item.taskId = task.id;
      results.push(item);
    }

    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { list: results, total, page, pageSize };
  }

  /**
   * 过滤出 target 仍处于待审批（submitted）状态的任务，并批量加载 target 信息。
   * 孤儿任务（记录已 deprecated/withdrawn 但 pending task 残留）会被剔除，
   * 避免审批人看到无法处理的陈旧待办。
   */
  private async loadValidPendingTasks(tasks: Array<{ id: number; targetType: string; targetId: number; instance: ApprovalInstance }>) {
    // 批量加载 target：按 targetType 分组，用 In(...) 一次性取，避免 N+1
    const tasksByType = new Map<string, typeof tasks>();
    for (const task of tasks) {
      const bucket = tasksByType.get(task.targetType) ?? [];
      bucket.push(task);
      tasksByType.set(task.targetType, bucket);
    }

    const targetMap = new Map<string, any>();
    for (const [type, bucket] of tasksByType) {
      const ids = bucket.map(t => t.targetId);
      const repo = this.getRepoByTargetType(type);
      if (repo && ids.length) {
        const found = await repo.find({ where: { id: In(ids) } as any, relations: type === 'timesheet' ? ['project'] : undefined });
        for (const t of found) targetMap.set(`${type}_${t.id}`, t);
      }
    }

    const items = tasks.filter((task) => {
      const target = targetMap.get(`${task.targetType}_${task.targetId}`);
      return !!target && target.status === 'submitted';
    });
    return { items, targetMap };
  }

  /** 按 targetType 返回对应的实体 repository（供批量查询） */
  private getRepoByTargetType(targetType: string) {
    if (targetType === 'timesheet') return this.timesheetRepo;
    if (targetType === 'overtime') return this.overtimeRepo;
    if (targetType === 'weekly_report') return this.weeklyReportRepo;
    if (targetType === 'permission_request') return this.permissionRequestRepo;
    return null;
  }

  async approve(approverId: number, approverName: string, items: { targetType: string; targetId: number; action: 'approve' | 'reject'; comment?: string }[]) {
    if (!items.length) throw new BusinessError('请选择需要审批的记录');
    const isAdmin = await this.isAdminUser(approverId);
    const itemKeys = new Set<string>();
    for (const item of items) {
      // 非管理员：同一请求内同 (targetType, targetId) 视为重复提交（每人每实例只有一个待办任务），前置拒绝。
      // 管理员不做前置去重：会签步骤同一单据有多条待办 task（同一 targetId），批量处理时
      // 每条 item 对应一个 task；重复提交由审批任务的条件更新（affected=0）在数据库层面幂等兜底。
      if (!isAdmin) {
        const key = `${item.targetType}:${item.targetId}`;
        if (itemKeys.has(key)) throw new BusinessError(`审批记录重复（类型：${item.targetType}，编号：${item.targetId}）`);
        itemKeys.add(key);
      }
      if (item.action === 'reject' && !item.comment?.trim()) throw new BusinessError('驳回时必须填写原因');
    }
    const applicantNameCache = new Map<number, string>();

    // 已传入事务管理器（被外层事务包裹）时保持原子语义：单条失败必须整批回滚，
    // 且在外层事务内无法开启独立子事务做部分成功。现有测试与契约依赖此处的抛错行为。
    if (this.manager) {
      const notifications: PendingNotification[] = [];
      const permissionGrantUserIds = new Set<number>();
      await this.transaction(async (manager) => {
        for (const item of items) {
          const res = await this.processOneApproval(manager, item, approverId, approverName, isAdmin, applicantNameCache);
          notifications.push(...res.notifications);
          for (const id of res.permissionGrantUserIds) permissionGrantUserIds.add(id);
        }
      });
      await invalidateAuthUsers([...permissionGrantUserIds]);
      await this.flushNotifications(notifications);
      return { success: true, failed: [] as FailedApprovalItem[] };
    }

    // 顶层调用（无外层事务，对应 HTTP 入口 new ApprovalService()）：部分成功——
    // 每条独立事务处理，互不影响；成功项正常提交，失败项收集到 failed 列表。
    const notifications: PendingNotification[] = [];
    const permissionGrantUserIds = new Set<number>();
    const failed: FailedApprovalItem[] = [];
    let firstError: unknown = null;

    for (const item of items) {
      try {
        const res = await AppDataSource.transaction(async (manager) =>
          this.processOneApproval(manager, item, approverId, approverName, isAdmin, applicantNameCache),
        );
        notifications.push(...res.notifications);
        for (const id of res.permissionGrantUserIds) permissionGrantUserIds.add(id);
      } catch (error) {
        if (firstError === null) firstError = error;
        failed.push({
          targetType: item.targetType,
          targetId: item.targetId,
          action: item.action,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await invalidateAuthUsers([...permissionGrantUserIds]);
    await this.flushNotifications(notifications);

    // 全部失败时抛出首个错误，保留「单条/全失败即抛错」语义，兼容现有调用方与测试
    // （如对单条非待审批记录调用 approve 仍会抛出「不是待审批状态」）。
    if (failed.length === items.length && firstError) throw firstError;

    return { success: failed.length === 0, failed };
  }

  /**
   * 处理单条审批（在给定事务管理器内执行）。抽取自 approve，供原子批量与部分成功两条路径复用。
   * 返回该条产生的通知与需刷新权限缓存的用户 id；失败时抛出，由调用方决定整批回滚或收集到 failed。
   */
  private async processOneApproval(
    manager: EntityManager,
    item: { targetType: string; targetId: number; action: 'approve' | 'reject'; comment?: string },
    approverId: number,
    approverName: string,
    isAdmin: boolean,
    applicantNameCache: Map<number, string>,
  ): Promise<{ notifications: PendingNotification[]; permissionGrantUserIds: number[] }> {
    const txService = new ApprovalService(manager);
    const { target, repo, applicantId } = await txService.getTargetInfo(item.targetType, item.targetId);
    if (!target) throw new BusinessError(`审批记录不存在（类型：${item.targetType}，编号：${item.targetId}）`);
    if (target.status !== 'submitted') throw new BusinessError(`记录 ${item.targetId} 不是待审批状态`);

    const result = await txService.approvalInstanceService.act({
      targetType: item.targetType,
      targetId: item.targetId,
      approverId,
      approverName,
      action: item.action,
      comment: item.comment,
      isAdmin,
    });

    await txService.recordRepo.save(txService.recordRepo.create({
      targetType: item.targetType as TargetType,
      targetId: item.targetId,
      instanceId: result.instance.id,
      taskId: result.task.id,
      approverId,
      approverName,
      action: item.action,
      comment: item.comment,
      stepOrder: result.task.stepOrder,
      stepType: result.task.stepType,
      stepLabel: result.task.stepLabel,
    }));

    const updateData: any = {};
    if (result.status === 'rejected') {
      updateData.status = 'rejected';
      updateData.currentStep = 0;
    } else if (result.status === 'approved') {
      updateData.status = 'approved';
      updateData.currentStep = 0;
    } else {
      updateData.currentStep = result.instance.currentStepOrder || 0;
    }

    let permissionGrantUserId: number | null = null;
    if (item.targetType === 'timesheet' && target.submissionGroupId) {
      // 在目标仍为 submitted 时冻结，确保通过、驳回和撤回三种终态的
      // consumed 均包含本次申请，快照口径一致。
      if (result.status === 'approved' || result.status === 'rejected') {
        await txService.freezeTimesheetQuotaSnapshot(
          result.instance.id,
          target.submissionGroupId,
          applicantId,
        );
      }
      // 回写条件收紧：仅更新「仍处于 submitted」的组内记录，防御并发重提已废弃旧组时
      // 复活 deprecated 记录；并限定 userId，避免发号碰撞等异常场景下跨用户误写。
      await txService.timesheetRepo.update(
        { submissionGroupId: target.submissionGroupId, userId: target.userId, status: 'submitted' },
        updateData,
      );
      if (item.action === 'approve' && result.status === 'approved') {
        // 新版本审批通过：按 rootGroupId deprecate 整条旧链上所有旧版本（非当前 submissionGroupId）
        const currentRec = await txService.timesheetRepo.findOne({
          where: { submissionGroupId: target.submissionGroupId },
        });
        const rootGroupId = currentRec?.rootGroupId;
        if (rootGroupId) {
          await txService.timesheetRepo.update(
            { rootGroupId, submissionGroupId: Not(target.submissionGroupId), status: Not('deprecated') },
            { status: 'deprecated' },
          );
        } else if (target.previousGroupId) {
          // 兜底：无 rootGroupId 时用 previousGroupId（直接前驱）
          await txService.timesheetRepo.update(
            { submissionGroupId: target.previousGroupId, userId: target.userId },
            { status: 'deprecated' },
          );
        }
      }
    } else if (item.targetType === 'permission_request') {
      if (result.status === 'approved') {
        const grant = await txService.permissionGovernanceService.activateGrant(item.targetId, result.instance.id, {
          id: approverId,
          name: approverName,
        });
        permissionGrantUserId = applicantId;
        await txService.permissionRequestRepo.update(item.targetId, { ...updateData, grantId: grant.id });
      } else if (result.status === 'rejected') {
        await txService.permissionGovernanceService.markRejected(item.targetId);
      } else {
        await txService.permissionGovernanceService.markSubmitted(item.targetId, result.instance.currentStepOrder || 0);
      }
    } else {
      await repo!.update(item.targetId, updateData);
    }

    const notifications: PendingNotification[] = [];
    if (item.action === 'reject') {
      notifications.push({ kind: 'result', applicantId, targetType: item.targetType, targetId: item.targetId, approved: false, comment: item.comment });
    } else if (result.status === 'approved') {
      notifications.push({ kind: 'result', applicantId, targetType: item.targetType, targetId: item.targetId, approved: true });
    } else if (result.nextApproverIds.length) {
      let applicantName = applicantNameCache.get(applicantId);
      if (applicantName === undefined) {
        applicantName = (await txService.userRepo.findOneBy({ id: applicantId }))?.realName || '申请人';
        applicantNameCache.set(applicantId, applicantName);
      }
      notifications.push({
        kind: 'pending',
        approverIds: result.nextApproverIds,
        targetType: item.targetType,
        targetId: item.targetId,
        applicantName,
        title: `审批流转至步骤${result.instance.currentStepOrder}`,
      });
    }

    return {
      notifications,
      permissionGrantUserIds: permissionGrantUserId === null ? [] : [permissionGrantUserId],
    };
  }

  /** 事务提交后统一发送通知（失败不影响业务） */
  private async flushNotifications(notifications: PendingNotification[]) {
    const notifier = new NotificationPublisher();
    for (const n of notifications) {
      try {
        if (n.kind === 'pending') {
          await notifier.notifyApprovalPending(n.approverIds, n.targetType, n.targetId, n.applicantName, n.title);
        } else {
          await notifier.notifyApprovalResult(n.applicantId, n.targetType, n.targetId, n.approved, n.comment);
        }
      } catch {}
    }
  }

  async getMySubmissions(userId: number, params: { targetType?: string; status?: string; startDate?: string; endDate?: string; page?: number; pageSize?: number }) {
    const { targetType, status, startDate, endDate, page = 1, pageSize = 20 } = params;
    type Candidate = { targetType: TargetType; targetId: number; sortAt: string | Date };
    const values: unknown[] = [];
    const isPostgres = (this.manager?.connection.options.type ?? AppDataSource.options.type) === 'postgres';
    const bind = (value: unknown) => {
      values.push(value);
      return isPostgres ? `$${values.length}` : '?';
    };
    const candidateQueries: string[] = [];

    // 表名取自实体元数据（单一事实来源），避免硬编码物理表名：
    // 实体 @Entity('xxx') 改名时此处自动同步。列名仍以带引号的实体属性名书写
    // （TypeORM 默认属性名即列名），属更深层抽象，超出本次「消除表名硬编码」范围。
    const tableName = {
      timesheet: this.timesheetRepo.metadata.tableName,
      overtime: this.overtimeRepo.metadata.tableName,
      weeklyReport: this.weeklyReportRepo.metadata.tableName,
      permissionRequest: this.permissionRequestRepo.metadata.tableName,
      approvalInstance: this.instanceRepo.metadata.tableName,
    };

    if (!targetType || targetType === 'timesheet') {
      const conditions = [`t."userId" = ${bind(userId)}`, `t."status" <> 'deprecated'`];
      if (status) conditions.push(`t."status" = ${bind(status)}`);
      if (startDate) conditions.push(`t."date" >= ${bind(startDate)}`);
      if (endDate) conditions.push(`t."date" <= ${bind(endDate)}`);
      candidateQueries.push(`
        SELECT 'timesheet' AS "targetType", MIN(t.id) AS "targetId",
          COALESCE(MAX(i."submittedAt"), MAX(t."updatedAt")) AS "sortAt"
        FROM ${tableName.timesheet} t
        LEFT JOIN ${tableName.approvalInstance} i ON i.id = t."approvalInstanceId"
        WHERE ${conditions.join(' AND ')}
        GROUP BY COALESCE(t."submissionGroupId", -t.id)
      `);
    }

    const addSingleRecordQuery = (
      type: Exclude<TargetType, 'timesheet'>,
      table: string,
      userColumn: string,
      dateColumn?: string,
    ) => {
      if (targetType && targetType !== type) return;
      const alias = 'x';
      const conditions = [`${alias}."${userColumn}" = ${bind(userId)}`];
      if (status) conditions.push(`${alias}."status" = ${bind(status)}`);
      if (dateColumn && startDate) conditions.push(`${alias}."${dateColumn}" >= ${bind(startDate)}`);
      if (dateColumn && endDate) conditions.push(`${alias}."${dateColumn}" <= ${bind(endDate)}`);
      candidateQueries.push(`
        SELECT '${type}' AS "targetType", ${alias}.id AS "targetId",
          COALESCE(i."submittedAt", ${alias}."updatedAt") AS "sortAt"
        FROM ${table} ${alias}
        LEFT JOIN ${tableName.approvalInstance} i ON i.id = ${alias}."approvalInstanceId"
        WHERE ${conditions.join(' AND ')}
      `);
    };
    addSingleRecordQuery('overtime', tableName.overtime, 'userId', 'date');
    addSingleRecordQuery('weekly_report', tableName.weeklyReport, 'userId', 'weekStart');
    // 权限申请没有业务日期字段，日期筛选仍沿用原行为，不对其生效。
    addSingleRecordQuery('permission_request', tableName.permissionRequest, 'applicantId');

    if (!candidateQueries.length) return { list: [], total: 0, page, pageSize };
    const unionSql = candidateQueries.join(' UNION ALL ');
    const querySource = this.manager ?? AppDataSource;
    const totalRows = await querySource.query(`SELECT COUNT(*) AS count FROM (${unionSql}) candidates`, values);
    const total = Number(totalRows?.[0]?.count ?? 0);
    const limitPlaceholder = bind(pageSize);
    const offsetPlaceholder = bind((page - 1) * pageSize);
    const rows = await querySource.query(
      `SELECT * FROM (${unionSql}) candidates ORDER BY "sortAt" DESC, "targetType", "targetId" DESC LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      values,
    ) as Candidate[];
    const candidates = rows.map(row => ({ ...row, targetId: Number(row.targetId) }));

    const idsByType = new Map<TargetType, number[]>();
    for (const candidate of candidates) {
      const ids = idsByType.get(candidate.targetType) ?? [];
      ids.push(candidate.targetId);
      idsByType.set(candidate.targetType, ids);
    }
    const targetMap = new Map<string, ApprovalTargetLike>();
    const instanceMap = new Map<string, ApprovalInstance | null>();
    for (const [type, ids] of idsByType) {
      const repo = this.getRepoByTargetType(type);
      if (!repo) continue;
      const targets = await repo.find({ where: { id: In(ids) } as any }) as ApprovalTargetLike[];
      for (const target of targets) targetMap.set(`${type}_${target.id}`, target);
      const instances = await this.batchInstances(type, targets);
      for (const [id, instance] of instances) instanceMap.set(`${type}_${id}`, instance);
    }

    const applicant = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['department', 'group'],
    });
    const list: any[] = [];
    for (const candidate of candidates) {
      const key = `${candidate.targetType}_${candidate.targetId}`;
      const target = targetMap.get(key);
      if (!target) continue;
      list.push(await this.buildListItem(candidate.targetType, target, instanceMap.get(key) ?? null, applicant));
    }
    return { list, total, page, pageSize };
  }

  /**
   * 批量加载审批实例：优先按 target 自带的 approvalInstanceId 批量查；
   * 对缺失的再按 (targetType, targetId) 批量取最新实例。避免逐条查询（N+1 → 2 次）。
   */
  private async batchInstances(targetType: string, targets: any[]): Promise<Map<number, ApprovalInstance | null>> {
    const result = new Map<number, ApprovalInstance | null>();
    if (!targets.length) return result;

    const byInstanceId = new Map<number, number>(); // instanceId -> targetId
    const missingTargetIds: number[] = [];
    for (const t of targets) {
      if (t.approvalInstanceId) {
        byInstanceId.set(t.approvalInstanceId, t.id);
      } else {
        missingTargetIds.push(t.id);
      }
    }

    // 1. 按 approvalInstanceId 批量
    if (byInstanceId.size) {
      const instances = await this.approvalInstanceService.getInstanceByIds([...byInstanceId.keys()]);
      for (const inst of instances) {
        const targetId = byInstanceId.get(inst.id);
        if (targetId) result.set(targetId, inst);
      }
      // 缺失的（approvalInstanceId 已失效）也加入 missing
      for (const [instanceId, targetId] of byInstanceId) {
        if (!result.has(targetId)) missingTargetIds.push(targetId);
      }
    }

    // 2. 对仍缺失的，按 (targetType, targetId) 批量取最新实例
    if (missingTargetIds.length) {
      const latest = await this.approvalInstanceService.getLatestInstances(targetType, missingTargetIds);
      for (const inst of latest) {
        if (!result.has(inst.targetId)) result.set(inst.targetId, inst);
      }
    }

    return result;
  }

  async getApprovalHistory(params: { targetType?: string; targetId?: number; page?: number; pageSize?: number; viewerId: number }) {
    const { targetType, targetId, page = 1, pageSize = 20, viewerId } = params;
    const qb = this.recordRepo.createQueryBuilder('r');
    if (targetType) qb.andWhere('r.targetType = :targetType', { targetType });
    if (targetId) qb.andWhere('r.targetId = :targetId', { targetId });
    qb.andWhere('r.approverId = :viewerId', { viewerId });
    qb.andWhere('r.action IN (:...actions)', { actions: ['approve', 'reject'] });

    qb.orderBy('r.createdAt', 'DESC');
    const [list, total] = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return { list, total, page, pageSize };
  }

  async withdraw(userId: number, targetType: string, targetId: number) {
    await this.transaction(async (manager) => {
      const txService = new ApprovalService(manager);
      const { target, repo } = await txService.getTargetInfo(targetType, targetId);
      if (!target) throw new BusinessError('记录不存在');
      if ((target.userId ?? target.applicantId) !== userId) throw new BusinessError('只能撤回自己的申请');
      if (target.status !== 'submitted') throw new BusinessError('只能撤回审批中的申请');

      const submitter = await txService.userRepo.findOneBy({ id: userId });
      const instance = await txService.approvalInstanceService.withdraw(targetType, targetId, userId, submitter?.realName || '');
      await txService.recordRepo.save(txService.recordRepo.create({
        targetType: targetType as TargetType,
        targetId,
        instanceId: instance?.id ?? target.approvalInstanceId ?? null,
        taskId: null,
        approverId: userId,
        approverName: submitter?.realName || '',
        action: 'withdraw',
        comment: '申请人撤回审批',
        stepOrder: target.currentStep || 1,
        stepType: 'withdraw',
        stepLabel: '撤回',
      }));

      const updateData: any = {
        status: 'withdrawn',
        currentStep: 0,
        approvalFlowId: null,
        approvalInstanceId: null,
        totalSteps: 0,
      };
      if (targetType === 'timesheet' && target.submissionGroupId) {
        // 撤回前冻结配额快照（撤回也是操作历史的一部分，方便回溯）
        const instanceId = instance?.id ?? target.approvalInstanceId;
        if (instanceId) {
          await txService.freezeTimesheetQuotaSnapshot(instanceId, target.submissionGroupId, userId);
        }
        // 撤回保留 submissionGroupId（维持分组归属：历史按组展示、修改链追溯）。
        // previousGroupId / rootGroupId 亦保留。下次提交时 submitByRows 的 existingRecords
        // 只查 draft/rejected/approved/submitted，不含 withdrawn，故撤回记录不会被当作
        // "已存在版本"误走 deprecated 重建分支——无需清空 group。
        // 限定 userId 防御发号碰撞等异常场景下跨用户误写。
        await txService.timesheetRepo.update(
          { submissionGroupId: target.submissionGroupId, userId },
          updateData,
        );
      } else {
        await repo!.update(targetId, updateData);
      }
    });

    return { success: true };
  }

  async cc(fromUserId: number, fromUserName: string, targetType: string, targetId: number, recipientIds: number[]) {
    const uniqueRecipientIds = [...new Set(recipientIds)].filter(id => id !== fromUserId);
    if (!uniqueRecipientIds.length) throw new BusinessError('请选择至少一名其他用户作为抄送人');

    let createdCount = 0;
    const createdRecipientIds: number[] = [];
    await this.transaction(async (manager) => {
      const txService = new ApprovalService(manager);
      const { target } = await txService.getTargetInfo(targetType, targetId);
      if (!target) throw new BusinessError('记录不存在');
      if ((target.userId ?? target.applicantId) !== fromUserId) throw new BusinessError('只能抄送自己的申请');
      // 仅允许对审批中（submitted）的单据抄送：已撤回/已通过/已驳回的单据不应再产生抄送传阅。
      if (target.status !== 'submitted') throw new BusinessError('只能抄送审批中的申请');
      const instance = await txService.getTargetInstance(targetType, target, targetId);

      const recipients = await txService.userRepo.find({
        where: { id: In(uniqueRecipientIds), status: 1 },
      });
      if (recipients.length !== uniqueRecipientIds.length) throw new BusinessError('抄送人不存在或已被禁用');
      const existing = await txService.recordRepo.find({
        where: {
          targetType: targetType as TargetType,
          targetId,
          action: 'cc',
          approverId: In(uniqueRecipientIds),
        },
        select: ['approverId'],
      });
      const existingIds = new Set(existing.map(record => record.approverId));

      for (const recipient of recipients) {
        if (existingIds.has(recipient.id)) continue;

        try {
          await txService.recordRepo.save(txService.recordRepo.create({
            targetType: targetType as TargetType,
            targetId,
            instanceId: instance?.id ?? null,
            taskId: null,
            approverId: recipient.id,
            approverName: recipient.realName,
            action: 'cc',
            comment: `${fromUserName} 抄送给您传阅`,
            stepOrder: 0,
            stepType: 'cc',
            stepLabel: '抄送传阅',
          }));
        } catch (error) {
          // 并发抄送：check-then-insert 之间另一事务已为同一收件人写入抄送记录，
          // 撞唯一约束（若存在）时转友好提示，避免重复 CC 记录后静默成功。
          if (isUniqueViolation(error)) throw new BusinessError('已抄送，请刷新');
          throw error;
        }
        createdCount += 1;
        createdRecipientIds.push(recipient.id);
      }
    });

    if (!createdCount) throw new BusinessError('所选用户均已收到过该审批抄送');
    try {
      await new NotificationPublisher().notifyApprovalCc(
        createdRecipientIds,
        targetType,
        targetId,
        fromUserName,
      );
    } catch {}
    return { success: true, createdCount };
  }

  async getMyCcList(userId: number, params: { page?: number; pageSize?: number }) {
    const { page = 1, pageSize = 20 } = params;
    const qb = this.recordRepo.createQueryBuilder('r')
      .where('r.action = :action', { action: 'cc' })
      .andWhere('r.approverId = :userId', { userId })
      .orderBy('r.createdAt', 'DESC');

    const total = await qb.getCount();
    const records = await qb.skip((page - 1) * pageSize).take(pageSize).getMany();
    if (records.length === 0) return { list: [], total, page, pageSize };

    // 批量加载 target：按 targetType 分组用 In(...) 一次查，避免 N+1
    const targetIdsByType = new Map<string, number[]>();
    for (const record of records) {
      const bucket = targetIdsByType.get(record.targetType) ?? [];
      bucket.push(record.targetId);
      targetIdsByType.set(record.targetType, bucket);
    }
    const targetMap = new Map<string, ApprovalTargetLike>();
    for (const [type, ids] of targetIdsByType) {
      const repo = this.getRepoByTargetType(type);
      if (repo && ids.length) {
        const found = await repo.find({ where: { id: In(ids) } as any, relations: type === 'timesheet' ? ['project'] : undefined });
        for (const t of found) targetMap.set(`${type}_${t.id}`, t as ApprovalTargetLike);
      }
    }

    // 批量加载 applicant
    const applicantIds = new Set<number>();
    for (const record of records) {
      const target = targetMap.get(`${record.targetType}_${record.targetId}`);
      if (target) applicantIds.add(target.userId ?? target.applicantId ?? 0);
    }
    const applicantMap = new Map<number, User>();
    if (applicantIds.size) {
      const applicants = await this.userRepo.find({
        where: { id: In([...applicantIds].filter(Boolean)) },
        relations: ['department'],
      });
      for (const a of applicants) applicantMap.set(a.id, a);
    }

    // 批量加载 instance（按 targetType 分组）
    const instanceMap = new Map<string, ApprovalInstance | null>();
    for (const [type, ids] of targetIdsByType) {
      const merged = await this.batchInstances(type, ids.map(id => ({ id, approvalInstanceId: undefined as any })));
      for (const [tid, inst] of merged) instanceMap.set(`${type}_${tid}`, inst);
    }

    const list: any[] = [];
    for (const record of records) {
      const target = targetMap.get(`${record.targetType}_${record.targetId}`);
      if (!target) continue;
      const applicant = applicantMap.get(target.userId ?? target.applicantId ?? 0) ?? null;
      const instance = instanceMap.get(`${record.targetType}_${record.targetId}`) ?? null;
      const item = await this.buildListItem(record.targetType as TargetType, target, instance, applicant);
      item.status = target.status;
      item.ccFrom = record.comment?.replace(' 抄送给您传阅', '') || '未知';
      item.ccAt = record.createdAt;
      list.push(item);
    }

    return { list, total, page, pageSize };
  }

  private async buildApprovalContent(targetType: string, targetId: number, target: ApprovalTargetLike) {
    const applicant = await this.userRepo.findOne({
      where: { id: target.userId ?? target.applicantId },
      relations: ['department', 'group'],
    });

    const content: any = {
      targetType,
      targetId,
      status: target.status,
      currentStep: target.currentStep || 0,
      totalSteps: target.totalSteps || 0,
      applicant: applicant ? {
        id: applicant.id,
        name: applicant.realName,
        department: applicant.department?.name,
        group: applicant.group?.name,
      } : null,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
    };

    if (targetType === 'timesheet') {
      const ts = await this.timesheetRepo.findOne({ where: { id: targetId }, relations: ['project'] });
      if (ts?.previousGroupId) {
        const prevRecord = await this.timesheetRepo.findOne({ where: { submissionGroupId: ts.previousGroupId } });
        if (prevRecord) content.previousApproval = { targetId: prevRecord.id, submissionGroupId: ts.previousGroupId };
      }

      if (ts?.submissionGroupId) {
        const groupRecords = await this.timesheetRepo.find({
          where: { submissionGroupId: ts.submissionGroupId },
          relations: ['project'],
          order: { date: 'ASC' },
        });
        const project = groupRecords[0]?.project || ts.project;
        const dates = groupRecords.map(record => record.date);
        content.project = project ? { id: project.id, name: project.name } : null;
        content.date = dates[0] || ts.date;
        content.weekStart = dates[0] || ts.date;
        content.weekEnd = dates[dates.length - 1] || ts.date;
        content.days = round2(groupRecords.reduce((sum, record) => sum + Number(record.days), 0));
        content.description = groupRecords[0]?.description || ts.description;
        content.submissionGroupId = ts.submissionGroupId;
        content.weekEntries = groupRecords.map(record => ({ date: record.date, days: Number(record.days) }));
      } else {
        content.date = ts?.date;
        content.days = ts?.days;
        content.description = ts?.description;
        content.project = ts?.project ? { id: ts.project.id, name: ts.project.name } : null;
      }

      // 工时配额信息：
      // - 审批中（submitted）：动态计算（其他人可能同时在提交，消耗实时变化）
      // - 已通过/已驳回/已撤销：展示审批通过时冻结的快照（不再动态更新）
      if (content.status === 'submitted') {
        const projectId = content.project?.id ?? ts?.projectId;
        const groupId = applicant?.group?.id;
        if (projectId && groupId) {
          content.quota = await this.buildTimesheetQuota(projectId, groupId, Number(content.days) || 0);
        }
      } else {
        // 读取审批通过时冻结的配额快照
        const instance = await this.getTargetInstance('timesheet', target, targetId);
        content.quota = instance?.quotaSnapshot ?? null;
      }
    } else if (targetType === 'overtime') {
      const overtime = await this.overtimeRepo.findOne({ where: { id: targetId }, relations: ['project'] });
      content.date = target.date;
      content.days = target.days;
      content.overtimeType = target.overtimeType;
      content.reason = target.reason;
      content.project = overtime?.project ? { id: overtime.project.id, name: overtime.project.name } : null;
    } else if (targetType === 'weekly_report') {
      content.weekStart = target.weekStart;
      content.weekEnd = target.weekEnd;
      content.totalDays = target.totalDays;
      content.content = target.content;
      content.summary = target.summary;
    } else if (targetType === 'permission_request') {
      content.permissionCode = target.permissionCode;
      content.permissionName = target.permissionName;
      content.scopeType = target.scopeType;
      content.scopeId = target.scopeId;
      content.scopeName = target.scopeName;
      content.reason = target.reason;
      content.expiresAt = target.expiresAt;
      content.grantId = target.grantId;
    }

    return content;
  }

  /**
   * 计算工时配额消耗情况（动态，每次打开审批单实时查询）。
   *
   * 配额向上继承：从用户所在组开始，沿 parent 链向上查找，直到找到配额配置为止。
   *   如配额配在「蜂窝通信组」，用户在「通话组」（子组），则使用「蜂窝通信组」的配额。
   * 消耗统计范围：配额组及其所有子组的成员（配额配在父组，则父组+所有子孙组成员的工时都算消耗）。
   *
   * @param projectId 项目 ID
   * @param groupId  申请人所在组 ID
   * @param submittedHours 本次提交的工时（人/天）
   * @returns 配额信息对象；若该组及其所有祖先组在该项目都没配过配额则返回 null（不限制）
   */
  private async buildTimesheetQuota(
    projectId: number,
    groupId: number,
    submittedHours: number,
  ): Promise<{
    total: number;
    consumed: number;
    remaining: number;
    submitted: number;
    exceeded: boolean;
    groupName?: string;
  } | null> {
    // 1. 沿组层级向上查找配额配置（与 module_se 审批步骤同样的向上继承逻辑）
    //    visited 集合 + 深度上限防止组 parent 链出现循环引用（互指）时无限循环。
    let allocation: { allocation: number; groupId: number; groupName: string } | null = null;
    let searchGroupId: number | null = groupId;
    const visited = new Set<number>();
    const MAX_DEPTH = 32;
    let depth = 0;
    while (searchGroupId) {
      if (visited.has(searchGroupId) || depth++ > MAX_DEPTH) break; // 检测到循环引用或超出深度，终止
      visited.add(searchGroupId);
      const found = await this.allocationRepo.findOne({
        where: { projectId, groupId: searchGroupId },
        relations: ['group'],
      });
      if (found) {
        allocation = {
          allocation: Number(found.allocation),
          groupId: found.groupId,
          groupName: found.group?.name || found.groupName || '',
        };
        break;
      }
      // 向上一级
      const group = await this.groupRepo.findOne({
        where: { id: searchGroupId },
        relations: ['parent'],
      });
      searchGroupId = group?.parent?.id ?? null;
    }
    if (!allocation) return null; // 该组及所有祖先组都没配额 = 不限制

    // 2. 收集配额组及其所有子组的 id（配额配在父组，子组成员也消耗）
    //    利用 Group.path 字段：子组的 path 以配额组的 path 为前缀。
    //    path 格式如 "1/3/7"，配额组 path="3"，则所有 path LIKE "3/%" 或 path="3" 的组都是其子组（含自身）。
    const quotaGroup = await this.groupRepo.findOne({ where: { id: allocation.groupId } });
    const quotaGroupIds: number[] = [allocation.groupId];
    if (quotaGroup?.path) {
      // path LIKE "quotaPath/%" 匹配所有子孙组；path = quotaPath 匹配自身（已在数组里）
      const childGroups = await this.groupRepo
        .createQueryBuilder('g')
        .where('g.path LIKE :prefix', { prefix: `${quotaGroup.path}/%` })
        .select('g.id', 'id')
        .getRawMany<{ id: number }>();
      quotaGroupIds.push(...childGroups.map((g) => g.id));
    }

    // 3. 动态查询配额组及其所有子组成员在该项目的已消耗工时（submitted + approved）
    // 去重保证：timesheets 上的部分唯一索引 (userId,projectId,date) WHERE 活跃 确保同一用户+项目+日期
    // 只有一条活跃记录，故 SUM 不会因并发重复提交而双计（历史重复数据会在该索引创建时被暴露）。
    // 查询配额组全部成员的活跃工时记录，在 JS 内按 (userId, projectId, date) 取最新版本去重后求和。
    // 原因：审批窗口期旧 approved 版本会保留到新版本通过（submitByRows 不再提交时立即废弃），
    // 若直接 SUM 会把「同一工时的新旧两个版本」双计；按最新 submissionGroupId 只计一次。
    const activeRows = await this.timesheetRepo
      .createQueryBuilder('t')
      .innerJoin('users', 'u', 'u.id = t.userId')
      .where('t.projectId = :projectId', { projectId })
      .andWhere(`u.groupId IN (${quotaGroupIds.map((_, i) => `:gid${i}`).join(',')})`,
        Object.fromEntries(quotaGroupIds.map((id, i) => [`gid${i}`, id])))
      .andWhere('t.status IN (:...statuses)', { statuses: ['submitted', 'approved'] })
      // 显式别名：Postgres 下无别名 select(['t.userId']) 的 raw 列名带表前缀（t_userId），
      // 直接取 r.userId 会得到 undefined，导致版本去重与求和全部失效。
      .select('t.userId', 'userId')
      .addSelect('t.projectId', 'projectId')
      .addSelect('t.date', 'date')
      .addSelect('t.days', 'days')
      .addSelect('t.submissionGroupId', 'submissionGroupId')
      .getRawMany<{ userId: number; projectId: number; date: string; days: string | number; submissionGroupId: number | null }>();
    // 版本去重与求和统一走公共口径（utils/timesheetConsumption），与报表超投统计保持一致
    const consumed = sumConsumption(activeRows);
    const total = round2(allocation.allocation);
    const remaining = round2(total - consumed);
    return {
      total,
      consumed,
      remaining,
      submitted: round2(submittedHours),
      exceeded: consumed > total,
      groupName: allocation.groupName,
    };
  }

  /**
   * 冻结工时配额快照到审批实例。在终态（通过/驳回/撤回）时调用，
   * 把当时的动态配额值写入 instance.quotaSnapshot，之后查看时展示此快照不再动态更新。
   */
  private async freezeTimesheetQuotaSnapshot(
    instanceId: number,
    submissionGroupId: number,
    applicantUserId: number,
  ): Promise<void> {
    const ts = await this.timesheetRepo.findOne({
      where: { submissionGroupId },
      relations: ['project'],
    });
    const applicantUser = await this.userRepo.findOne({
      where: { id: applicantUserId },
      relations: ['group'],
    });
    if (!ts?.projectId || !applicantUser?.group?.id) return;
    const weekRecords = await this.timesheetRepo.find({ where: { submissionGroupId } });
    const weekDays = weekRecords.reduce((sum, r) => sum + Number(r.days), 0);
    const quotaSnapshot = await this.buildTimesheetQuota(
      ts.projectId,
      applicantUser.group.id,
      weekDays,
    );
    await this.instanceRepo.update(instanceId, { quotaSnapshot });
  }

  private buildFlowSteps(instance: ApprovalInstance | null, tasks: ApprovalTask[]) {
    if (!instance) return [];
    return instance.stepsSnapshot.map(step => {
      const stepTasks = tasks.filter(task => task.stepOrder === step.stepOrder);
      const rejectedTask = stepTasks.find(task => task.status === 'rejected');
      const approvedTask = stepTasks.find(task => task.status === 'approved');
      const withdrawnTask = stepTasks.find(task => task.status === 'withdrawn');
      const skippedTask = stepTasks.find(task => task.status === 'skipped');
      const actedTask = rejectedTask ?? approvedTask ?? withdrawnTask ?? skippedTask;
      let status: 'pending' | 'current' | 'approved' | 'rejected' | 'skipped' | 'withdrawn' = 'pending';

      if (rejectedTask) status = 'rejected';
      else if (instance.status === 'withdrawn' && withdrawnTask) status = 'withdrawn';
      // 会签中已有部分人通过时，整步仍是“当前步骤”，不能提前展示为已通过。
      else if (instance.status === 'pending' && instance.currentStepOrder === step.stepOrder) status = 'current';
      else if (approvedTask || instance.status === 'approved') status = 'approved';
      else if (skippedTask) status = 'skipped';

      // 每个审批人的独立状态（A9：区分实际处理人 / skipped / pending，避免或签下误导）
      const approverStatuses = step.approvers.map(approver => {
        const t = stepTasks.find(task => task.approverId === approver.id);
        return {
          id: approver.id,
          name: approver.name,
          status: t?.status || 'pending',
          action: t?.action || null,
          comment: t?.comment || null,
          actedAt: t?.actedAt || null,
        };
      });

      return {
        stepOrder: step.stepOrder,
        sourceStepOrder: step.sourceStepOrder,
        stepType: step.stepType,
        label: step.label,
        approverIds: step.approvers.map(approver => approver.id),
        approverNames: step.approvers.map(approver => approver.name),
        approverStatuses,
        requireAllApprovers: step.requireAllApprovers,
        status,
        action: actedTask?.action || null,
        comment: actedTask?.comment || null,
        approverName: actedTask?.actedByName || actedTask?.approverName || step.approvers.map(approver => approver.name).join('、'),
        approvedAt: actedTask?.actedAt || null,
      };
    });
  }

  async getApprovalDetail(targetType: string, targetId: number, viewerId?: number) {
    const { target } = await this.getTargetInfo(targetType, targetId);
    if (!target) throw new BusinessError('记录不存在');

    const records = await this.recordRepo.find({
      where: { targetType: targetType as TargetType, targetId },
      order: { createdAt: 'ASC' },
    });

    if (viewerId && !await this.canViewApprovalTarget(targetType, target, targetId, viewerId, records)) {
      throw new BusinessError('无权查看该审批详情');
    }

    const instance = await this.getTargetInstance(targetType, target, targetId);
    const tasks = instance ? await this.approvalInstanceService.getTasksForInstance(instance.id) : [];
    const content = await this.buildApprovalContent(targetType, targetId, target);
    const flowSteps = this.buildFlowSteps(instance, tasks);
    const viewerIsAdmin = viewerId ? await this.isAdminUser(viewerId) : false;

    return {
      content,
      flowSteps,
      records: records.map(record => ({
        stepOrder: record.stepOrder,
        stepType: record.stepType,
        stepLabel: record.stepLabel,
        approverId: record.approverId,
        approverName: record.approverName,
        action: record.action,
        comment: record.comment,
        createdAt: record.createdAt,
      })),
      viewerContext: viewerId ? {
        isApplicant: (target.userId ?? target.applicantId) === viewerId,
        isCurrentApprover: target.status === 'submitted' && await this.approvalInstanceService.userHasPendingTask(targetType, targetId, viewerId),
        isAdmin: viewerIsAdmin,
        isCcRecipient: records.some(record => record.action === 'cc' && record.approverId === viewerId),
      } : undefined,
    };
  }
}
