import { EntityManager } from 'typeorm';
import { AppDataSource } from '../config/database';
import { Timesheet } from '../entities/Timesheet';
import { SystemSetting } from '../entities/SystemSetting';
import { SubmissionSequence } from '../entities/SubmissionSequence';
import { ApprovalRecord } from '../entities/ApprovalRecord';
import { Between, In, Not } from 'typeorm';
import { NotificationService } from './notificationService';
import { User } from '../entities/User';
import { ApprovalInstanceService } from './approvalInstanceService';
import { AccessPolicyService, OrgSnapshot } from './accessPolicyService';
import { BusinessError } from '../utils/errors';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
dayjs.extend(isoWeek);

function dayjsExt(d: string | dayjs.Dayjs) { return dayjs(d); }

/** 通知动作（事务提交后统一发送，避免长事务 & 通知失败不回滚业务） */
type PendingNotification =
  | { kind: 'pending'; approverIds: number[]; targetType: string; targetId: number; applicantName: string; title: string }
  | { kind: 'result'; applicantId: number; targetType: string; targetId: number; approved: boolean; comment?: string };

export class TimesheetService {
  constructor(private manager?: EntityManager) {}

  private get repo() { return (this.manager ?? AppDataSource).getRepository(Timesheet); }
  private get recordRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalRecord); }
  private get approvalInstanceService() { return new ApprovalInstanceService(this.manager); }
  private get accessPolicy() { return new AccessPolicyService(this.manager); }
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }
  private get settingRepo() { return (this.manager ?? AppDataSource).getRepository(SystemSetting); }
  private get seqRepo() { return (this.manager ?? AppDataSource).getRepository(SubmissionSequence); }

  private createRecord(data: Partial<Timesheet> & { userId: number }, orgSnapshot: OrgSnapshot) {
    return this.repo.create({ ...data, ...orgSnapshot });
  }

  /** 检查工时锁定 */
  private async checkTimesheetLock(dates: string[]) {
    const lockSetting = await this.settingRepo.findOne({ where: { key: 'timesheet_lock_day' } });
    if (!lockSetting?.value) return;
    const lockDay = parseInt(lockSetting.value, 10);
    if (isNaN(lockDay) || lockDay < 1 || lockDay > 28) return;
    const now = dayjs();
    const currentMonthStart = now.startOf('month');
    const previousMonthStart = currentMonthStart.subtract(1, 'month');
    for (const date of dates) {
      const d = dayjs(date);
      const isOlderThanPreviousMonth = d.isBefore(previousMonthStart, 'day');
      const isPreviousMonthAfterLockDay = d.isBefore(currentMonthStart, 'day') && now.date() > lockDay;
      if (isOlderThanPreviousMonth || isPreviousMonthAfterLockDay) {
        throw new BusinessError(`${date} 是上月的工时，每月${lockDay}号后不允许提交上月工时`);
      }
    }
  }

  async create(data: { userId: number; projectId: number; date: string; hours: number; description?: string }) {
    const orgSnapshot = await this.accessPolicy.getOrgSnapshot(data.userId);
    const record = this.createRecord(data, orgSnapshot);
    return this.repo.save(record);
  }

  async batchCreate(userId: number, items: { projectId: number; date: string; hours: number; description?: string }[]) {
    const orgSnapshot = await this.accessPolicy.getOrgSnapshot(userId);
    const records = items.map(item => this.createRecord({ ...item, userId }, orgSnapshot));
    return this.repo.save(records);
  }

  async update(id: number, userId: number, data: { projectId?: number; hours?: number; description?: string }) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new BusinessError('记录不存在');
    if (record.userId !== userId) throw new BusinessError('只能修改自己的工时记录');
    if (record.status !== 'draft') throw new BusinessError('仅草稿状态可修改');
    Object.assign(record, data);
    return this.repo.save(record);
  }

  async delete(id: number, userId: number) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new BusinessError('记录不存在');
    if (record.userId !== userId) throw new BusinessError('只能删除自己的工时记录');
    if (record.status !== 'draft') throw new BusinessError('仅草稿状态可删除');
    return this.repo.delete(id);
  }

  /** 查询用户工时列表 */
  async getByUser(userId: number, params: { startDate?: string; endDate?: string; status?: string; page?: number; pageSize?: number; includeAll?: boolean }) {
    const { startDate, endDate, status, page = 1, pageSize = 50, includeAll } = params;
    const qb = this.repo.createQueryBuilder('t')
      .leftJoinAndSelect('t.project', 'p')
      .where('t.userId = :userId', { userId });

    if (!includeAll) {
      // 去重：每个 (date, projectId) 只保留 id 最大的非废弃记录。
      // 用子查询在 SQL 层完成去重，使 total 与分页后的 list 口径一致。
      const dedupSub = this.repo.createQueryBuilder('d')
        .select('MAX(d.id)', 'maxId')
        .where('d.userId = :userId', { userId })
        .andWhere('d.status != :deprecated', { deprecated: 'deprecated' })
        .groupBy('d.date, d.projectId');
      if (startDate && endDate) dedupSub.andWhere('d.date BETWEEN :startDate AND :endDate', { startDate, endDate });
      if (status) dedupSub.andWhere('d.status = :status', { status });
      qb.andWhere(`t.id IN (${dedupSub.getQuery()})`);
      qb.setParameters({ deprecated: 'deprecated', startDate, endDate, status });
    } else {
      if (startDate && endDate) qb.andWhere('t.date BETWEEN :startDate AND :endDate', { startDate, endDate });
      if (status) qb.andWhere('t.status = :status', { status });
    }

    qb.orderBy('t.date', 'DESC');
    const total = await qb.getCount();
    const list = await qb.skip((page - 1) * pageSize).take(pageSize).getMany();
    return { list, total, page, pageSize };
  }

  /** 按日期范围查询 — 排除 deprecated，按 (date, projectId) 去重 */
  async getByDateRange(userId: number, startDate: string, endDate: string) {
    const rawRecords = await this.repo.find({
      where: { userId, date: Between(startDate, endDate), status: Not('deprecated') },
      relations: ['project'],
      order: { date: 'ASC' },
    });
    const dedupMap = new Map<string, Timesheet>();
    for (const r of rawRecords) {
      const key = `${r.date}_${r.projectId}`;
      const existing = dedupMap.get(key);
      if (!existing || r.id > existing.id) {
        dedupMap.set(key, r);
      }
    }
    return Array.from(dedupMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  /** 在事务内原子地分配下一个 submissionGroupId */
  private async nextSubmissionGroupId(): Promise<number> {
    const existing = await this.seqRepo.findOneBy({ id: 1 });
    if (!existing) {
      const maxGroup = await this.repo.createQueryBuilder('t')
        .select('MAX(t.submissionGroupId)', 'maxId')
        .getRawOne<{ maxId: number | null }>();
      const seed = maxGroup?.maxId ?? 0;
      await this.seqRepo.save(this.seqRepo.create({ id: 1, currentValue: seed }));
      return seed + 1;
    }
    await this.seqRepo.increment({ id: 1 }, 'currentValue', 1);
    const updated = await this.seqRepo.findOneBy({ id: 1 });
    return updated!.currentValue;
  }

  /** 提交审批 */
  async submit(ids: number[], userId: number) {
    if (!ids?.length) throw new BusinessError('请选择要提交的记录');

    const notifications: PendingNotification[] = [];

    await AppDataSource.transaction(async (manager) => {
      const txService = new TimesheetService(manager);
      const records = await txService.repo.findBy({ id: In(ids) });
      const orgSnapshot = await txService.accessPolicy.getOrgSnapshot(userId);
      for (const r of records) {
        if (r.userId !== userId) throw new BusinessError('只能提交自己的工时记录');
        if (r.status !== 'draft') throw new BusinessError(`记录 ${r.id} 不是草稿状态，无法提交`);
        Object.assign(r, orgSnapshot);
      }
      await txService.repo.save(records);

      const submitter = await txService.userRepo.findOneBy({ id: userId });
      for (const r of records) {
        const resolved = await txService.approvalInstanceService.start({
          targetType: 'timesheet',
          targetId: r.id,
          applicantId: userId,
          projectId: r.projectId,
        });
        if (resolved.status === 'submitted' && resolved.instance) {
          await txService.repo.update(r.id, {
            status: 'submitted',
            currentStep: resolved.instance.currentStepOrder || 1,
            approvalFlowId: resolved.instance.flowId,
            approvalInstanceId: resolved.instance.id,
            totalSteps: resolved.instance.totalSteps,
          });
          if (submitter && resolved.firstApproverIds.length) {
            notifications.push({
              kind: 'pending',
              approverIds: resolved.firstApproverIds,
              targetType: 'timesheet',
              targetId: r.id,
              applicantName: submitter.realName,
              title: `工时审批 ${r.hours}天`,
            });
          }
        } else {
          await txService.repo.update(r.id, {
            status: 'approved',
            currentStep: 0,
            totalSteps: 0,
            approvalInstanceId: resolved.instance?.id ?? null,
          });
        }
      }
    });

    await this.flushNotifications(notifications);
    return true;
  }

  /**
   * 按行提交审批（事务化，submissionGroupId 通过序列表原子分配）
   */
  async submitByRows(userId: number, rows: { projectId: number; description: string; weekStart: string; entries: { date: string; hours: number }[] }[]) {
    if (!rows?.length) throw new BusinessError('请选择要提交的记录');

    const allDates = rows.flatMap(r => r.entries.map(e => e.date));
    await this.checkTimesheetLock(allDates);

    const dailyHours: Record<string, number> = {};
    for (const row of rows) {
      for (const e of row.entries) {
        dailyHours[e.date] = (dailyHours[e.date] || 0) + e.hours;
      }
    }
    for (const [date, total] of Object.entries(dailyHours)) {
      if (total > 24) {
        throw new BusinessError(`${date} 工时合计 ${total.toFixed(1)} 小时，超过24小时上限`);
      }
    }

    const notifications: PendingNotification[] = [];

    await AppDataSource.transaction(async (manager) => {
      const txService = new TimesheetService(manager);
      const orgSnapshot = await txService.accessPolicy.getOrgSnapshot(userId);

      const weekStart = rows[0].weekStart;
      const weekEnd = dayjsExt(weekStart).add(6, 'day').format('YYYY-MM-DD');

      const existingRecords = await txService.repo.find({
        where: [
          { userId, date: Between(weekStart, weekEnd), status: 'draft' },
          { userId, date: Between(weekStart, weekEnd), status: 'rejected' },
          { userId, date: Between(weekStart, weekEnd), status: 'approved' },
          { userId, date: Between(weekStart, weekEnd), status: 'submitted' },
        ],
      });

      const recWithPrev = existingRecords.find(e => e.previousGroupId);
      const previousGroupId = recWithPrev?.previousGroupId || null;

      const projectDates = new Map<number, Set<string>>();
      const allEntryDates = new Set<string>();
      for (const row of rows) {
        const dates = new Set<string>();
        for (const e of row.entries) {
          if (e.hours > 0) {
            dates.add(e.date);
            allEntryDates.add(e.date);
          }
        }
        projectDates.set(row.projectId, dates);
      }

      const removedIds = new Set<number>();
      for (const rec of existingRecords) {
        const dates = projectDates.get(rec.projectId);
        const isInEntries = dates ? dates.has(rec.date) : allEntryDates.has(rec.date);

        if (rec.status === 'rejected') {
          if (dates && !isInEntries) {
            await txService.repo.remove(rec);
            removedIds.add(rec.id);
          }
        } else if (rec.status === 'draft') {
          if (!isInEntries) {
            if (rec.submissionGroupId) {
              rec.status = 'deprecated';
              await txService.repo.save(rec);
            } else {
              await txService.repo.remove(rec);
            }
            removedIds.add(rec.id);
          }
        } else if (rec.status === 'approved' || rec.status === 'submitted') {
          if (dates && !isInEntries) {
            rec.status = 'deprecated';
            await txService.repo.save(rec);
            removedIds.add(rec.id);
          }
        }
      }

      for (const row of rows) {
        if (!row.entries?.length) continue;

        const records: Timesheet[] = [];

        for (const entry of row.entries) {
          if (entry.hours <= 0) continue;

          const existingRec = existingRecords.find(
            d => !removedIds.has(d.id) && d.date === entry.date && d.projectId === row.projectId
          );

          if (existingRec && existingRec.status === 'draft') {
            if (existingRec.submissionGroupId) {
              const oldSubGroupId = existingRec.submissionGroupId;
              existingRec.status = 'deprecated';
              await txService.repo.save(existingRec);
              removedIds.add(existingRec.id);
              records.push(txService.createRecord({
                userId,
                projectId: row.projectId,
                date: entry.date,
                hours: entry.hours,
                description: row.description,
                previousGroupId: oldSubGroupId,
              }, orgSnapshot));
            } else {
              Object.assign(existingRec, orgSnapshot);
              existingRec.hours = entry.hours;
              existingRec.description = row.description || existingRec.description;
              records.push(existingRec);
            }
          } else if (existingRec && (existingRec.status === 'rejected' || existingRec.status === 'approved' || existingRec.status === 'submitted')) {
            const oldSubGroupId = existingRec.submissionGroupId;
            if (existingRec.status === 'submitted') {
              const submitter = await txService.userRepo.findOneBy({ id: userId });
              if (submitter) {
                await txService.approvalInstanceService.withdraw('timesheet', existingRec.id, userId, submitter.realName);
                await txService.recordRepo.save(txService.recordRepo.create({
                  targetType: 'timesheet',
                  targetId: existingRec.id,
                  instanceId: existingRec.approvalInstanceId ?? null,
                  approverId: userId,
                  approverName: submitter.realName,
                  action: 'withdraw',
                  comment: '申请人修改工时，重新提交审批',
                  stepOrder: existingRec.currentStep || 1,
                  stepType: 'withdraw',
                  stepLabel: '撤回',
                }));
              }
            }
            existingRec.status = 'deprecated';
            await txService.repo.save(existingRec);
            removedIds.add(existingRec.id);
            records.push(txService.createRecord({
              userId,
              projectId: row.projectId,
              date: entry.date,
              hours: entry.hours,
              description: row.description,
              previousGroupId: oldSubGroupId || previousGroupId,
            }, orgSnapshot));
          } else {
            records.push(txService.createRecord({
              userId,
              projectId: row.projectId,
              date: entry.date,
              hours: entry.hours,
              description: row.description,
              previousGroupId,
            }, orgSnapshot));
          }
        }

        if (records.length === 0) continue;

        const rowPrevGroup = existingRecords
          .filter(r => r.projectId === row.projectId && r.submissionGroupId
            && (r.status !== 'draft' || removedIds.has(r.id)))
          .sort((a, b) => b.id - a.id)[0];

        const nextGroupId = await txService.nextSubmissionGroupId();
        for (const r of records) {
          r.submissionGroupId = nextGroupId;
          r.previousGroupId = rowPrevGroup?.submissionGroupId || previousGroupId;
        }
        await txService.repo.save(records);

        const targetId = records[0].id;
        const resolved = await txService.approvalInstanceService.start({
          targetType: 'timesheet',
          targetId,
          applicantId: userId,
          projectId: row.projectId,
        });
        if (resolved.status === 'submitted' && resolved.instance) {
          await txService.repo.update(
            { id: In(records.map(r => r.id)) },
            {
              status: 'submitted',
              currentStep: resolved.instance.currentStepOrder || 1,
              approvalFlowId: resolved.instance.flowId,
              approvalInstanceId: resolved.instance.id,
              totalSteps: resolved.instance.totalSteps,
            },
          );
          if (resolved.firstApproverIds.length) {
            const totalHours = row.entries.reduce((s, e) => s + e.hours, 0);
            const submitter = await txService.userRepo.findOneBy({ id: userId });
            if (submitter) {
              notifications.push({
                kind: 'pending',
                approverIds: resolved.firstApproverIds,
                targetType: 'timesheet',
                targetId,
                applicantName: submitter.realName,
                title: `工时审批 ${totalHours}天`,
              });
            }
          }
        } else {
          await txService.repo.update(
            { id: In(records.map(r => r.id)) },
            {
              status: 'approved',
              currentStep: 0,
              totalSteps: 0,
              approvalInstanceId: resolved.instance?.id ?? null,
            },
          );
        }
      }
    });

    await this.flushNotifications(notifications);
    return true;
  }

  /** 修改已提交/已审批的工时 — 整周统一处理（事务化） */
  async modifySubmitted(userId: number, rows: { projectId: number; description: string; weekStart: string; entries: { date: string; hours: number }[] }[]) {
    if (!rows?.length) throw new BusinessError('请提供要修改的记录');

    await AppDataSource.transaction(async (manager) => {
      const txService = new TimesheetService(manager);
      const orgSnapshot = await txService.accessPolicy.getOrgSnapshot(userId);

      const weekStart = rows[0].weekStart;
      const weekEnd = dayjsExt(weekStart).add(6, 'day').format('YYYY-MM-DD');

      const allExisting = await txService.repo.find({
        where: { userId, date: Between(weekStart, weekEnd) },
      });
      const activeRecords = allExisting.filter(r => r.status !== 'deprecated');

      const nonDraftRecord = activeRecords.find(e => e.status !== 'draft' && e.submissionGroupId);
      const previousGroupId = nonDraftRecord?.submissionGroupId || null;

      const submittedRecords = activeRecords.filter(e => e.status === 'submitted');
      if (submittedRecords.length > 0) {
        const submitter = await txService.userRepo.findOneBy({ id: userId });
        if (submitter) {
          for (const e of submittedRecords) {
            await txService.approvalInstanceService.withdraw('timesheet', e.id, userId, submitter.realName);
            await txService.recordRepo.save(txService.recordRepo.create({
              targetType: 'timesheet',
              targetId: e.id,
              instanceId: e.approvalInstanceId ?? null,
              approverId: userId,
              approverName: submitter.realName,
              action: 'withdraw',
              comment: '申请人撤回修改工时',
              stepOrder: e.currentStep || 1,
              stepType: 'withdraw',
              stepLabel: '撤回',
            }));
          }
        }
      }

      for (const e of activeRecords) {
        if (e.status === 'submitted' || e.status === 'approved') {
          e.status = 'draft';
          e.currentStep = 0;
          e.approvalFlowId = null;
          e.approvalInstanceId = null;
          e.totalSteps = 0;
          e.previousGroupId = previousGroupId;
          await txService.repo.save(e);
        }
      }

      const allEntries = new Map<string, { date: string; projectId: number; hours: number; description: string }>();
      for (const row of rows) {
        for (const entry of row.entries) {
          if (entry.hours > 0) {
            allEntries.set(`${entry.date}_${row.projectId}`, {
              date: entry.date,
              projectId: row.projectId,
              hours: entry.hours,
              description: row.description,
            });
          }
        }
      }

      const allEntryKeys = new Set(allEntries.keys());

      const freshRecords = await txService.repo.find({
        where: { userId, date: Between(weekStart, weekEnd), status: Not('deprecated') },
      });

      const existingByDateProject = new Map<string, Timesheet>();
      for (const r of freshRecords) {
        const key = `${r.date}_${r.projectId}`;
        const existing = existingByDateProject.get(key);
        if (!existing || r.id > existing.id) {
          existingByDateProject.set(key, r);
        }
      }

      for (const [key, record] of existingByDateProject) {
        if (!allEntryKeys.has(key)) {
          if (!record.submissionGroupId) {
            await txService.repo.remove(record);
          } else {
            record.status = 'deprecated';
            await txService.repo.save(record);
          }
          existingByDateProject.delete(key);
        }
      }

      for (const entry of allEntries.values()) {
        const existingKey = `${entry.date}_${entry.projectId}`;
        const existingRecord = existingByDateProject.get(existingKey);

        if (existingRecord) {
          Object.assign(existingRecord, orgSnapshot);
          existingRecord.hours = entry.hours;
          existingRecord.description = entry.description || existingRecord.description;
          existingRecord.previousGroupId = previousGroupId;
          await txService.repo.save(existingRecord);
        } else {
          const oldRecordForDate = freshRecords.find(r => r.date === entry.date && r.submissionGroupId);
          if (oldRecordForDate && oldRecordForDate.projectId !== entry.projectId) {
            oldRecordForDate.status = 'deprecated';
            await txService.repo.save(oldRecordForDate);
          }

          await txService.repo.save(txService.createRecord({
            userId,
            projectId: entry.projectId,
            date: entry.date,
            hours: entry.hours,
            description: entry.description,
            previousGroupId,
          }, orgSnapshot));
        }
      }
    });

    return true;
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

  /** 周汇总 — 排除 deprecated，按 (date, projectId) 去重 */
  async getWeeklySummary(userId: number, weekStart: string, weekEnd: string) {
    const rawRecords = await this.repo.find({
      where: { userId, date: Between(weekStart, weekEnd), status: Not('deprecated') },
      relations: ['project'],
    });

    const dedupMap = new Map<string, Timesheet>();
    for (const r of rawRecords) {
      const key = `${r.date}_${r.projectId}`;
      const existing = dedupMap.get(key);
      if (!existing || r.id > existing.id) {
        dedupMap.set(key, r);
      }
    }
    const records = Array.from(dedupMap.values());

    const byDate: Record<string, number> = {};
    for (const r of records) {
      byDate[r.date] = (byDate[r.date] || 0) + Number(r.hours);
    }
    const totalHours = Object.values(byDate).reduce((s, h) => s + h, 0);

    const byProject = records.reduce((acc, r) => {
      const key = r.project?.name || '未分配';
      acc[key] = (acc[key] || 0) + Number(r.hours);
      return acc;
    }, {} as Record<string, number>);

    return { totalHours, byProject, records };
  }
}
