import { EntityManager } from 'typeorm';
import { AppDataSource } from '../config/database';
import { Timesheet } from '../entities/Timesheet';
import { OvertimeApplication } from '../entities/OvertimeApplication';
import { WeeklyReport } from '../entities/WeeklyReport';
import { ProjectWorkloadAllocation } from '../entities/ProjectWorkloadAllocation';
import { Group } from '../entities/Group';
import { Between, Not } from 'typeorm';
import { ApprovalService } from './approvalService';
import { AccessPolicyService, AccessViewer } from './accessPolicyService';
import { BusinessError } from '../utils/errors';
import { round2 } from '../utils/validation';
import { collectGroupCoverage, sumConsumption } from '../utils/timesheetConsumption';
import { businessMonthRange, businessWeekRange } from '../utils/time';

type SummaryWithCount = { days: number; count: number };
type SummaryHours = { days: number };

export type ReportFilters = {
  departmentId?: number;
  departmentIds?: number[];
  groupId?: number;
  groupIds?: number[];
  userId?: number;
};

const UNKNOWN_USER = '未知人员';
const UNKNOWN_PROJECT = '未分配项目';
const UNKNOWN_DEPARTMENT = '未分配部门';
const UNKNOWN_GROUP = '未分配组别';

const formatLocalDate = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

function addCountSummary(target: Record<string, SummaryWithCount>, key: string, days: number) {
  if (!target[key]) target[key] = { days: 0, count: 0 };
  // 累加后 round2，避免浮点尾巴（如 0.3+0.3+...→1.7999...）。与 addDaysSummary 对齐。
  target[key].days = round2(target[key].days + days);
  target[key].count += 1;
}

function addHoursSummary(target: Record<string, SummaryHours>, key: string, days: number) {
  if (!target[key]) target[key] = { days: 0 };
  target[key].days = round2(target[key].days + days);
}

function totalOfDates(byDate: Record<string, number>) {
  return round2(Object.values(byDate).reduce((sum, days) => sum + days, 0));
}

/**
 * 报表日期范围上限保护（防 OOM）：默认最多 366 天。
 * 报表/导出目前会把范围内记录全部载入内存做去重与汇总，过大的范围（如 10 年）
 * 可能拉取海量记录导致进程 OOM。这里在入口处拒绝超大范围，提示缩小查询条件。
 * 完整的流式/分批重构改动较大，暂以范围上限 + 注释作为兜底防护。
 */
const REPORT_MAX_RANGE_DAYS = 366;
export function assertReportRange(startDate: string, endDate: string, maxDays = REPORT_MAX_RANGE_DAYS) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new BusinessError('报表日期范围格式无效');
  }
  const diffDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000);
  if (diffDays > maxDays) {
    throw new BusinessError(`报表日期范围不能超过 ${maxDays} 天，请缩小查询范围`);
  }
}

/**
 * 报表工时去重：按 (userId, projectId, date) 取最新的已审批通过（approved）的 submissionGroup 的记录。
 * 抽成独立导出函数便于单元测试。
 *
 * 版本化语义：
 *   - 同一天同一版本链可能有多个 submissionGroup（v1 approved, v2 submitted...）
 *   - 报表只统计 approved：取该 (userId, projectId, date) 下 submissionGroupId 最大的 approved 记录
 *   - v2 审批中时统计 v1，v2 通过后 v1 被 deprecate，统计 v2
 *   - 同一天多项目各自独立统计（submitByRows 每个 projectId 独立分配 submissionGroupId，故必须带 projectId 维度）
 */
export function dedupReportTimesheets(records: Timesheet[]): Timesheet[] {
  // 找出每个 (userId, projectId, date) 对应的最大的 approved submissionGroupId
  const maxApprovedGroupByKey = new Map<string, number>();
  for (const r of records) {
    if (r.status !== 'approved' || !r.submissionGroupId) continue;
    const key = `${r.userId}_${r.projectId}_${r.date}`;
    const cur = maxApprovedGroupByKey.get(key);
    if (cur === undefined || r.submissionGroupId > cur) {
      maxApprovedGroupByKey.set(key, r.submissionGroupId);
    }
  }
  // 只保留属于该 (userId, projectId, date) 最大 approved submissionGroupId 的 approved 记录
  return records.filter(r => {
    if (r.status !== 'approved') return false;
    const key = `${r.userId}_${r.projectId}_${r.date}`;
    // submissionGroupId 为 null 的历史 approved（特性上线前提交、未经版本链）：
    // 仅当该 key 不存在带组号的 approved 时纳入，避免这些历史工时从报表/导出中消失、合计偏低。
    if (!r.submissionGroupId) return !maxApprovedGroupByKey.has(key);
    return r.submissionGroupId === maxApprovedGroupByKey.get(key);
  });
}

export class ReportService {
  constructor(private manager?: EntityManager) {}

  private get timesheetRepo() { return (this.manager ?? AppDataSource).getRepository(Timesheet); }
  private get overtimeRepo() { return (this.manager ?? AppDataSource).getRepository(OvertimeApplication); }
  private get weeklyReportRepo() { return (this.manager ?? AppDataSource).getRepository(WeeklyReport); }
  private get approvalService() { return new ApprovalService(this.manager); }
  private get allocationRepo() { return (this.manager ?? AppDataSource).getRepository(ProjectWorkloadAllocation); }
  private get groupRepo() { return (this.manager ?? AppDataSource).getRepository(Group); }

  /**
   * 超投统计：项目 × 配额组的「配额 vs 实际消耗」。
   *
   * 口径与审批单配额警告（approvalService.buildTimesheetQuota）完全一致：
   * - 消耗 = submitted + approved 工时，按 (userId, projectId, date) 最新版本去重
   * - 配额组覆盖范围 = 配额组及其全部子孙组（path 前缀，成员按当前所在组归属）
   * - 配额 = 当前配置值（配额变更影响历史结论，界面注明）
   * 查看范围受报表权限裁剪（report:view:project / report:view:all 的可访问项目）。
   */
  async getOverrunStats(
    viewer: AccessViewer,
    params: { startDate: string; endDate: string; projectId?: number; groupId?: number },
  ) {
    const { startDate, endDate, projectId, groupId } = params;
    const accessPolicy = new AccessPolicyService(this.manager);
    const accessibleProjectIds = await accessPolicy.getAccessibleProjectIds(viewer, ['report:view:project', 'report:view:all']);
    if (accessibleProjectIds !== null && accessibleProjectIds.length === 0) {
      return { list: [], total: 0 };
    }

    // 1. 配额配置（裁剪到可访问项目，可选按项目/组过滤）
    const allocQb = this.allocationRepo.createQueryBuilder('a')
      .leftJoinAndSelect('a.project', 'project')
      .leftJoinAndSelect('a.group', 'group');
    if (projectId) allocQb.andWhere('a.projectId = :projectId', { projectId });
    if (groupId) allocQb.andWhere('a.groupId = :groupId', { groupId });
    if (accessibleProjectIds !== null) {
      allocQb.andWhere('a.projectId IN (:...projectIds)', { projectIds: accessibleProjectIds });
    }
    const allocations = await allocQb.getMany();
    if (!allocations.length) return { list: [], total: 0 };

    // 2. 配额组覆盖集合（配额组 + 全部子孙组）
    const allGroups = await this.groupRepo.find({ select: { id: true, path: true } });
    const coverageByQuotaGroup = new Map<number, Set<number>>();
    for (const a of allocations) {
      coverageByQuotaGroup.set(a.groupId, collectGroupCoverage(allGroups, a.groupId));
    }

    // 3. 时间范围内活跃工时（submitted + approved），带用户当前所在组
    const allocProjectIds = [...new Set(allocations.map((a) => a.projectId))];
    const rows = await this.timesheetRepo.createQueryBuilder('t')
      .innerJoin('users', 'u', 'u.id = t.userId')
      .where('t.projectId IN (:...projectIds)', { projectIds: allocProjectIds })
      .andWhere('t.date >= :startDate', { startDate })
      .andWhere('t.date <= :endDate', { endDate })
      .andWhere('t.status IN (:...statuses)', { statuses: ['submitted', 'approved'] })
      // 显式别名：无别名时 Postgres raw 列名带表前缀（t_userId），取键会得到 undefined
      .select('t.userId', 'userId')
      .addSelect('t.projectId', 'projectId')
      .addSelect('t.date', 'date')
      .addSelect('t.days', 'days')
      .addSelect('t.submissionGroupId', 'submissionGroupId')
      .addSelect('u.groupId', 'userGroupId')
      .getRawMany<{
        userId: number;
        projectId: number;
        date: string;
        days: string | number;
        submissionGroupId: number | null;
        userGroupId: number | null;
      }>();

    // 4. 按 (userId, projectId, date) 最新组去重，得到有效行（与审批配额同口径）
    const maxGroupByKey = new Map<string, number>();
    for (const r of rows) {
      if (!r.submissionGroupId) continue;
      const key = `${r.userId}_${r.projectId}_${r.date}`;
      const cur = maxGroupByKey.get(key);
      if (cur === undefined || r.submissionGroupId > cur) maxGroupByKey.set(key, r.submissionGroupId);
    }
    const effectiveRows = rows.filter((r) => {
      if (r.submissionGroupId) {
        return r.submissionGroupId === maxGroupByKey.get(`${r.userId}_${r.projectId}_${r.date}`);
      }
      return !maxGroupByKey.has(`${r.userId}_${r.projectId}_${r.date}`);
    });

    // 5. 逐配额组计算消耗/剩余/超投（成员当前组 ∈ 配额组覆盖范围）
    const list = allocations.map((a) => {
      const coverage = coverageByQuotaGroup.get(a.groupId) ?? new Set<number>();
      const consumed = sumConsumption(
        effectiveRows.filter((r) => r.projectId === a.projectId && r.userGroupId !== null && coverage.has(r.userGroupId)),
      );
      const total = round2(Number(a.allocation));
      const remaining = round2(total - consumed);
      const overrun = round2(Math.max(0, consumed - total));
      const overrunRate = total > 0 ? round2((overrun / total) * 100) : 0;
      return {
        projectId: a.projectId,
        projectName: a.project?.name || '',
        projectCode: (a.project as { code?: string } | undefined)?.code || '',
        groupId: a.groupId,
        groupName: a.group?.name || a.groupName || '',
        allocation: total,
        consumed,
        remaining,
        overrun,
        overrunRate,
      };
    }).sort((x, y) => y.overrun - x.overrun || y.consumed - x.consumed);

    return { list, total: list.length };
  }

  private dedupTimesheets(records: Timesheet[]): Timesheet[] {
    return dedupReportTimesheets(records);
  }

  private summarizeTimesheets(records: Timesheet[]) {
    const byDate: Record<string, number> = {};
    const byUser: Record<string, SummaryWithCount> = {};
    const byProject: Record<string, SummaryWithCount> = {};
    const byDepartment: Record<string, SummaryWithCount> = {};
    const byGroup: Record<string, SummaryWithCount> = {};

    for (const record of records) {
      const days = Number(record.days);
      const user = record.user as any;
      const project = record.project as any;
      const departmentName = record.departmentSnapshotName || UNKNOWN_DEPARTMENT;
      const groupName = record.groupSnapshotName || UNKNOWN_GROUP;

      byDate[record.date] = round2((byDate[record.date] || 0) + days);
      addCountSummary(byUser, user?.realName || UNKNOWN_USER, days);
      addCountSummary(byProject, project?.name || UNKNOWN_PROJECT, days);
      addCountSummary(byDepartment, departmentName, days);
      addCountSummary(byGroup, groupName, days);
    }

    return {
      totalDays: totalOfDates(byDate),
      byDate,
      byUser,
      byProject,
      byDepartment,
      byGroup,
      records,
    };
  }

  /**
   * 查询报表用工时记录。
   *
   * 统计口径：只统计 approved（已审批通过）。
   * 版本化去重：由 dedupReportTimesheets 按 (userId, date) 取最大 approved submissionGroup，
   * 确保修改期间旧版本（仍 approved）正常统计，新版本通过后才替代。
   */
  private async getReportTimesheets(startDate: string, endDate: string, filters: ReportFilters = {}) {
    const qb = this.timesheetRepo.createQueryBuilder('t')
      .leftJoinAndSelect('t.user', 'u')
      .leftJoinAndSelect('t.project', 'p')
      .where('t.date BETWEEN :start AND :end', { start: startDate, end: endDate })
      .andWhere('t.status = :status', { status: 'approved' });

    if (filters.userId) qb.andWhere('t.userId = :userId', { userId: filters.userId });
    if (filters.departmentIds?.length) qb.andWhere('t.departmentSnapshotId IN (:...departmentIds)', { departmentIds: filters.departmentIds });
    else if (filters.departmentId) qb.andWhere('t.departmentSnapshotId = :departmentId', { departmentId: filters.departmentId });
    if (filters.groupIds?.length) qb.andWhere('t.groupSnapshotId IN (:...groupIds)', { groupIds: filters.groupIds });
    else if (filters.groupId) qb.andWhere('t.groupSnapshotId = :groupId', { groupId: filters.groupId });

    return this.dedupTimesheets(await qb.getMany());
  }

  async getPersonalReport(userId: number, startDate: string, endDate: string) {
    assertReportRange(startDate, endDate);
    const records = await this.getReportTimesheets(startDate, endDate, { userId });
    return this.summarizeTimesheets(records);
  }

  async getGroupReport(groupId: number, startDate: string, endDate: string, groupIds?: number[]) {
    assertReportRange(startDate, endDate);
    const records = await this.getReportTimesheets(startDate, endDate, { groupId, groupIds });
    return this.summarizeTimesheets(records);
  }

  async getDepartmentReport(departmentId: number, startDate: string, endDate: string, filters: ReportFilters = {}) {
    assertReportRange(startDate, endDate);
    const records = await this.getReportTimesheets(startDate, endDate, { ...filters, departmentId });
    return this.summarizeTimesheets(records);
  }

  async getProjectReport(projectId: number, startDate: string, endDate: string, filters: ReportFilters = {}) {
    assertReportRange(startDate, endDate);
    const qb = this.timesheetRepo.createQueryBuilder('t')
      .leftJoinAndSelect('t.user', 'u')
      .leftJoinAndSelect('t.project', 'p')
      .where('p.id = :projectId', { projectId })
      .andWhere('t.date BETWEEN :start AND :end', { start: startDate, end: endDate })
      // 只统计 approved：dedupReportTimesheets 会丢弃 submitted/draft 等状态，
      // 此前同时拉取 submitted 属于无效查询（必然被去重丢弃），这里改为只查 approved，
      // 与 getReportTimesheets 口径一致，减少无效数据载入。
      .andWhere('t.status = :status', { status: 'approved' });

    if (filters.departmentIds?.length) qb.andWhere('t.departmentSnapshotId IN (:...departmentIds)', { departmentIds: filters.departmentIds });
    else if (filters.departmentId) qb.andWhere('t.departmentSnapshotId = :departmentId', { departmentId: filters.departmentId });
    if (filters.groupIds?.length) qb.andWhere('t.groupSnapshotId IN (:...groupIds)', { groupIds: filters.groupIds });
    else if (filters.groupId) qb.andWhere('t.groupSnapshotId = :groupId', { groupId: filters.groupId });
    if (filters.userId) qb.andWhere('t.userId = :userId', { userId: filters.userId });

    const records = this.dedupTimesheets(await qb.getMany());
    return this.summarizeTimesheets(records);
  }

  async getOvertimeReport(params: { departmentId?: number; departmentIds?: number[]; groupId?: number; groupIds?: number[]; projectId?: number; projectIds?: number[]; userId?: number; startDate: string; endDate: string; matchAnyScope?: boolean; allowAll?: boolean }) {
    const {
      departmentId, departmentIds, groupId, groupIds, projectId, projectIds,
      userId, startDate, endDate, matchAnyScope, allowAll,
    } = params;
    // 安全防护：无任何数据范围约束时拒绝执行，避免全表泄露（调用方必须保证至少一个范围）
    const hasScope = departmentId || departmentIds?.length || groupId || groupIds?.length
      || projectId || projectIds?.length || userId;
    if (!hasScope && !allowAll) {
      throw new BusinessError('加班报表缺少数据范围约束');
    }
    assertReportRange(startDate, endDate);
    const qb = this.overtimeRepo.createQueryBuilder('o')
      .leftJoinAndSelect('o.user', 'u')
      .leftJoinAndSelect('o.project', 'p')
      .where('o.date BETWEEN :start AND :end', { start: startDate, end: endDate })
      .andWhere('o.status = :status', { status: 'approved' });

    if (matchAnyScope) {
      const scopeConditions: string[] = [];
      if (departmentIds?.length) scopeConditions.push('o.departmentSnapshotId IN (:...departmentIds)');
      else if (departmentId) scopeConditions.push('o.departmentSnapshotId = :departmentId');
      if (groupIds?.length) scopeConditions.push('o.groupSnapshotId IN (:...groupIds)');
      else if (groupId) scopeConditions.push('o.groupSnapshotId = :groupId');
      if (projectIds?.length) scopeConditions.push('o.projectId IN (:...projectIds)');
      else if (projectId) scopeConditions.push('o.projectId = :projectId');
      if (scopeConditions.length) qb.andWhere(`(${scopeConditions.join(' OR ')})`, {
        departmentIds, departmentId, groupIds, groupId, projectIds, projectId,
      });
    } else {
      if (departmentIds?.length) qb.andWhere('o.departmentSnapshotId IN (:...departmentIds)', { departmentIds });
      else if (departmentId) qb.andWhere('o.departmentSnapshotId = :departmentId', { departmentId });
      if (groupIds?.length) qb.andWhere('o.groupSnapshotId IN (:...groupIds)', { groupIds });
      else if (groupId) qb.andWhere('o.groupSnapshotId = :groupId', { groupId });
      if (projectIds?.length) qb.andWhere('o.projectId IN (:...projectIds)', { projectIds });
      else if (projectId) qb.andWhere('o.projectId = :projectId', { projectId });
    }
    if (userId) qb.andWhere('o.userId = :userId', { userId });

    const records = await qb.getMany();
    const totalDays = round2(records.reduce((sum, record) => sum + Number(record.days), 0));
    const byType = records.reduce((acc, record) => {
      acc[record.overtimeType] = round2((acc[record.overtimeType] || 0) + Number(record.days));
      return acc;
    }, {} as Record<string, number>);
    const byUser = records.reduce((acc, record) => {
      const key = record.user?.realName || UNKNOWN_USER;
      acc[key] = round2((acc[key] || 0) + Number(record.days));
      return acc;
    }, {} as Record<string, number>);
    // 已知不一致（保留，未统一）：加班报表的 byUser 为 Record<string, number>（仅天数），
    // 而普通报表（summarizeTimesheets）的 byUser 为 Record<string, { days, count }>。
    // 强行统一会同时破坏 server 集成测试（reportService.integration.test.ts 断言数字形态）
    // 与前端契约（Report.test.tsx 的加班 mock 也按数字形态），属于跨层契约变更，风险超出本 LOW 修复范围。
    // 如后续要统一，建议统一到 { days, count } 并同步更新前端与测试。
    const byGroup = records.reduce((acc, record) => {
      addHoursSummary(acc, record.groupSnapshotName || UNKNOWN_GROUP, Number(record.days));
      return acc;
    }, {} as Record<string, SummaryHours>);

    return { totalDays, byType, byUser, byGroup, records };
  }

  async getDashboardData(userId: number, visibility: {
    timesheet: boolean;
    overtime: boolean;
    approvals: boolean;
    weeklyReport: boolean;
  }) {
    // 周/月边界统一按业务时区 Asia/Shanghai 计算，避免容器 UTC 部署下边界偏移 8 小时
    const { monthStart, monthEnd } = businessMonthRange();
    const { weekStart, weekEnd } = businessWeekRange();

    // 本月工时：一次查询同时算 monthDays 和 trend（两者 where 条件相同，避免重复查询）
    const [monthTimesheets, pendingResult, monthOvertime, draftTimesheetCount, weeklyReport] = await Promise.all([
      visibility.timesheet
        ? this.timesheetRepo.find({
          where: { userId, date: Between(monthStart, monthEnd), status: Not('deprecated') },
          order: { date: 'ASC' },
        })
        : Promise.resolve([]),
      visibility.approvals
        ? this.approvalService.getPendingList(userId, { page: 1, pageSize: 1 })
        : Promise.resolve({ total: 0 }),
      visibility.overtime
        ? this.overtimeRepo.find({
          where: { userId, date: Between(monthStart, monthEnd), status: 'approved' },
        })
        : Promise.resolve([]),
      visibility.timesheet
        ? this.timesheetRepo.count({
          where: { userId, date: Between(weekStart, weekEnd), status: 'draft' },
        })
        : Promise.resolve(0),
      visibility.weeklyReport
        ? this.weeklyReportRepo.findOne({ where: { userId, weekStart } })
        : Promise.resolve(null),
    ]);
    const monthByDate: Record<string, number> = {};
    for (const record of monthTimesheets) {
      monthByDate[record.date] = round2((monthByDate[record.date] || 0) + Number(record.days));
    }
    const monthDays = totalOfDates(monthByDate);
    const trend = Object.entries(monthByDate).map(([date, days]) => ({ date, days }));

    const pendingCount = pendingResult.total;
    const overtimeDays = round2(monthOvertime.reduce((sum, record) => sum + Number(record.days), 0));

    return {
      monthDays,
      overtimeDays,
      pendingCount,
      trend,
      hasTimesheetDrafts: draftTimesheetCount > 0,
      weeklyReportStatus: weeklyReport?.status ?? null,
    };
  }
}
