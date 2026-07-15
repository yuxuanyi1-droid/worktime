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
import { NotificationService } from './notificationService';
import { PermissionRequest } from '../entities/PermissionRequest';
import { PermissionGovernanceService } from './permissionGovernanceService';
import { ProjectWorkloadAllocation } from '../entities/ProjectWorkloadAllocation';
import { BusinessError } from '../utils/errors';
import { round2 } from '../utils/validation';

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
  hours?: number;
  overtimeType?: string;
  reason?: string;
  weekStart?: string;
  weekEnd?: string;
  totalHours?: number;
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

export class ApprovalService {
  constructor(private manager?: EntityManager) {}

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
  private get notificationService() { return new NotificationService(this.manager); }
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
      applicant: applicant?.realName,
      applicantId: applicant?.id,
      department: applicant?.department?.name,
      currentStep: target.currentStep,
      totalSteps: target.totalSteps,
      createdAt: instance?.submittedAt || target.updatedAt || target.createdAt,
    };

    if (targetType === 'timesheet') {
      const ts = await this.timesheetRepo.findOne({ where: { id: target.id }, relations: ['project'] });
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
        base.hours = round2(groupRecords.reduce((sum, record) => sum + Number(record.hours), 0));
        base.description = groupRecords[0]?.description;
        base.projectId = ts.projectId;
        base.submissionGroupId = ts.submissionGroupId;
      } else {
        base.title = `${applicantPrefix}${ts?.project?.name || ''} - ${ts?.date || ''}`;
        base.date = ts?.date;
        base.hours = ts?.hours;
        base.description = ts?.description;
        base.projectId = ts?.projectId;
      }
    } else if (targetType === 'overtime') {
      base.title = `${applicantPrefix}${target.date} 加班申请`;
      base.date = target.date;
      base.hours = target.hours;
      base.overtimeType = target.overtimeType;
      base.reason = target.reason;
    } else if (targetType === 'weekly_report') {
      base.title = `${applicantPrefix}${target.weekStart}~${target.weekEnd} 周报`;
      base.weekStart = target.weekStart;
      base.weekEnd = target.weekEnd;
      base.totalHours = target.totalHours;
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
    // 拿到全部待办任务（已按 instance 去重），过滤掉自己提交的
    const allTasks = (await this.approvalInstanceService.getPendingTasks(approverId, { targetType, isAdmin }))
      .filter(task => task.instance?.applicantId !== approverId);

    const total = allTasks.length;
    // 先取当前页的任务再组装，避免组装全部记录
    const pageTasks = allTasks.slice((page - 1) * pageSize, page * pageSize);

    // 批量加载 target：按 targetType 分组，用 In(...) 一次性取，避免 N+1
    const tasksByType = new Map<string, typeof pageTasks>();
    for (const task of pageTasks) {
      const bucket = tasksByType.get(task.targetType) ?? [];
      bucket.push(task);
      tasksByType.set(task.targetType, bucket);
    }

    const targetMap = new Map<string, any>();
    for (const [type, bucket] of tasksByType) {
      const ids = bucket.map(t => t.targetId);
      const repo = this.getRepoByTargetType(type);
      if (repo && ids.length) {
        const found = await repo.find({ where: { id: In(ids) } as any });
        for (const t of found) targetMap.set(`${type}_${t.id}`, t);
      }
    }

    // 批量加载 applicant：收集所有 applicantId 一次性查
    const applicantIds = new Set<number>();
    for (const task of pageTasks) {
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
    for (const task of pageTasks) {
      const target = targetMap.get(`${task.targetType}_${task.targetId}`);
      if (!target || target.status !== 'submitted') continue;
      const applicant = applicantMap.get(target.userId ?? target.applicantId) ?? null;
      const item = await this.buildListItem(task.targetType as TargetType, target, task.instance, applicant);
      item.taskId = task.id;
      results.push(item);
    }

    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { list: results, total, page, pageSize };
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
    const isAdmin = await this.isAdminUser(approverId);
    const notifications: PendingNotification[] = [];

    await AppDataSource.transaction(async (manager) => {
      const txService = new ApprovalService(manager);

      for (const item of items) {
        const { target, repo, applicantId } = await txService.getTargetInfo(item.targetType, item.targetId);
        if (!target) throw new BusinessError(`${item.targetType} record ${item.targetId} not found`);
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

        if (item.targetType === 'timesheet' && target.submissionGroupId) {
          await txService.timesheetRepo.update({ submissionGroupId: target.submissionGroupId }, updateData);
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
          // 终态（通过/驳回）时冻结配额快照：把当前的动态配额值写入 instance.quotaSnapshot，
          // 之后查看已通过/已驳回的单子展示此快照（不再动态更新），作为审批内容的永久记录。
          if (result.status === 'approved' || result.status === 'rejected') {
            await txService.freezeTimesheetQuotaSnapshot(
              result.instance.id,
              target.submissionGroupId,
              applicantId,
            );
          }
        } else if (item.targetType === 'permission_request') {
          if (result.status === 'approved') {
            const grant = await txService.permissionGovernanceService.activateGrant(item.targetId, result.instance.id, {
              id: approverId,
              name: approverName,
            });
            await txService.permissionRequestRepo.update(item.targetId, { ...updateData, grantId: grant.id });
          } else if (result.status === 'rejected') {
            await txService.permissionGovernanceService.markRejected(item.targetId);
          } else {
            await txService.permissionGovernanceService.markSubmitted(item.targetId, result.instance.currentStepOrder || 0);
          }
        } else {
          await repo!.update(item.targetId, updateData);
        }

        if (item.action === 'reject') {
          notifications.push({ kind: 'result', applicantId, targetType: item.targetType, targetId: item.targetId, approved: false, comment: item.comment });
        } else if (result.status === 'approved') {
          notifications.push({ kind: 'result', applicantId, targetType: item.targetType, targetId: item.targetId, approved: true });
        } else if (result.nextApproverIds.length) {
          notifications.push({
            kind: 'pending',
            approverIds: result.nextApproverIds,
            targetType: item.targetType,
            targetId: item.targetId,
            applicantName: approverName,
            title: `审批流转至步骤${result.instance.currentStepOrder}`,
          });
        }
      }
    });

    await this.flushNotifications(notifications);
    return { success: true };
  }

  /** 事务提交后统一发送通知（失败不影响业务） */
  private async flushNotifications(notifications: PendingNotification[]) {
    const notifier = new NotificationService();
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
    const results: any[] = [];

    if (!targetType || targetType === 'timesheet') {
      const qb = this.timesheetRepo
        .createQueryBuilder('t')
        .leftJoinAndSelect('t.project', 'p')
        .leftJoinAndSelect('t.user', 'u')
        .where('t.userId = :userId', { userId })
        .andWhere('t.status != :deprecated', { deprecated: 'deprecated' });
      if (startDate && endDate) qb.andWhere('t.date BETWEEN :startDate AND :endDate', { startDate, endDate });
      const items = await qb.getMany();

      const seenGroups = new Set<number>();
      const dedupItems: typeof items = [];
      for (const item of items) {
        if (status && item.status !== status) continue;
        if (item.submissionGroupId) {
          if (seenGroups.has(item.submissionGroupId)) continue;
          seenGroups.add(item.submissionGroupId);
        }
        dedupItems.push(item);
      }
      const instanceMap = await this.batchInstances('timesheet', dedupItems);
      for (const item of dedupItems) {
        results.push(await this.buildListItem('timesheet', item, instanceMap.get(item.id) ?? null, item.user));
      }
    }

    if (!targetType || targetType === 'overtime') {
      const where: any = { userId };
      if (status) where.status = status;
      let items = await this.overtimeRepo.find({ where });
      if (startDate && endDate) items = items.filter(i => i.date >= startDate && i.date <= endDate);
      const instanceMap = await this.batchInstances('overtime', items);
      for (const item of items) {
        results.push(await this.buildListItem('overtime', item, instanceMap.get(item.id) ?? null));
      }
    }

    if (!targetType || targetType === 'weekly_report') {
      const where: any = { userId };
      if (status) where.status = status;
      let items = await this.weeklyReportRepo.find({ where });
      if (startDate && endDate) items = items.filter(i => i.weekStart >= startDate && i.weekStart <= endDate);
      const instanceMap = await this.batchInstances('weekly_report', items);
      for (const item of items) {
        results.push(await this.buildListItem('weekly_report', item, instanceMap.get(item.id) ?? null));
      }
    }

    if (!targetType || targetType === 'permission_request') {
      const where: any = { applicantId: userId };
      if (status) where.status = status;
      const items = await this.permissionRequestRepo.find({ where });
      const applicant = await this.userRepo.findOne({ where: { id: userId }, relations: ['department', 'group'] });
      const instanceMap = await this.batchInstances('permission_request', items);
      for (const item of items) {
        results.push(await this.buildListItem('permission_request', item, instanceMap.get(item.id) ?? null, applicant));
      }
    }

    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const total = results.length;
    const list = results.slice((page - 1) * pageSize, page * pageSize);
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

  async getApprovalHistory(params: { targetType?: string; targetId?: number; page?: number; pageSize?: number; viewerId: number; mine?: boolean }) {
    const { targetType, targetId, page = 1, pageSize = 20, viewerId, mine } = params;
    const qb = this.recordRepo.createQueryBuilder('r');
    if (targetType) qb.andWhere('r.targetType = :targetType', { targetType });
    if (targetId) qb.andWhere('r.targetId = :targetId', { targetId });
    if (mine) {
      qb.andWhere('r.approverId = :viewerId', { viewerId });
      qb.andWhere('r.action IN (:...actions)', { actions: ['approve', 'reject'] });
    }

    qb.orderBy('r.createdAt', 'DESC');
    const records = await qb.getMany();

    // 批量预取所有 target：按 targetType 分组用 In(...) 一次查，避免逐条 getTargetInfo
    const targetIdsByType = new Map<string, Set<number>>();
    for (const record of records) {
      const bucket = targetIdsByType.get(record.targetType) ?? new Set<number>();
      bucket.add(record.targetId);
      targetIdsByType.set(record.targetType, bucket);
    }
    const targetMap = new Map<string, any>();
    for (const [type, idSet] of targetIdsByType) {
      const ids = [...idSet];
      const repo = this.getRepoByTargetType(type);
      if (repo && ids.length) {
        const found = await repo.find({ where: { id: In(ids) } as any });
        for (const t of found) targetMap.set(`${type}_${t.id}`, t);
      }
    }

    const list: ApprovalRecord[] = [];
    const permissionCache = new Map<string, boolean>();

    for (const record of records) {
      const key = `${record.targetType}_${record.targetId}`;
      let canView = permissionCache.get(key);
      if (canView === undefined) {
        const target = targetMap.get(key);
        canView = !!target && await this.canViewApprovalTarget(record.targetType, target, record.targetId, viewerId, records.filter(r => r.targetType === record.targetType && r.targetId === record.targetId));
        permissionCache.set(key, canView);
      }
      if (canView) list.push(record);
    }

    const total = list.length;
    const pagedList = list.slice((page - 1) * pageSize, page * pageSize);
    return { list: pagedList, total, page, pageSize };
  }

  async withdraw(userId: number, targetType: string, targetId: number) {
    await AppDataSource.transaction(async (manager) => {
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
        await txService.timesheetRepo.update({ submissionGroupId: target.submissionGroupId }, updateData);
      } else {
        await repo!.update(targetId, updateData);
      }
    });

    return { success: true };
  }

  async cc(fromUserId: number, fromUserName: string, targetType: string, targetId: number, recipientIds: number[]) {
    await AppDataSource.transaction(async (manager) => {
      const txService = new ApprovalService(manager);
      const { target } = await txService.getTargetInfo(targetType, targetId);
      if (!target) throw new BusinessError('记录不存在');
      if ((target.userId ?? target.applicantId) !== fromUserId) throw new BusinessError('只能抄送自己的申请');
      const instance = await txService.getTargetInstance(targetType, target, targetId);

      for (const recipientId of recipientIds) {
        const recipient = await txService.userRepo.findOneBy({ id: recipientId });
        if (!recipient) continue;

        await txService.recordRepo.save(txService.recordRepo.create({
          targetType: targetType as TargetType,
          targetId,
          instanceId: instance?.id ?? null,
          taskId: null,
          approverId: recipientId,
          approverName: recipient.realName,
          action: 'cc',
          comment: `${fromUserName} 抄送给您传阅`,
          stepOrder: 0,
          stepType: 'cc',
          stepLabel: '抄送传阅',
        }));
      }
    });

    return { success: true };
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
        const found = await repo.find({ where: { id: In(ids) } as any });
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
        content.hours = round2(groupRecords.reduce((sum, record) => sum + Number(record.hours), 0));
        content.description = groupRecords[0]?.description || ts.description;
        content.submissionGroupId = ts.submissionGroupId;
        content.weekEntries = groupRecords.map(record => ({ date: record.date, hours: Number(record.hours) }));
      } else {
        content.date = ts?.date;
        content.hours = ts?.hours;
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
          content.quota = await this.buildTimesheetQuota(projectId, groupId, Number(content.hours) || 0);
        }
      } else {
        // 读取审批通过时冻结的配额快照
        const instance = await this.getTargetInstance('timesheet', target, targetId);
        content.quota = instance?.quotaSnapshot ?? null;
      }
    } else if (targetType === 'overtime') {
      const overtime = await this.overtimeRepo.findOne({ where: { id: targetId }, relations: ['project'] });
      content.date = target.date;
      content.hours = target.hours;
      content.overtimeType = target.overtimeType;
      content.reason = target.reason;
      content.project = overtime?.project ? { id: overtime.project.id, name: overtime.project.name } : null;
    } else if (targetType === 'weekly_report') {
      content.weekStart = target.weekStart;
      content.weekEnd = target.weekEnd;
      content.totalHours = target.totalHours;
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
    let allocation: { allocation: number; groupId: number; groupName: string } | null = null;
    let searchGroupId: number | null = groupId;
    while (searchGroupId) {
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
    const consumedRaw = await this.timesheetRepo
      .createQueryBuilder('t')
      .innerJoin('users', 'u', 'u.id = t.userId')
      .where('t.projectId = :projectId', { projectId })
      .andWhere(`u.groupId IN (${quotaGroupIds.map((_, i) => `:gid${i}`).join(',')})`,
        Object.fromEntries(quotaGroupIds.map((id, i) => [`gid${i}`, id])))
      .andWhere('t.status IN (:...statuses)', { statuses: ['submitted', 'approved'] })
      .select('COALESCE(SUM(t.hours), 0)', 'total')
      .getRawOne<{ total: string | number }>();
    const consumed = round2(Number(consumedRaw?.total || 0));
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
    const weekHours = weekRecords.reduce((sum, r) => sum + Number(r.hours), 0);
    const quotaSnapshot = await this.buildTimesheetQuota(
      ts.projectId,
      applicantUser.group.id,
      weekHours,
    );
    await this.instanceRepo.update(instanceId, { quotaSnapshot });
  }

  private buildFlowSteps(instance: ApprovalInstance | null, tasks: ApprovalTask[]) {
    if (!instance) return [];
    return instance.stepsSnapshot.map(step => {
      const stepTasks = tasks.filter(task => task.stepOrder === step.stepOrder);
      const actedTask = stepTasks.find(task => task.status === 'approved' || task.status === 'rejected');
      let status: 'pending' | 'current' | 'approved' | 'rejected' = 'pending';

      if (actedTask?.status === 'approved') status = 'approved';
      else if (actedTask?.status === 'rejected') status = 'rejected';
      else if (instance.status === 'pending' && instance.currentStepOrder === step.stepOrder) status = 'current';
      else if (instance.status === 'approved') status = 'approved';

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
