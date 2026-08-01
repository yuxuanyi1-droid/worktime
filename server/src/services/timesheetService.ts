import { EntityManager } from 'typeorm';
import { AppDataSource } from '../config/database';
import { Timesheet } from '../entities/Timesheet';
import { SystemSetting } from '../entities/SystemSetting';
import { SubmissionSequence } from '../entities/SubmissionSequence';
import { ApprovalRecord } from '../entities/ApprovalRecord';
import { ApprovalInstance } from '../entities/ApprovalInstance';
import { Between, In, Not, Brackets } from 'typeorm';
import { NotificationPublisher } from './notifications';
import { User } from '../entities/User';
import { Project } from '../entities/Project';
import { ApprovalInstanceService } from './approvalInstanceService';
import { AccessPolicyService, OrgSnapshot } from './accessPolicyService';
import { BusinessError, isUniqueViolation } from '../utils/errors';
import { round2 } from '../utils/validation';
import { logger } from '../utils/logger';
import { CacheKeys, CacheTtl, cacheGet, cacheSet } from '../config/cache';
import {
  enqueueTimesheetApprovals,
  type TimesheetApprovalJob,
} from './approvalQueue';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
dayjs.extend(isoWeek);
import { businessDayjs } from '../utils/time';

function dayjsExt(d: string | dayjs.Dayjs) { return dayjs(d); }

/**
 * 按「项目+日期」维度去重：同一 (projectId, date) 只保留 submissionGroupId 最大（最新版本）的记录。
 * 排除 deprecated/rejected/withdrawn 状态。
 *
 * 说明：submitByRows 提交时每个 projectId 独立分配一个 submissionGroupId，因此同一天多个项目
 * 会有多个不同 submissionGroupId。去重必须按 (projectId, date) 取各自最新版本，否则会丢失
 * 同一天的其他项目（仅保留 submissionGroupId 最大的那一个项目）。
 * 入参 records 应已是单用户范围。
 */
export function dedupByLatestSubmissionGroup(records: Timesheet[]): Timesheet[] {
  // 找出每个 (projectId, date) 对应的最大 submissionGroupId
  const maxGroupByKey = new Map<string, number>();
  for (const r of records) {
    if (r.status === 'deprecated' || r.status === 'rejected' || r.status === 'withdrawn') continue;
    if (!r.submissionGroupId) continue;
    const key = `${r.projectId}_${r.date}`;
    const cur = maxGroupByKey.get(key);
    if (cur === undefined || r.submissionGroupId > cur) {
      maxGroupByKey.set(key, r.submissionGroupId);
    }
  }
  // 只保留属于该 (projectId, date) 最大 submissionGroupId 的记录
  return records.filter(r =>
    r.status !== 'deprecated' && r.status !== 'rejected' && r.status !== 'withdrawn'
    && r.submissionGroupId === maxGroupByKey.get(`${r.projectId}_${r.date}`)
  );
}

/** 通知动作（事务提交后统一发送，避免长事务 & 通知失败不回滚业务） */
type PendingNotification =
  | { kind: 'pending'; approverIds: number[]; targetType: string; targetId: number; applicantName: string; title: string }
  | { kind: 'result'; applicantId: number; targetType: string; targetId: number; approved: boolean; comment?: string };

export class TimesheetService {
  constructor(private manager?: EntityManager) {}

  private transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    if (this.manager?.queryRunner?.isTransactionActive) return work(this.manager);
    return (this.manager?.connection ?? AppDataSource).transaction(work);
  }

  private get repo() { return (this.manager ?? AppDataSource).getRepository(Timesheet); }
  private get recordRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalRecord); }
  private get instanceRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalInstance); }
  private get approvalInstanceService() { return new ApprovalInstanceService(this.manager); }
  private get accessPolicy() { return new AccessPolicyService(this.manager); }
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }
  private get projectRepo() { return (this.manager ?? AppDataSource).getRepository(Project); }
  private get settingRepo() { return (this.manager ?? AppDataSource).getRepository(SystemSetting); }
  private get seqRepo() { return (this.manager ?? AppDataSource).getRepository(SubmissionSequence); }

  private createRecord(data: Partial<Timesheet> & { userId: number }, orgSnapshot: OrgSnapshot) {
    return this.repo.create({ ...data, ...orgSnapshot });
  }

  private async validateActiveProjects(projectIds: number[]): Promise<void> {
    const uniqueIds = [...new Set(projectIds)];
    const projects = uniqueIds.length ? await this.projectRepo.findBy({ id: In(uniqueIds) }) : [];
    if (projects.length !== uniqueIds.length) throw new BusinessError('包含不存在的项目');
    const unavailable = projects.find((project) => project.status !== 'active');
    if (unavailable) throw new BusinessError(`项目“${unavailable.name}”已非进行中状态，不能填报工时`);
  }

  /** 读系统设置（Redis 缓存，未命中回落 DB） */
  private async getSettingValue(settingKey: string): Promise<string | null> {
    const cacheKey = CacheKeys.setting(settingKey);
    const cached = await cacheGet<{ value: string | null }>(cacheKey);
    if (cached) return cached.value;

    const row = await this.settingRepo.findOne({ where: { key: settingKey } });
    const value = row?.value ?? null;
    await cacheSet(cacheKey, { value }, CacheTtl.setting);
    return value;
  }

  /** 检查工时锁定 */
  private async checkTimesheetLock(dates: string[]) {
    const raw = await this.getSettingValue('timesheet_lock_day');
    if (!raw) return;
    const lockDay = parseInt(raw, 10);
    if (isNaN(lockDay) || lockDay < 1 || lockDay > 28) return;
    const now = businessDayjs();
    const currentMonthStart = now.startOf('month');
    const previousMonthStart = currentMonthStart.subtract(1, 'month');
    for (const date of dates) {
      const d = businessDayjs(date);
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
    const raw = await this.getSettingValue('timesheet_unit');
    const n = Number(raw);
    return TimesheetService.UNIT_OPTIONS.includes(n) ? n : TimesheetService.DEFAULT_UNIT;
  }

  /** 校验单日工时合计不超过1天（天步长语义，带浮点容差） */
  private validateDailyDays(dailyDays: Record<string, number>) {
    for (const [date, total] of Object.entries(dailyDays)) {
      if (total > 1 + 1e-9) {
        throw new BusinessError(`${date} 工时合计 ${total.toFixed(2)} 天，超过每日1天上限`);
      }
    }
  }

  /**
   * 跨提交日合计校验：单次载荷内校验（validateDailyDays）可被「同日分多次提交不同项目」绕过。
   * 提交时把「本次载荷」与「同日已存在的 approved/submitted 记录（按 (projectId, date) 取最新组）」
   * 合并计算，仍不得超过每日 1 天。
   *
   * @param payloadDays  本次载荷按日期汇总（已含步长校验）
   * @param existingRecords 事务内已读取的既有记录（含本次将覆盖的版本链）
   * @param removedIds   将被删除/废弃的记录 id（覆盖的旧版本不计入）
   * @param payloadKeys  本次载荷覆盖的 (projectId:date) 集合（旧版本被覆盖，不再计入）
   */
  private assertDailyCapAcrossSubmissions(
    payloadDays: Record<string, number>,
    existingRecords: Timesheet[],
    removedIds: Set<number>,
    payloadKeys: Set<string>,
  ) {
    // 载荷外活跃记录：approved/submitted 且未被本次覆盖，按 (projectId, date) 取最新 submissionGroupId
    const maxGroupByKey = new Map<string, number>();
    for (const r of existingRecords) {
      if (removedIds.has(r.id)) continue;
      if (r.status !== 'approved' && r.status !== 'submitted') continue;
      if (!r.submissionGroupId) continue;
      if (payloadKeys.has(`${r.projectId}:${r.date}`)) continue;
      const key = `${r.projectId}_${r.date}`;
      const cur = maxGroupByKey.get(key);
      if (cur === undefined || r.submissionGroupId > cur) maxGroupByKey.set(key, r.submissionGroupId);
    }
    const totals: Record<string, number> = { ...payloadDays };
    for (const r of existingRecords) {
      if (removedIds.has(r.id)) continue;
      if (r.status !== 'approved' && r.status !== 'submitted') continue;
      if (!r.submissionGroupId) continue;
      if (payloadKeys.has(`${r.projectId}:${r.date}`)) continue;
      if (r.submissionGroupId !== maxGroupByKey.get(`${r.projectId}_${r.date}`)) continue;
      totals[r.date] = round2((totals[r.date] || 0) + Number(r.days));
    }
    this.validateDailyDays(totals);
  }

  private validateDistinctProjectDates(items: { projectId: number; date: string }[]) {
    const seen = new Set<string>();
    for (const item of items) {
      const key = `${item.projectId}:${item.date}`;
      if (seen.has(key)) throw new BusinessError(`项目 ${item.projectId} 在 ${item.date} 存在重复工时`);
      seen.add(key);
    }
  }

  /** 校验每个 days 值是步长的整数倍（带浮点容差） */
  private validateStepMultiple(entries: { date: string; days: number }[], step: number, field: string) {
    for (const e of entries) {
      if (e.days <= 0) continue;
      const ratio = e.days / step;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
        throw new BusinessError(`${field}：${e.date} 工时 ${e.days} 不是填报单位 ${step} 天的整数倍`);
      }
    }
  }


  async create(data: { userId: number; projectId: number; date: string; days: number; description?: string }) {
    // 草稿创建也校验步长倍数，防止非步长值落库（每日上限留待提交时校验，草稿可跨日累积）
    await this.validateActiveProjects([data.projectId]);
    const step = await this.loadUnitStep();
    this.validateStepMultiple([{ date: data.date, days: data.days }], step, '工时');
    // 同一 (用户, 项目, 日期) 已存在草稿/审批中记录时拒绝重复创建。
    // 已通过（approved）记录允许并存：修改已通过工时走 submitByRows 版本化流程，
    // 旧版本在新版本审批通过前保留（报表口径不归零）。
    const conflict = await this.repo.findOne({
      where: { userId: data.userId, projectId: data.projectId, date: data.date, status: In(['draft', 'submitted']) },
    });
    if (conflict) throw new BusinessError(`项目 ${data.projectId} 在 ${data.date} 已存在草稿或审批中记录，请刷新后修改`);
    const orgSnapshot = await this.accessPolicy.getOrgSnapshot(data.userId);
    const record = this.createRecord(data, orgSnapshot);
    try {
      return await this.repo.save(record);
    } catch (err) {
      // 并发提交撞 (userId, projectId, date) 活跃唯一索引 → 友好提示
      if (isUniqueViolation(err)) throw new BusinessError(`项目 ${data.projectId} 在 ${data.date} 已存在记录，请刷新后重试`);
      throw err;
    }
  }

  async batchCreate(userId: number, items: { projectId: number; date: string; days: number; description?: string }[]) {
    this.validateDistinctProjectDates(items);
    await this.validateActiveProjects(items.map((item) => item.projectId));
    const step = await this.loadUnitStep();
    items.forEach((item, i) => this.validateStepMultiple([{ date: item.date, days: item.days }], step, `items[${i}]`));
    const dailyDays: Record<string, number> = {};
    for (const item of items) dailyDays[item.date] = round2((dailyDays[item.date] || 0) + item.days);
    this.validateDailyDays(dailyDays);
    // 与 create 相同的冲突检查（批量版）：任一 (projectId, date) 已存在草稿/审批中记录即拒绝
    const conflicts = await this.repo.find({
      where: items.map((item) => ({
        userId,
        projectId: item.projectId,
        date: item.date,
        status: In(['draft', 'submitted'] as const),
      })),
      select: ['id', 'projectId', 'date'],
    });
    if (conflicts.length) {
      const c = conflicts[0];
      throw new BusinessError(`项目 ${c.projectId} 在 ${c.date} 已存在草稿或审批中记录，请刷新后修改`);
    }
    const orgSnapshot = await this.accessPolicy.getOrgSnapshot(userId);
    const records = items.map(item => this.createRecord({ ...item, userId }, orgSnapshot));
    try {
      return await this.repo.save(records);
    } catch (err) {
      if (isUniqueViolation(err)) throw new BusinessError('部分记录已存在（同一项目同日期重复），请刷新后重试');
      throw err;
    }
  }

  /**
   * 原子替换某周草稿：旧草稿删除与新草稿写入同一事务。
   * 避免客户端“先逐条删除、再批量新建”在网络或校验失败时丢失已保存草稿。
   */
  async replaceWeekDrafts(
    userId: number,
    weekStart: string,
    items: { projectId: number; date: string; days: number; description?: string }[],
  ) {
    const start = dayjsExt(weekStart);
    if (start.isoWeekday() !== 1) throw new BusinessError('weekStart必须是周一');
    const weekEnd = start.add(6, 'day').format('YYYY-MM-DD');
    if (items.some((item) => item.date < weekStart || item.date > weekEnd)) {
      throw new BusinessError('草稿日期必须在指定周内');
    }

    return this.transaction(async (manager) => {
      const txService = new TimesheetService(manager);
      txService.validateDistinctProjectDates(items);
      await txService.validateActiveProjects(items.map((item) => item.projectId));
      const step = await txService.loadUnitStep();
      items.forEach((item, index) => {
        txService.validateStepMultiple([{ date: item.date, days: item.days }], step, `items[${index}]`);
      });
      const dailyDays: Record<string, number> = {};
      for (const item of items) dailyDays[item.date] = round2((dailyDays[item.date] || 0) + item.days);
      txService.validateDailyDays(dailyDays);
      const orgSnapshot = await txService.accessPolicy.getOrgSnapshot(userId);

      await txService.repo.delete({ userId, date: Between(weekStart, weekEnd), status: 'draft' });
      const records = items.map((item) => txService.createRecord({ ...item, userId }, orgSnapshot));
      try {
        return await txService.repo.save(records);
      } catch (err) {
        // 并发下撞 (userId, projectId, date) 活跃唯一索引（如审批中记录并存）→ 友好提示
        if (isUniqueViolation(err)) throw new BusinessError('草稿保存失败：同一项目同日期已存在审批中记录，请刷新后重试');
        throw err;
      }
    });
  }

  async update(id: number, userId: number, data: { projectId?: number; days?: number; description?: string }) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new BusinessError('记录不存在');
    if (record.userId !== userId) throw new BusinessError('只能修改自己的工时记录');
    if (record.status !== 'draft') throw new BusinessError('仅草稿状态可修改');
    if (data.projectId !== undefined) {
      await this.validateActiveProjects([data.projectId]);
      // 改项目后撞已有草稿/审批中记录 → 友好提示（approved 允许并存，走版本化流程）
      if (data.projectId !== record.projectId) {
        const conflict = await this.repo.findOne({
          where: { userId, projectId: data.projectId, date: record.date, status: In(['draft', 'submitted']) },
        });
        if (conflict && conflict.id !== id) {
          throw new BusinessError(`项目 ${data.projectId} 在 ${record.date} 已存在草稿或审批中记录，请刷新后修改`);
        }
      }
    }
    // 若更新了 days，校验步长倍数
    if (data.days !== undefined) {
      const step = await this.loadUnitStep();
      this.validateStepMultiple([{ date: record.date, days: data.days }], step, '工时');
    }
    Object.assign(record, data);
    try {
      return await this.repo.save(record);
    } catch (err) {
      if (isUniqueViolation(err)) throw new BusinessError('该项目该日期已存在记录，请刷新后重试');
      throw err;
    }
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
      // 周填报表查询：并集返回「已提交的最新版本」+「真草稿(draft)」。
      //
      // 路径A（已分组最新版本）：submitByRows 每个 projectId 独立分配 submissionGroupId，
      //   故按 (projectId, date) 取 MAX(submissionGroupId) 得到各项目最新提交版本。
      // 路径B（真草稿）：draft 的 submissionGroupId 本就是 null（未提交），单独查 status='draft'。
      //   撤回记录(status=withdrawn, group 保留)被两路都排除：路径A按 status 排除 withdrawn，
      //   路径B要求 status=draft。故撤回记录不显示（仅历史记录可见）。
      const maxGroupQb = this.repo.createQueryBuilder('d')
        .select('MAX(d.submissionGroupId)', 'maxGroup')
        .where('d.userId = :uid', { uid: userId })
        .andWhere('d.status NOT IN (:...excl)', { excl: ['deprecated', 'rejected', 'withdrawn'] })
        .andWhere('d.submissionGroupId IS NOT NULL')
        .groupBy('d.projectId, d.date');
      if (startDate) maxGroupQb.andWhere('d.date >= :ds', { ds: startDate });
      if (endDate) maxGroupQb.andWhere('d.date <= :de', { de: endDate });
      if (status) {
        maxGroupQb.andWhere('d.status = :st', { st: status });
      }
      const maxGroupRows = await maxGroupQb.getRawMany<{ maxGroup: number }>();
      const maxGroups = maxGroupRows.map(r => r.maxGroup).filter(Boolean);

      if (startDate) qb.andWhere('t.date >= :ds', { ds: startDate });
      if (endDate) qb.andWhere('t.date <= :de', { de: endDate });
      // 并集：已提交最新版本(路径A) 或 真草稿(路径B)
      qb.andWhere(new Brackets(qb1 => {
        // 路径A：maxGroups 非空时取这些 group 的非终态记录
        if (maxGroups.length > 0) {
          qb1.where('t.submissionGroupId IN (:...maxGroups)', { maxGroups })
            .andWhere('t.status NOT IN (:...mainExcl)', { mainExcl: ['deprecated', 'rejected', 'withdrawn'] })
            .orWhere('t.submissionGroupId IS NULL AND t.status = :draft', { draft: 'draft' })
            // 路径C：被驳回工时需在周填报表可见可改，供用户修改后重新提交（否则形成功能断点）
            .orWhere('t.status = :rejected', { rejected: 'rejected' });
        } else {
          // 无已提交版本：真草稿 + 被驳回（均可编辑后重提）
          qb1.where('t.submissionGroupId IS NULL AND t.status = :draft', { draft: 'draft' })
            .orWhere('t.status = :rejected', { rejected: 'rejected' });
        }
      }));
      if (status) {
        qb.andWhere('t.status = :status', { status });
      }
    } else {
      // includeAll（历史记录）：按提交时间筛选，而非工时日期。
      // 这样跨周/跨月的提交记录能整组完整返回（一组工时共享同一个 submissionGroupId），
      // 只要提交时间落在筛选范围内，整组都显示。
      if (startDate) {
        // 按业务时区（Asia/Shanghai）的日界转 UTC 边界，避免容器 UTC 下凌晨提交被归入前一天
        qb.andWhere('t.updatedAt >= :historyStart', { historyStart: businessDayjs(startDate).startOf('day').toISOString() });
      }
      if (endDate) {
        qb.andWhere('t.updatedAt < :historyEnd', { historyEnd: businessDayjs(endDate).add(1, 'day').startOf('day').toISOString() });
      }
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
  /** 在事务内原子地分配下一个 submissionGroupId（优先 Redis INCR，失败回退 DB 行锁） */
  private async nextSubmissionGroupId(): Promise<number> {
    const ids = await this.nextSubmissionGroupIds(1);
    return ids[0];
  }

  /** 一次分配 count 个连续序号，减少多项目提交往返。
   *  DB 回退路径每次先与 timesheets.MAX(submissionGroupId) 校准，并在事务内对计数器行加写锁，
   *  消除「Redis 运行期发号、seqRepo 行长期不回写」在 Redis 抖动回退时碰撞已用序号的风险。 */
  private async nextSubmissionGroupIds(count: number): Promise<number[]> {
    if (count <= 0) return [];
    const { redisNextSubmissionGroupIds } = await import('../config/redis');
    const fromRedis = await redisNextSubmissionGroupIds(count);
    if (fromRedis) return fromRedis;

    // 包入事务以使行锁生效；若已在事务内则复用同一 manager。
    return this.transaction(async (manager) => {
      const seqRepo = manager.getRepository(SubmissionSequence);
      const tsRepo = manager.getRepository(Timesheet);
      const out: number[] = [];
      for (let i = 0; i < count; i++) {
        // 当前 timesheets 中已用最大组号（Redis 期间发号最终都落在这里）
        const maxRow = await tsRepo.createQueryBuilder('t')
          .select('MAX(t.submissionGroupId)', 'maxId')
          .getRawOne<{ maxId: number | null }>();
        const dbMax = maxRow?.maxId ?? 0;

        // 行锁串行化回退路径，防止并发回退各自读到同一 currentValue 后重复发号
        const seq = await seqRepo.findOne({ where: { id: 1 }, lock: { mode: 'pessimistic_write' } });
        if (!seq) {
          const nextId = Math.max(1, dbMax + 1);
          await seqRepo.save(seqRepo.create({ id: 1, currentValue: nextId }));
          out.push(nextId);
          continue;
        }
        // 校准：DB 实际最大组号可能已大于计数器（Redis 期间发号不回写本表）
        if (dbMax > seq.currentValue) seq.currentValue = dbMax;
        seq.currentValue += 1;
        await seqRepo.save(seq);
        out.push(seq.currentValue);
      }
      return out;
    }).then(async (out) => {
      // DB 回退路径发号后把新最大值回写 Redis：Redis 瞬时抖动/短暂不可用后恢复时，
      // 计数器可能落后于 DB 实发值，若不同步会在下次 INCRBY 与已用序号碰撞（跨用户串组）。
      // 异步 best-effort，失败不影响已分配序号（下次 DB 路径会重新校准）。
      if (out.length) {
        const { syncSubmissionGroupIdFromDb } = await import('../config/redis');
        void syncSubmissionGroupIdFromDb(out[out.length - 1]).catch(() => undefined);
      }
      return out;
    });
  }

  /**
   * 事务提交后创建审批实例并回写工时状态。
   * - SUBMIT_APPROVAL_SYNC=1：同步执行（测试）
   * - 否则优先入 Redis 队列由 worker 消费；入队失败则 setImmediate 降级
   */
  private scheduleTimesheetApprovals(jobs: TimesheetApprovalJob[]): Promise<void> | void {
    if (!jobs.length) return;
    if (process.env.SUBMIT_APPROVAL_SYNC === '1') {
      // 同步模式用于测试/诊断，失败必须返回调用方，不能伪装成提交成功。
      return this.processApprovalJobs(jobs);
    }
    return enqueueTimesheetApprovals(jobs).then(async (ok) => {
      if (ok) return;
      // Redis 入队失败：同步降级执行审批实例创建，失败则向上抛出明确错误。
      // 不再 setImmediate 静默吞错，避免“记录已 submitted 但无审批实例、接口却返回成功”的不可见缝隙。
      try {
        await this.processApprovalJobs(jobs);
      } catch (err) {
        logger.error({ err, jobs: jobs.map((j) => j.targetId) }, '[timesheet] 后置审批创建失败（记录已 submitted，需补偿处理）');
        throw new BusinessError('工时已提交，但审批创建失败，请联系管理员或稍后重试');
      }
    });
  }

  /** 供队列 worker / 同步路径调用（支持批量 start） */
  async processApprovalJobs(jobs: TimesheetApprovalJob[]) {
    if (!jobs.length) return;
    const notifications: PendingNotification[] = [];
    await this.transaction(async (manager) => {
      const svc = new TimesheetService(manager);
      const submitterCache = new Map<number, User | null>();

    const heads = await svc.repo.findBy({ id: In(jobs.map((j) => j.targetId)) });
    const headById = new Map(heads.map((h) => [h.id, h]));

    const activeJobs: TimesheetApprovalJob[] = [];
    for (const job of jobs) {
      const head = headById.get(job.targetId);
      if (!head || head.status === 'deprecated' || head.status === 'withdrawn') {
        logger.info({ targetId: job.targetId, status: head?.status }, '[timesheet] 跳过过期审批任务');
        continue;
      }
      activeJobs.push(job);
    }
    if (!activeJobs.length) return;

    // Streams 是至少一次投递：先复用已经创建的实例，避免 worker 在实例落库后、ACK 前
    // 崩溃时重复创建。数据库唯一索引负责兜住多实例同时首次处理的竞态。
    const existingInstances = await svc.instanceRepo.find({
      where: {
        targetType: 'timesheet',
        targetId: In(activeJobs.map((job) => job.targetId)),
      },
    });
    const existingByTarget = new Map(existingInstances.map((instance) => [instance.targetId, instance]));
    const newJobs = activeJobs.filter((job) => !existingByTarget.has(job.targetId));
    // 本次新创建实例的 targetId 集合：用于避免对重投递（实例已存在）的 job 重复发送 approval-pending 通知。
    const newTargetIds = new Set(newJobs.map((job) => job.targetId));
    const createdList = await svc.approvalInstanceService.startMany(
      newJobs.map((job) => ({
        targetType: 'timesheet' as const,
        targetId: job.targetId,
        applicantId: job.userId,
        projectId: job.projectId,
      })),
    );
    const resolvedByTarget = new Map<number, {
      status: 'approved' | 'submitted';
      instance: ApprovalInstance;
      firstApproverIds: number[];
    }>();
    newJobs.forEach((job, index) => resolvedByTarget.set(job.targetId, createdList[index]));
    for (const instance of existingInstances) {
      const firstStep = instance.stepsSnapshot?.find((step) => step.stepOrder === 1);
      resolvedByTarget.set(instance.targetId, {
        status: instance.status === 'approved' ? 'approved' : 'submitted',
        instance,
        firstApproverIds: firstStep?.approvers.map((approver) => approver.id) ?? [],
      });
    }

    // 按结果分组批量回写工时（同一批内 instance 字段不同，仍逐条 update；减少 find）
    for (let i = 0; i < activeJobs.length; i++) {
      const job = activeJobs[i];
      const resolved = resolvedByTarget.get(job.targetId)!;
      if (resolved.status === 'submitted' && resolved.instance) {
        await svc.repo.update(
          { id: In(job.recordIds), status: 'submitted' },
          {
            status: 'submitted',
            currentStep: resolved.instance.currentStepOrder || 1,
            approvalFlowId: resolved.instance.flowId,
            approvalInstanceId: resolved.instance.id,
            totalSteps: resolved.instance.totalSteps,
          },
        );
        if (resolved.firstApproverIds.length && newTargetIds.has(job.targetId)) {
          // 仅对本次新创建的审批实例发送 approval-pending 通知；重投递（实例已存在）的 job
          // 认为首次处理时已通知过，不重复发送（保守实现：以"实例新建"作为已通知判据，
          // 不引入额外 DB 列）。极端情况下首次处理崩溃在发通知之前会导致该条漏发，可由审批人
          // 主动查看待办列表兜底——优于重复打扰。
          let submitter = submitterCache.get(job.userId);
          if (submitter === undefined) {
            submitter = await svc.userRepo.findOneBy({ id: job.userId });
            submitterCache.set(job.userId, submitter);
          }
          if (submitter) {
            notifications.push({
              kind: 'pending',
              approverIds: resolved.firstApproverIds,
              targetType: 'timesheet',
              targetId: job.targetId,
              applicantName: submitter.realName,
              title: job.title,
            });
          }
        }
      } else {
        await svc.repo.update(
          { id: In(job.recordIds), status: 'submitted' },
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
    // 通知保持在事务提交之后发送，失败不回滚已经完成的业务写入。
    await this.flushNotifications(notifications);
  }

  /** 提交审批 */
  async submit(ids: number[], userId: number) {
    if (!ids?.length) throw new BusinessError('请选择要提交的记录');
    const uniqueIds = [...new Set(ids)];

    // 预读工时填报单位（天步长），供校验
    const unitStep = await this.loadUnitStep();
    const approvalJobs: TimesheetApprovalJob[] = [];

    // 锁检查移出事务，缩短写事务持锁时间
    const preview = await this.repo.findBy({ id: In(uniqueIds) });
    if (preview.length !== uniqueIds.length) throw new BusinessError('包含不存在的工时记录');
    await this.checkTimesheetLock(preview.map((r) => r.date));

    await this.transaction(async (manager) => {
      const txService = new TimesheetService(manager);
      const records = await txService.repo.findBy({ id: In(uniqueIds) });
      if (records.length !== uniqueIds.length) throw new BusinessError('包含不存在的工时记录');
      const orgSnapshot = await txService.accessPolicy.getOrgSnapshot(userId);
      for (const r of records) {
        if (r.userId !== userId) throw new BusinessError('只能提交自己的工时记录');
        if (r.status !== 'draft') throw new BusinessError(`记录 ${r.id} 不是草稿状态，无法提交`);
        Object.assign(r, orgSnapshot);
      }

      const entries = records.map(r => ({ date: r.date, days: Number(r.days) }));
      txService.validateStepMultiple(entries, unitStep, '记录');
      const dailyDays: Record<string, number> = {};
      for (const e of entries) dailyDays[e.date] = (dailyDays[e.date] || 0) + e.days;
      txService.validateDailyDays(dailyDays);

      await txService.validateActiveProjects(records.map((record) => record.projectId));
      await txService.approvalInstanceService.validateStartMany(records.map((record) => ({
        targetType: 'timesheet' as const,
        applicantId: userId,
        projectId: record.projectId,
      })));

      // 跨提交日合计校验：同日已存在其他项目/日期的 submitted/approved 记录时，
      // 本次提交不得突破每日 1 天上限（事务内记录此时仍为 draft，不会被误计）。
      if (Object.keys(dailyDays).length) {
        const activeOthers = await txService.repo.find({
          where: [
            { userId, date: In(Object.keys(dailyDays)), status: 'approved' },
            { userId, date: In(Object.keys(dailyDays)), status: 'submitted' },
          ],
        });
        txService.assertDailyCapAcrossSubmissions(dailyDays, activeOthers, new Set<number>(), new Set<string>());
      }

      // 批量 UPDATE，避免逐条 save；单条提交也分配 submissionGroupId，
      // 保证周填报表（按组视图）与版本链追溯对该路径同样成立。
      const recordIds = records.map((r) => r.id);
      const groupIds = await txService.nextSubmissionGroupIds(1);
      await txService.repo.update(
        { id: In(recordIds) },
        {
          status: 'submitted',
          submissionGroupId: groupIds[0],
          currentStep: 0,
          totalSteps: 0,
          approvalFlowId: null,
          approvalInstanceId: null,
          ...orgSnapshot,
        },
      );

      for (const r of records) {
        approvalJobs.push({
          targetId: r.id,
          recordIds: [r.id],
          projectId: r.projectId,
          userId,
          title: `工时审批 ${r.days}天`,
        });
      }
    }).catch((err) => {
      // 并发提交撞 (userId,projectId,date) 活跃唯一索引 → 友好提示，避免重复审批实例
      if (isUniqueViolation(err)) throw new BusinessError('同一周工时正在提交或已存在，请刷新后重试');
      throw err;
    });

    const maybeWait = this.scheduleTimesheetApprovals(approvalJobs);
    if (maybeWait) await maybeWait;
    return true;
  }

  /**
   * 按行提交审批（事务化写工时；审批实例入 Redis 队列异步创建）
   */
  async submitByRows(
    userId: number,
    rows: { projectId: number; description: string; weekStart: string; entries: { date: string; days: number }[] }[],
    options: { preserveOmittedProjects?: boolean } = {},
  ) {
    if (!rows?.length) throw new BusinessError('请选择要提交的记录');

    const weekStart = rows[0].weekStart;
    const start = dayjsExt(weekStart);
    if (start.isoWeekday() !== 1) throw new BusinessError('weekStart必须是周一');
    const weekEnd = start.add(6, 'day').format('YYYY-MM-DD');
    if (rows.some((row) => row.weekStart !== weekStart)) {
      throw new BusinessError('一次只能提交同一周的工时');
    }
    const projectIdsInPayload = rows.map((row) => row.projectId);
    if (new Set(projectIdsInPayload).size !== projectIdsInPayload.length) {
      throw new BusinessError('同一项目在一周内只能提交一行');
    }
    if (rows.some((row) => row.entries.some((entry) => entry.date < weekStart || entry.date > weekEnd))) {
      throw new BusinessError('工时日期必须在指定周内');
    }

    const allDates = rows.flatMap(r => r.entries.map(e => e.date));
    await this.checkTimesheetLock(allDates);

    // 读工时填报单位（天步长），校验每个工时值为步长整数倍
    const unitStep = await this.loadUnitStep();
    rows.forEach((row, i) => this.validateStepMultiple(row.entries, unitStep, `rows[${i}]`));

    const dailyDays: Record<string, number> = {};
    let positiveEntryCount = 0;
    for (const row of rows) {
      for (const e of row.entries) {
        dailyDays[e.date] = (dailyDays[e.date] || 0) + e.days;
        if (e.days > 0) positiveEntryCount += 1;
      }
    }
    if (positiveEntryCount === 0) throw new BusinessError('请至少填写一条大于 0 的工时记录');
    this.validateDailyDays(dailyDays);

    const approvalJobs: TimesheetApprovalJob[] = [];

    await this.transaction(async (manager) => {
      const txService = new TimesheetService(manager);
      const orgSnapshot = await txService.accessPolicy.getOrgSnapshot(userId);
      const submitter = await txService.userRepo.findOneBy({ id: userId, status: 1 });
      if (!submitter) throw new BusinessError('提交人不存在或已被禁用');

      const projectIds = [...new Set(rows
        .filter((row) => row.entries.some((entry) => entry.days > 0))
        .map((row) => row.projectId))];
      await txService.validateActiveProjects(projectIds);
      await txService.approvalInstanceService.validateStartMany(projectIds.map((projectId) => ({
        targetType: 'timesheet' as const,
        applicantId: userId,
        projectId,
      })));

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
      for (const row of rows) {
        const dates = new Set<string>();
        for (const e of row.entries) {
          if (e.days > 0) {
            dates.add(e.date);
          }
        }
        projectDates.set(row.projectId, dates);
      }

      const removedIds = new Set<number>();
      const toRemoveIds: number[] = [];
      const toDeprecateIds: number[] = [];
      // 已撤回的 submissionGroupId 集合：避免循环内对同一 group 多行重复 withdraw
      const withdrawnGroupIds = new Set<number>();

      // 第一遍：分类清理，批量写库（替代逐条 save/remove）
      for (const rec of existingRecords) {
        const dates = projectDates.get(rec.projectId);
        if (!dates && options.preserveOmittedProjects) continue;
        const isInEntries = !!dates?.has(rec.date);

        if (rec.status === 'rejected') {
          if (!dates || !isInEntries) {
            toRemoveIds.push(rec.id);
            removedIds.add(rec.id);
          }
        } else if (rec.status === 'draft') {
          if (!dates || !isInEntries) {
            if (rec.submissionGroupId) {
              toDeprecateIds.push(rec.id);
            } else {
              toRemoveIds.push(rec.id);
            }
            removedIds.add(rec.id);
          }
        } else if (rec.status === 'approved' || rec.status === 'submitted') {
          // 整周提交：载荷中删除的项目/日期废弃；局部修改：只处理载荷明确包含的项目。
          if (!dates || !isInEntries) {
            if (rec.status === 'submitted' && rec.approvalInstanceId) {
              // 载荷外已提交记录直接废弃：同步撤回其审批实例，避免产生不可操作的
              // 孤儿 pending 实例（审批人看到已废弃记录的待办，且永远无法处理）。
              const groupIdKey = rec.submissionGroupId ?? 0;
              if (groupIdKey && !withdrawnGroupIds.has(groupIdKey)) {
                withdrawnGroupIds.add(groupIdKey);
                try {
                  await txService.approvalInstanceService.withdraw('timesheet', rec.id, userId, submitter.realName);
                  await txService.recordRepo.save(txService.recordRepo.create({
                    targetType: 'timesheet',
                    targetId: rec.id,
                    instanceId: rec.approvalInstanceId ?? null,
                    approverId: userId,
                    approverName: submitter.realName,
                    action: 'withdraw',
                    comment: '申请人修改工时，重新提交审批',
                    stepOrder: rec.currentStep || 1,
                    stepType: 'withdraw',
                    stepLabel: '撤回',
                  }));
                } catch (err) {
                  // 队列竞态：实例刚结束或不存在时仍允许 deprecate 并重提
                  if (!(err instanceof BusinessError) || !String(err.message).includes('无法撤回')) {
                    throw err;
                  }
                }
              }
            }
            toDeprecateIds.push(rec.id);
            removedIds.add(rec.id);
          }
        }
      }

      if (toDeprecateIds.length) {
        await txService.repo.update({ id: In(toDeprecateIds) }, { status: 'deprecated' });
      }
      if (toRemoveIds.length) {
        await txService.repo.delete(toRemoveIds);
      }

      type RowBuild = {
        projectId: number;
        description: string;
        records: Timesheet[];
        totalDays: number;
      };
      const builtRows: RowBuild[] = [];
      const deprecateInLoop: number[] = [];

      for (const row of rows) {
        if (!row.entries?.length) continue;

        const records: Timesheet[] = [];

        for (const entry of row.entries) {
          if (entry.days <= 0) continue;

          // 按 id 降序取该 (projectId, date) 下最新的未移除记录：审批通过后旧版本会保留
          // 到新版本通过（deprecate 延后），必须优先匹配最新版本，否则保留的旧 approved
          // 会挡住新 submitted 版本，导致其无法被撤回/废弃、审批实例残留。
          const existingRec = existingRecords
            .filter(d => !removedIds.has(d.id) && d.date === entry.date && d.projectId === row.projectId)
            .sort((a, b) => b.id - a.id)[0];

          if (existingRec && existingRec.status === 'draft') {
            if (existingRec.submissionGroupId) {
              const oldSubGroupId = existingRec.submissionGroupId;
              deprecateInLoop.push(existingRec.id);
              removedIds.add(existingRec.id);
              records.push(txService.createRecord({
                userId,
                projectId: row.projectId,
                date: entry.date,
                days: entry.days,
                description: row.description,
                previousGroupId: oldSubGroupId,
              }, orgSnapshot));
            } else {
              Object.assign(existingRec, orgSnapshot);
              existingRec.days = entry.days;
              existingRec.description = row.description || existingRec.description;
              records.push(existingRec);
            }
          } else if (existingRec && (existingRec.status === 'rejected' || existingRec.status === 'approved' || existingRec.status === 'submitted')) {
            const oldSubGroupId = existingRec.submissionGroupId;
            if (existingRec.status === 'submitted') {
              const groupIdKey = existingRec.submissionGroupId ?? 0;
              if (groupIdKey && !withdrawnGroupIds.has(groupIdKey)) {
                withdrawnGroupIds.add(groupIdKey);
                // 审批实例可能尚在队列未创建：无 instanceId 则跳过 withdraw
                if (existingRec.approvalInstanceId && submitter) {
                  try {
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
                  } catch (err) {
                    // 队列竞态：实例刚结束或不存在时仍允许 deprecate 并重提
                    if (!(err instanceof BusinessError) || !String(err.message).includes('无法撤回')) {
                      throw err;
                    }
                  }
                }
              }
              deprecateInLoop.push(existingRec.id);
              removedIds.add(existingRec.id);
            } else if (existingRec.status === 'rejected') {
              // 被驳回版本：废弃（保留历史），新建版本重新进入审批
              deprecateInLoop.push(existingRec.id);
              removedIds.add(existingRec.id);
            }
            // approved：审批窗口期保留旧版本（不 deprecate、不 removed），
            // 报表/周报在 v2 审批期间继续统计 v1；v2 通过时由 approvalService
            // 按 rootGroupId 整链废弃 v1；v2 被驳回时 v1 继续生效。
            records.push(txService.createRecord({
              userId,
              projectId: row.projectId,
              date: entry.date,
              days: entry.days,
              description: row.description,
              previousGroupId: oldSubGroupId || previousGroupId,
            }, orgSnapshot));
          } else {
            records.push(txService.createRecord({
              userId,
              projectId: row.projectId,
              date: entry.date,
              days: entry.days,
              description: row.description,
              previousGroupId,
            }, orgSnapshot));
          }
        }

        if (records.length === 0) continue;
        builtRows.push({
          projectId: row.projectId,
          description: row.description,
          records,
          totalDays: round2(row.entries.reduce((s, e) => s + e.days, 0)),
        });
      }

      // 跨提交日合计校验：本次载荷 + 载荷外仍活跃（approved/submitted）记录不得超过每日 1 天。
      // 载荷内 (projectId, date) 对应的旧版本已被覆盖/废弃，不计入。
      const payloadKeys = new Set<string>();
      for (const row of rows) {
        for (const e of row.entries) {
          if (e.days > 0) payloadKeys.add(`${row.projectId}:${e.date}`);
        }
      }
      txService.assertDailyCapAcrossSubmissions(dailyDays, existingRecords, removedIds, payloadKeys);

      if (deprecateInLoop.length) {
        await txService.repo.update({ id: In(deprecateInLoop) }, { status: 'deprecated' });
      }

      // 一次分配全部 submissionGroupId
      const groupIds = await txService.nextSubmissionGroupIds(builtRows.length);
      const allToSave: Timesheet[] = [];

      for (let i = 0; i < builtRows.length; i++) {
        const built = builtRows[i];
        const nextGroupId = groupIds[i];
        const rowPrevGroup = existingRecords
          .filter(r => r.projectId === built.projectId && r.submissionGroupId
            && (r.status !== 'draft' || removedIds.has(r.id)))
          .sort((a, b) => b.id - a.id)[0];
        const inheritedRoot = rowPrevGroup?.rootGroupId || null;

        for (const r of built.records) {
          r.submissionGroupId = nextGroupId;
          r.previousGroupId = rowPrevGroup?.submissionGroupId || previousGroupId;
          r.rootGroupId = inheritedRoot || nextGroupId;
          r.status = 'submitted';
          r.currentStep = 0;
          r.totalSteps = 0;
          r.approvalFlowId = null;
          r.approvalInstanceId = null;
        }
        allToSave.push(...built.records);
      }

      if (allToSave.length) {
        await txService.repo.save(allToSave);
      }

      for (const built of builtRows) {
        approvalJobs.push({
          targetId: built.records[0].id,
          recordIds: built.records.map(r => r.id),
          projectId: built.projectId,
          userId,
          title: `工时审批 ${built.totalDays}天`,
        });
      }
    }).catch((err) => {
      // 并发提交撞 (userId,projectId,date) 活跃唯一索引 → 友好提示，避免重复记录/重复审批实例
      if (isUniqueViolation(err)) throw new BusinessError('同一周工时正在提交，请刷新后重试');
      throw err;
    });

    const maybeWait = this.scheduleTimesheetApprovals(approvalJobs);
    if (maybeWait) await maybeWait;
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
  async modifySubmitted(userId: number, rows: { projectId: number; description: string; weekStart: string; entries: { date: string; days: number }[] }[]) {
    return this.submitByRows(userId, rows, { preserveOmittedProjects: true });
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
        totalDays: round2(recs.reduce((s, r) => s + Number(r.days), 0)),
        entries: recs.map(r => ({ id: r.id, date: r.date, days: Number(r.days) })),
      }));

    return { rootGroupId, groups };
  }

  /** 周汇总 — 默认按 date 取最大 submissionGroupId（最新版本）去重（含 submitted+approved）；
   *  approvedOnly=true 时仅统计已通过(approved)工时，供周报审批口径使用。 */
  async getWeeklySummary(userId: number, weekStart: string, weekEnd: string, options?: { approvedOnly?: boolean }) {
    const approvedOnly = !!options?.approvedOnly;
    const rawRecords = await this.repo.find({
      where: approvedOnly
        ? { userId, date: Between(weekStart, weekEnd), status: 'approved' as const }
        : { userId, date: Between(weekStart, weekEnd), status: Not('deprecated') },
      relations: ['project'],
    });

    const records = approvedOnly ? rawRecords : dedupByLatestSubmissionGroup(rawRecords);

    const byDate: Record<string, number> = {};
    for (const r of records) {
      byDate[r.date] = round2((byDate[r.date] || 0) + Number(r.days));
    }
    const totalDays = round2(Object.values(byDate).reduce((s, h) => s + h, 0));

    const byProject = records.reduce((acc, r) => {
      const key = r.project?.name || '未分配';
      acc[key] = round2((acc[key] || 0) + Number(r.days));
      return acc;
    }, {} as Record<string, number>);

    return { totalDays, byProject, records };
  }
}
