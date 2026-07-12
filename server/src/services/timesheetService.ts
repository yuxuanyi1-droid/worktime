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
import { round2 } from '../utils/validation';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
dayjs.extend(isoWeek);

function dayjsExt(d: string | dayjs.Dayjs) { return dayjs(d); }

/**
 * 按日期维度去重：同一 date 只保留 submissionGroupId 最大（最新版本）的记录。
 * 排除 deprecated/rejected/withdrawn 状态。同一天多个项目在同一 submissionGroup 下各自保留。
 */
function dedupByLatestSubmissionGroup(records: Timesheet[]): Timesheet[] {
  // 找出每个 date 对应的最大 submissionGroupId
  const maxGroupByDate = new Map<string, number>();
  for (const r of records) {
    if (r.status === 'deprecated' || r.status === 'rejected' || r.status === 'withdrawn') continue;
    if (!r.submissionGroupId) continue;
    const cur = maxGroupByDate.get(r.date);
    if (cur === undefined || r.submissionGroupId > cur) {
      maxGroupByDate.set(r.date, r.submissionGroupId);
    }
  }
  // 只保留属于该 date 最大 submissionGroupId 的记录
  return records.filter(r =>
    r.status !== 'deprecated' && r.status !== 'rejected' && r.status !== 'withdrawn'
    && r.submissionGroupId === maxGroupByDate.get(r.date)
  );
}

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

  /** 合法的工时填报单位（天步长）与默认值，须与前端/路由保持一致 */
  private static readonly UNIT_OPTIONS = [0.1, 0.2, 0.25, 0.5];
  private static readonly DEFAULT_UNIT = 0.5;

  /** 读取工时填报单位步长（天）；缺失/非法返回默认 0.5 */
  private async loadUnitStep(): Promise<number> {
    const setting = await this.settingRepo.findOne({ where: { key: 'timesheet_unit' } });
    const n = Number(setting?.value);
    return TimesheetService.UNIT_OPTIONS.includes(n) ? n : TimesheetService.DEFAULT_UNIT;
  }

  /** 校验单日工时合计不超过1天（天步长语义，带浮点容差） */
  private validateDailyHours(dailyHours: Record<string, number>) {
    for (const [date, total] of Object.entries(dailyHours)) {
      if (total > 1 + 1e-9) {
        throw new BusinessError(`${date} 工时合计 ${total.toFixed(2)} 天，超过每日1天上限`);
      }
    }
  }

  /** 校验每个 hours 值是步长的整数倍（带浮点容差） */
  private validateStepMultiple(entries: { date: string; hours: number }[], step: number, field: string) {
    for (const e of entries) {
      if (e.hours <= 0) continue;
      const ratio = e.hours / step;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
        throw new BusinessError(`${field}：${e.date} 工时 ${e.hours} 不是填报单位 ${step} 天的整数倍`);
      }
    }
  }


  async create(data: { userId: number; projectId: number; date: string; hours: number; description?: string }) {
    // 草稿创建也校验步长倍数，防止非步长值落库（每日上限留待提交时校验，草稿可跨日累积）
    const step = await this.loadUnitStep();
    this.validateStepMultiple([{ date: data.date, hours: data.hours }], step, '工时');
    const orgSnapshot = await this.accessPolicy.getOrgSnapshot(data.userId);
    const record = this.createRecord(data, orgSnapshot);
    return this.repo.save(record);
  }

  async batchCreate(userId: number, items: { projectId: number; date: string; hours: number; description?: string }[]) {
    const step = await this.loadUnitStep();
    items.forEach((item, i) => this.validateStepMultiple([{ date: item.date, hours: item.hours }], step, `items[${i}]`));
    const orgSnapshot = await this.accessPolicy.getOrgSnapshot(userId);
    const records = items.map(item => this.createRecord({ ...item, userId }, orgSnapshot));
    return this.repo.save(records);
  }

  async update(id: number, userId: number, data: { projectId?: number; hours?: number; description?: string }) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new BusinessError('记录不存在');
    if (record.userId !== userId) throw new BusinessError('只能修改自己的工时记录');
    if (record.status !== 'draft') throw new BusinessError('仅草稿状态可修改');
    // 若更新了 hours，校验步长倍数
    if (data.hours !== undefined) {
      const step = await this.loadUnitStep();
      this.validateStepMultiple([{ date: record.date, hours: data.hours }], step, '工时');
    }
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
      // 去重：同一 date 取最大的 submissionGroupId（最新提交版本），返回该版本下该 date 的所有记录。
      // 两步查询：先查出每个 date 的最大 submissionGroupId，再按这些 group 查完整记录。
      const maxGroupQb = this.repo.createQueryBuilder('d')
        .select('MAX(d.submissionGroupId)', 'maxGroup')
        .where('d.userId = :uid', { uid: userId })
        .andWhere('d.status NOT IN (:...excl)', { excl: ['deprecated', 'rejected', 'withdrawn'] })
        .andWhere('d.submissionGroupId IS NOT NULL')
        .groupBy('d.date');
      if (startDate && endDate) {
        maxGroupQb.andWhere('d.date BETWEEN :ds AND :de', { ds: startDate, de: endDate });
      }
      if (status) {
        maxGroupQb.andWhere('d.status = :st', { st: status });
      }
      const maxGroupRows = await maxGroupQb.getRawMany<{ maxGroup: number }>();
      const maxGroups = maxGroupRows.map(r => r.maxGroup).filter(Boolean);

      if (maxGroups.length === 0) {
        return { list: [], total: 0, page, pageSize };
      }

      qb.andWhere('t.submissionGroupId IN (:...maxGroups)', { maxGroups });
      qb.andWhere('t.status NOT IN (:...mainExcl)', { mainExcl: ['deprecated', 'rejected', 'withdrawn'] });
    } else {
      // includeAll（历史记录）：按提交时间筛选，而非工时日期。
      // 这样跨周/跨月的提交记录能整组完整返回（一组工时共享同一个 submissionGroupId），
      // 只要提交时间落在筛选范围内，整组都显示。
      if (startDate && endDate) qb.andWhere('t.updatedAt BETWEEN :startDate AND :endDate', { startDate, endDate });
      if (status) qb.andWhere('t.status = :status', { status });
    }

    qb.orderBy('t.date', 'DESC');
    const total = await qb.getCount();
    const list = await qb.skip((page - 1) * pageSize).take(pageSize).getMany();
    return { list, total, page, pageSize };
  }

  /** 按日期范围查询 — 按 date 取最大 submissionGroupId（最新版本），排除废弃/驳回/撤回 */
  async getByDateRange(userId: number, startDate: string, endDate: string) {
    const rawRecords = await this.repo.find({
      where: { userId, date: Between(startDate, endDate), status: Not('deprecated') },
      relations: ['project'],
      order: { date: 'ASC' },
    });
    const records = dedupByLatestSubmissionGroup(rawRecords);
    return records.sort((a, b) => a.date.localeCompare(b.date));
  }
  /** 在事务内原子地分配下一个 submissionGroupId */
  private async nextSubmissionGroupId(): Promise<number> {
    const existing = await this.seqRepo.findOneBy({ id: 1 });
    if (!existing) {
      const maxGroup = await this.repo.createQueryBuilder('t')
        .select('MAX(t.submissionGroupId)', 'maxId')
        .getRawOne<{ maxId: number | null }>();
      // 关键：currentValue 必须等于返回的 nextId。
      // 若写入 seed 而返回 seed+1，下次调用会从 seed 自增到 seed+1，与本次返回值撞车。
      const nextId = (maxGroup?.maxId ?? 0) + 1;
      await this.seqRepo.save(this.seqRepo.create({ id: 1, currentValue: nextId }));
      return nextId;
    }
    await this.seqRepo.increment({ id: 1 }, 'currentValue', 1);
    const updated = await this.seqRepo.findOneBy({ id: 1 });
    return updated!.currentValue;
  }

  /** 提交审批 */
  async submit(ids: number[], userId: number) {
    if (!ids?.length) throw new BusinessError('请选择要提交的记录');

    // 预读工时填报单位（天步长），供校验
    const unitStep = await this.loadUnitStep();

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

      // 与 submitByRows 对齐的校验：工时锁定、每日上限、步长倍数
      await txService.checkTimesheetLock(records.map(r => r.date));
      const entries = records.map(r => ({ date: r.date, hours: Number(r.hours) }));
      txService.validateStepMultiple(entries, unitStep, '记录');
      const dailyHours: Record<string, number> = {};
      for (const e of entries) dailyHours[e.date] = (dailyHours[e.date] || 0) + e.hours;
      txService.validateDailyHours(dailyHours);

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

    // 读工时填报单位（天步长），校验每个工时值为步长整数倍
    const unitStep = await this.loadUnitStep();
    rows.forEach((row, i) => this.validateStepMultiple(row.entries, unitStep, `rows[${i}]`));

    const dailyHours: Record<string, number> = {};
    for (const row of rows) {
      for (const e of row.entries) {
        dailyHours[e.date] = (dailyHours[e.date] || 0) + e.hours;
      }
    }
    this.validateDailyHours(dailyHours);

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
      // 已撤回的 submissionGroupId 集合：避免循环内对同一 group 多行重复 withdraw（实例只挂首行）
      const withdrawnGroupIds = new Set<number>();
      for (const rec of existingRecords) {
        const dates = projectDates.get(rec.projectId);
        const isInEntries = dates ? dates.has(rec.date) : allEntryDates.has(rec.date);

        if (rec.status === 'rejected') {
          // 该项目不在本次提交中（dates 为空）或该天被移除 → 删除 rejected 记录
          if (!dates || (dates && !isInEntries)) {
            await txService.repo.remove(rec);
            removedIds.add(rec.id);
          }
        } else if (rec.status === 'draft') {
          // 该项目不在本次提交中（dates 为空）或该天被移除 → 删除/deprecate draft 记录
          if (!dates || !isInEntries) {
            if (rec.submissionGroupId) {
              rec.status = 'deprecated';
              await txService.repo.save(rec);
            } else {
              await txService.repo.remove(rec);
            }
            removedIds.add(rec.id);
          }
        }
        // approved/submitted 的旧记录保持原状态不变（不再立即 deprecate）。
        // 新版本审批通过时由 approvalService 按 rootGroupId deprecate 整条旧链。
        // 这样修改期间旧版本仍参与报表统计（报表只取最新 approved 的 submissionGroup）。
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
              // 同一 submissionGroup 的审批实例只挂载在首行，withdraw 按 group 整体撤回。
              // 循环内多行 submitted 会重复进入此分支，必须按 group 去重，
              // 否则第一行撤回后实例已结束，后续行再 withdraw 会抛"审批实例不存在或已结束"。
              const groupIdKey = existingRec.submissionGroupId ?? 0;
              if (groupIdKey && !withdrawnGroupIds.has(groupIdKey)) {
                withdrawnGroupIds.add(groupIdKey);
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
        // rootGroupId：若有前驱版本，继承其所在链的根；否则本组即为新链的根（= 自身 submissionGroupId）。
        const inheritedRoot = rowPrevGroup?.rootGroupId || null;
        for (const r of records) {
          r.submissionGroupId = nextGroupId;
          r.previousGroupId = rowPrevGroup?.submissionGroupId || previousGroupId;
          r.rootGroupId = inheritedRoot || nextGroupId;
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
            const totalHours = round2(row.entries.reduce((s, e) => s + e.hours, 0));
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

  /**
   * 修改已提交/已审批的工时 —— 统一版本快照模型。
   *
   * 设计原则：任何对工时的改动（无论原状态是 draft / submitted / approved / rejected）
   * 都走同一条路径——旧版标记为 deprecated（保留审计历史，永不复活），
   * 改动落到新记录并自动发起新审批链。这与 submitByRows 完全同语义，
   * 因此直接委托。保留独立方法签名仅为前端路由兼容（POST /modify 与 /submit-rows 等价）。
   *
   * 这样消除了原先 modifySubmitted 把 approved 退回 draft 的反模式：
   * 审批通过即不可篡改，改动必须走新审批。
   */
  async modifySubmitted(userId: number, rows: { projectId: number; description: string; weekStart: string; entries: { date: string; hours: number }[] }[]) {
    return this.submitByRows(userId, rows);
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

  /**
   * 修改链查询：根据给定记录的 rootGroupId，一次性取回整条修改链
   * （原始提交 v1 → 修改 v2 → 修改 v3 …，含已 deprecated 的历史版本）。
   * 按 submissionGroupId 分组返回，组内按日期排序，组间按 submissionGroupId 升序（提交先后）。
   * 仅返回 viewer 有权访问的记录（自己提交，或viewer 为审批链中审批人/管理员，见路由层鉴权）。
   */
  async getModificationChain(recordId: number) {
    const seed = await this.repo.findOne({ where: { id: recordId } });
    if (!seed) throw new BusinessError('记录不存在');
    const rootGroupId = seed.rootGroupId ?? seed.submissionGroupId;
    if (!rootGroupId) return { rootGroupId: null, groups: [] };

    const records = await this.repo.find({
      where: { rootGroupId },
      relations: ['project'],
      order: { submissionGroupId: 'ASC', date: 'ASC', id: 'ASC' },
    });

    // 兜底：极少数历史数据可能 rootGroupId 为空但 submissionGroupId 匹配（旧链）
    if (records.length === 0) {
      return { rootGroupId, groups: [] };
    }

    const byGroup = new Map<number, Timesheet[]>();
    for (const r of records) {
      const gid = r.submissionGroupId ?? rootGroupId;
      const bucket = byGroup.get(gid) ?? [];
      bucket.push(r);
      byGroup.set(gid, bucket);
    }

    const groups = [...byGroup.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([groupId, recs]) => ({
        submissionGroupId: groupId,
        previousGroupId: recs[0].previousGroupId ?? null,
        rootGroupId: recs[0].rootGroupId ?? groupId,
        status: recs[0].status,
        projectId: recs[0].projectId,
        projectName: recs[0].project?.name ?? null,
        description: recs[0].description ?? null,
        createdAt: recs[0].createdAt,
        updatedAt: recs[0].updatedAt,
        totalHours: round2(recs.reduce((s, r) => s + Number(r.hours), 0)),
        entries: recs.map(r => ({ id: r.id, date: r.date, hours: Number(r.hours) })),
      }));

    return { rootGroupId, groups };
  }

  /** 周汇总 — 按 date 取最大 submissionGroupId（最新版本）去重 */
  async getWeeklySummary(userId: number, weekStart: string, weekEnd: string) {
    const rawRecords = await this.repo.find({
      where: { userId, date: Between(weekStart, weekEnd), status: Not('deprecated') },
      relations: ['project'],
    });

    const records = dedupByLatestSubmissionGroup(rawRecords);

    const byDate: Record<string, number> = {};
    for (const r of records) {
      byDate[r.date] = round2((byDate[r.date] || 0) + Number(r.hours));
    }
    const totalHours = round2(Object.values(byDate).reduce((s, h) => s + h, 0));

    const byProject = records.reduce((acc, r) => {
      const key = r.project?.name || '未分配';
      acc[key] = round2((acc[key] || 0) + Number(r.hours));
      return acc;
    }, {} as Record<string, number>);

    return { totalHours, byProject, records };
  }
}
