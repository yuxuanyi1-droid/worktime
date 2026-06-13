import { AppDataSource } from '../config/database';
import { ApprovalRecord } from '../entities/ApprovalRecord';
import { Timesheet } from '../entities/Timesheet';
import { OvertimeApplication } from '../entities/OvertimeApplication';
import { WeeklyReport } from '../entities/WeeklyReport';
import { User } from '../entities/User';
import { ApprovalTask } from '../entities/ApprovalTask';
import { ApprovalInstance } from '../entities/ApprovalInstance';
import { ApprovalInstanceService } from './approvalInstanceService';
import { NotificationService } from './notificationService';
import { PermissionRequest } from '../entities/PermissionRequest';
import { PermissionGovernanceService } from './permissionGovernanceService';

type TargetType = 'timesheet' | 'overtime' | 'weekly_report' | 'permission_request';

export class ApprovalService {
  private recordRepo = AppDataSource.getRepository(ApprovalRecord);
  private timesheetRepo = AppDataSource.getRepository(Timesheet);
  private overtimeRepo = AppDataSource.getRepository(OvertimeApplication);
  private weeklyReportRepo = AppDataSource.getRepository(WeeklyReport);
  private permissionRequestRepo = AppDataSource.getRepository(PermissionRequest);
  private userRepo = AppDataSource.getRepository(User);
  private approvalInstanceService = new ApprovalInstanceService();
  private notificationService = new NotificationService();
  private permissionGovernanceService = new PermissionGovernanceService();

  private async isAdminUser(userId: number): Promise<boolean> {
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: ['roles'] });
    return (user?.roles?.map(role => role.name) ?? []).includes('admin');
  }

  private async getTargetInfo(targetType: string, targetId: number) {
    let target: any = null;
    let repo: any = null;

    if (targetType === 'timesheet') {
      target = await this.timesheetRepo.findOne({ where: { id: targetId } });
      repo = this.timesheetRepo;
    } else if (targetType === 'overtime') {
      target = await this.overtimeRepo.findOne({ where: { id: targetId } });
      repo = this.overtimeRepo;
    } else if (targetType === 'weekly_report') {
      target = await this.weeklyReportRepo.findOne({ where: { id: targetId } });
      repo = this.weeklyReportRepo;
    } else if (targetType === 'permission_request') {
      target = await this.permissionRequestRepo.findOne({ where: { id: targetId } });
      repo = this.permissionRequestRepo;
    }

    return {
      target,
      applicantId: target?.userId ?? target?.applicantId ?? 0,
      repo,
      projectId: target?.projectId,
    };
  }

  private async getTargetInstance(targetType: string, target: any, targetId: number) {
    if (target?.approvalInstanceId) {
      const byId = await this.approvalInstanceService.getInstanceById(target.approvalInstanceId);
      if (byId) return byId;
    }
    return this.approvalInstanceService.getLatestInstance(targetType, targetId);
  }

  private async canViewApprovalTarget(targetType: string, target: any, targetId: number, viewerId: number, records?: ApprovalRecord[]) {
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

  private async buildListItem(targetType: TargetType, target: any, instance: ApprovalInstance | null, applicant?: User | null) {
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
        base.hours = groupRecords.reduce((sum, record) => sum + Number(record.hours), 0);
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
    const tasks = await this.approvalInstanceService.getPendingTasks(approverId, { targetType, isAdmin });
    const results: any[] = [];

    for (const task of tasks) {
      if (task.instance?.applicantId === approverId) continue;
      const { target } = await this.getTargetInfo(task.targetType, task.targetId);
      if (!target || target.status !== 'submitted') continue;

      const applicant = await this.userRepo.findOne({
        where: { id: target.userId ?? target.applicantId },
        relations: ['department', 'group'],
      });
      const item = await this.buildListItem(task.targetType as TargetType, target, task.instance, applicant);
      item.taskId = task.id;
      results.push(item);
    }

    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const total = results.length;
    const list = results.slice((page - 1) * pageSize, page * pageSize);
    return { list, total, page, pageSize };
  }

  async approve(approverId: number, approverName: string, items: { targetType: string; targetId: number; action: 'approve' | 'reject'; comment?: string }[]) {
    const isAdmin = await this.isAdminUser(approverId);

    for (const item of items) {
      const { target, repo, applicantId } = await this.getTargetInfo(item.targetType, item.targetId);
      if (!target) throw new Error(`${item.targetType} record ${item.targetId} not found`);
      if (target.status !== 'submitted') throw new Error(`记录 ${item.targetId} 不是待审批状态`);

      const result = await this.approvalInstanceService.act({
        targetType: item.targetType,
        targetId: item.targetId,
        approverId,
        approverName,
        action: item.action,
        comment: item.comment,
        isAdmin,
      });

      await this.recordRepo.save(this.recordRepo.create({
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
        await this.timesheetRepo.update({ submissionGroupId: target.submissionGroupId }, updateData);
        if (item.action === 'approve' && result.status === 'approved' && target.previousGroupId) {
          await this.timesheetRepo.update(
            { submissionGroupId: target.previousGroupId, userId: target.userId },
            { status: 'deprecated' },
          );
        }
      } else if (item.targetType === 'permission_request') {
        if (result.status === 'approved') {
          const grant = await this.permissionGovernanceService.activateGrant(item.targetId, result.instance.id, {
            id: approverId,
            name: approverName,
          });
          await this.permissionRequestRepo.update(item.targetId, { ...updateData, grantId: grant.id });
        } else if (result.status === 'rejected') {
          await this.permissionGovernanceService.markRejected(item.targetId);
        } else {
          await this.permissionGovernanceService.markSubmitted(item.targetId, result.instance.currentStepOrder || 0);
        }
      } else {
        await repo.update(item.targetId, updateData);
      }

      try {
        if (item.action === 'reject') {
          await this.notificationService.notifyApprovalResult(applicantId, item.targetType, item.targetId, false, item.comment);
        } else if (result.status === 'approved') {
          await this.notificationService.notifyApprovalResult(applicantId, item.targetType, item.targetId, true);
        } else if (result.nextApproverIds.length) {
          await this.notificationService.notifyApprovalPending(
            result.nextApproverIds,
            item.targetType,
            item.targetId,
            approverName,
            `审批流转至步骤${result.instance.currentStepOrder}`,
          );
        }
      } catch {}
    }

    return { success: true };
  }

  async getMySubmissions(userId: number, params: { targetType?: string; status?: string; page?: number; pageSize?: number }) {
    const { targetType, status, page = 1, pageSize = 20 } = params;
    const results: any[] = [];

    if (!targetType || targetType === 'timesheet') {
      const items = await this.timesheetRepo
        .createQueryBuilder('t')
        .leftJoinAndSelect('t.project', 'p')
        .where('t.userId = :userId', { userId })
        .andWhere('t.status != :deprecated', { deprecated: 'deprecated' })
        .getMany();

      const seenGroups = new Set<number>();
      for (const item of items) {
        if (status && item.status !== status) continue;
        if (item.submissionGroupId) {
          if (seenGroups.has(item.submissionGroupId)) continue;
          seenGroups.add(item.submissionGroupId);
        }
        const instance = await this.getTargetInstance('timesheet', item, item.id);
        results.push(await this.buildListItem('timesheet', item, instance, item.user));
      }
    }

    if (!targetType || targetType === 'overtime') {
      const where: any = { userId };
      if (status) where.status = status;
      const items = await this.overtimeRepo.find({ where });
      for (const item of items) {
        const instance = await this.getTargetInstance('overtime', item, item.id);
        results.push(await this.buildListItem('overtime', item, instance));
      }
    }

    if (!targetType || targetType === 'weekly_report') {
      const where: any = { userId };
      if (status) where.status = status;
      const items = await this.weeklyReportRepo.find({ where });
      for (const item of items) {
        const instance = await this.getTargetInstance('weekly_report', item, item.id);
        results.push(await this.buildListItem('weekly_report', item, instance));
      }
    }

    if (!targetType || targetType === 'permission_request') {
      const where: any = { applicantId: userId };
      if (status) where.status = status;
      const items = await this.permissionRequestRepo.find({ where });
      const applicant = await this.userRepo.findOne({ where: { id: userId }, relations: ['department', 'group'] });
      for (const item of items) {
        const instance = await this.getTargetInstance('permission_request', item, item.id);
        results.push(await this.buildListItem('permission_request', item, instance, applicant));
      }
    }

    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const total = results.length;
    const list = results.slice((page - 1) * pageSize, page * pageSize);
    return { list, total, page, pageSize };
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
    const list: ApprovalRecord[] = [];
    const permissionCache = new Map<string, boolean>();

    for (const record of records) {
      const key = `${record.targetType}_${record.targetId}`;
      let canView = permissionCache.get(key);
      if (canView === undefined) {
        const { target } = await this.getTargetInfo(record.targetType, record.targetId);
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
    const { target, repo } = await this.getTargetInfo(targetType, targetId);
    if (!target) throw new Error('记录不存在');
    if ((target.userId ?? target.applicantId) !== userId) throw new Error('只能撤回自己的申请');
    if (target.status !== 'submitted') throw new Error('只能撤回审批中的申请');

    const submitter = await this.userRepo.findOneBy({ id: userId });
    const instance = await this.approvalInstanceService.withdraw(targetType, targetId, userId, submitter?.realName || '');
    await this.recordRepo.save(this.recordRepo.create({
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
      status: targetType === 'permission_request' ? 'withdrawn' : 'draft',
      currentStep: 0,
      approvalFlowId: null,
      approvalInstanceId: null,
      totalSteps: 0,
    };
    if (targetType === 'timesheet' && target.submissionGroupId) {
      await this.timesheetRepo.update({ submissionGroupId: target.submissionGroupId }, updateData);
    } else {
      await repo.update(targetId, updateData);
    }

    return { success: true };
  }

  async cc(fromUserId: number, fromUserName: string, targetType: string, targetId: number, recipientIds: number[]) {
    const { target } = await this.getTargetInfo(targetType, targetId);
    if (!target) throw new Error('记录不存在');
    if ((target.userId ?? target.applicantId) !== fromUserId) throw new Error('只能抄送自己的申请');
    const instance = await this.getTargetInstance(targetType, target, targetId);

    for (const recipientId of recipientIds) {
      const recipient = await this.userRepo.findOneBy({ id: recipientId });
      if (!recipient) continue;

      await this.recordRepo.save(this.recordRepo.create({
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
    const list: any[] = [];

    for (const record of records) {
      const { target } = await this.getTargetInfo(record.targetType, record.targetId);
      if (!target) continue;
      const applicant = await this.userRepo.findOne({ where: { id: target.userId ?? target.applicantId }, relations: ['department'] });
      const item = await this.buildListItem(record.targetType as TargetType, target, await this.getTargetInstance(record.targetType, target, record.targetId), applicant);
      item.status = target.status;
      item.ccFrom = record.comment?.replace(' 抄送给您传阅', '') || '未知';
      item.ccAt = record.createdAt;
      list.push(item);
    }

    return { list, total, page, pageSize };
  }

  private async buildApprovalContent(targetType: string, targetId: number, target: any) {
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
        content.hours = groupRecords.reduce((sum, record) => sum + Number(record.hours), 0);
        content.description = groupRecords[0]?.description || ts.description;
        content.submissionGroupId = ts.submissionGroupId;
        content.weekEntries = groupRecords.map(record => ({ date: record.date, hours: Number(record.hours) }));
      } else {
        content.date = ts?.date;
        content.hours = ts?.hours;
        content.description = ts?.description;
        content.project = ts?.project ? { id: ts.project.id, name: ts.project.name } : null;
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

      return {
        stepOrder: step.stepOrder,
        sourceStepOrder: step.sourceStepOrder,
        stepType: step.stepType,
        label: step.label,
        approverIds: step.approvers.map(approver => approver.id),
        approverNames: step.approvers.map(approver => approver.name),
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
    if (!target) throw new Error('记录不存在');

    const records = await this.recordRepo.find({
      where: { targetType: targetType as TargetType, targetId },
      order: { createdAt: 'ASC' },
    });

    if (viewerId && !await this.canViewApprovalTarget(targetType, target, targetId, viewerId, records)) {
      throw new Error('无权查看该审批详情');
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
