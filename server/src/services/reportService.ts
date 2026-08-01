import { EntityManager } from 'typeorm';
import { AppDataSource } from '../config/database';
import { Timesheet } from '../entities/Timesheet';
import { OvertimeApplication } from '../entities/OvertimeApplication';
import { WeeklyReport } from '../entities/WeeklyReport';
import { ProjectWorkloadAllocation } from '../entities/ProjectWorkloadAllocation';
import { ApprovalInstance } from '../entities/ApprovalInstance';
import { Group } from '../entities/Group';
import { User } from '../entities/User';
import { Between } from 'typeorm';
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

/**
 * 按 (userId, projectId, date) 对指定状态的行取最新 submissionGroup 求和。
 * 与 dedupReportTimesheets 同规则（无组号行仅在无带组号行时保留），供状态分布使用：
 * approved / submitted 各有版本链，分别去重后相加，保证「各状态之和」不因窗口期多版本而虚高。
 */
export function sumLatestByStatus(records: Timesheet[], status: Timesheet['status']): number {
  const maxGroupByKey = new Map<string, number>();
  for (const r of records) {
    if (r.status !== status || !r.submissionGroupId) continue;
    const key = `${r.userId}_${r.projectId}_${r.date}`;
    const cur = maxGroupByKey.get(key);
    if (cur === undefined || r.submissionGroupId > cur) {
      maxGroupByKey.set(key, r.submissionGroupId);
    }
  }
  let sum = 0;
  for (const r of records) {
    if (r.status !== status) continue;
    const key = `${r.userId}_${r.projectId}_${r.date}`;
    if (r.submissionGroupId) {
      if (r.submissionGroupId === maxGroupByKey.get(key)) sum += Number(r.days);
    } else if (!maxGroupByKey.has(key)) {
      sum += Number(r.days);
    }
  }
  return round2(sum);
}

export class ReportService {
  constructor(private manager?: EntityManager) {}

  private get timesheetRepo() { return (this.manager ?? AppDataSource).getRepository(Timesheet); }
  private get overtimeRepo() { return (this.manager ?? AppDataSource).getRepository(OvertimeApplication); }
  private get weeklyReportRepo() { return (this.manager ?? AppDataSource).getRepository(WeeklyReport); }
  private get approvalService() { return new ApprovalService(this.manager); }
  private get allocationRepo() { return (this.manager ?? AppDataSource).getRepository(ProjectWorkloadAllocation); }
  private get groupRepo() { return (this.manager ?? AppDataSource).getRepository(Group); }
  private get instanceRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalInstance); }
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }

  /**
   * 超投统计基础：查询配额配置、组覆盖集合与去重后的有效消耗行。
   * stats（汇总）与 trend（月度）共用，保证两个视图口径一致。
   *
   * 口径：
   * - consumedScope='all'（默认，与审批单配额警告一致）：submitted + approved
   * - consumedScope='approved'（结算口径）：仅已通过
   * - 版本去重：按 (userId, projectId, date) 取最新 submissionGroupId
   * - 配额组覆盖范围 = 配额组及其全部子孙组（path 前缀，成员按当前所在组归属）
   */
  private async loadOverrunBase(
    viewer: AccessViewer,
    params: { startDate: string; endDate: string; projectId?: number; groupId?: number; consumedScope?: 'all' | 'approved' },
  ) {
    const { startDate, endDate, projectId, groupId, consumedScope = 'all' } = params;
    const accessPolicy = new AccessPolicyService(this.manager);
    const accessibleProjectIds = await accessPolicy.getAccessibleProjectIds(viewer, ['report:view:project', 'report:view:all']);
    if (accessibleProjectIds !== null && accessibleProjectIds.length === 0) {
      return { allocations: [], effectiveRows: [], coverageByQuotaGroup: new Map<number, Set<number>>(), allGroups: [] };
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
    if (!allocations.length) {
      return { allocations: [], effectiveRows: [], coverageByQuotaGroup: new Map<number, Set<number>>(), allGroups: [] };
    }

    // 2. 配额组覆盖集合（配额组 + 全部子孙组）
    const allGroups = await this.groupRepo.find({ select: { id: true, path: true, name: true } });
    const coverageByQuotaGroup = new Map<number, Set<number>>();
    for (const a of allocations) {
      coverageByQuotaGroup.set(a.groupId, collectGroupCoverage(allGroups, a.groupId));
    }

    // 3. 时间范围内活跃工时（按口径过滤状态），带用户当前所在组
    const allocProjectIds = [...new Set(allocations.map((a) => a.projectId))];
    const qb = this.timesheetRepo.createQueryBuilder('t')
      .innerJoin('users', 'u', 'u.id = t.userId')
      .where('t.projectId IN (:...projectIds)', { projectIds: allocProjectIds })
      .andWhere('t.date >= :startDate', { startDate })
      .andWhere('t.date <= :endDate', { endDate });
    if (consumedScope === 'approved') {
      qb.andWhere('t.status = :approved', { approved: 'approved' });
    } else {
      qb.andWhere('t.status IN (:...statuses)', { statuses: ['submitted', 'approved'] });
    }
    const rows = await qb
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

    return { allocations, effectiveRows, coverageByQuotaGroup, allGroups };
  }

  /** 超投统计：项目 × 配额组的「配额 vs 实际消耗」汇总。 */
  async getOverrunStats(
    viewer: AccessViewer,
    params: { startDate: string; endDate: string; projectId?: number; groupId?: number; consumedScope?: 'all' | 'approved' },
  ) {
    const { startDate, endDate, projectId, groupId, consumedScope = 'all' } = params;
    const { allocations, effectiveRows, coverageByQuotaGroup, allGroups } =
      await this.loadOverrunBase(viewer, { startDate, endDate, projectId, groupId, consumedScope });
    if (!allocations.length) return { list: [], total: 0 };

    const groupNameById = new Map(allGroups.map((g) => [g.id, g.name]));

    // 逐配额组计算消耗/剩余/超投，并给出成员组分解（供前端展开下钻）
    const list = allocations.map((a) => {
      const coverage = coverageByQuotaGroup.get(a.groupId) ?? new Set<number>();
      const memberRows = effectiveRows.filter(
        (r) => r.projectId === a.projectId && r.userGroupId !== null && coverage.has(r.userGroupId),
      );
      const consumed = sumConsumption(memberRows);
      // 成员组分解：按成员当前所在组聚合（仅覆盖范围内）
      const byGroupMap = new Map<number, number>();
      for (const r of memberRows) {
        if (r.userGroupId === null) continue;
        byGroupMap.set(r.userGroupId, round2((byGroupMap.get(r.userGroupId) ?? 0) + Number(r.days)));
      }
      const consumedByGroup = [...byGroupMap.entries()]
        .map(([gid, days]) => ({ groupId: gid, groupName: groupNameById.get(gid) || '', days }))
        .sort((x, y) => y.days - x.days);
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
        consumedByGroup,
      };
    }).sort((x, y) => y.overrun - x.overrun || y.consumed - x.consumed);

    return { list, total: list.length };
  }

  /**
   * 超投月度趋势：每个 (项目 × 配额组) 在各月的消耗与超投（配额取当前配置值）。
   * 返回按月份升序的序列，前端据此绘制折线图。
   */
  async getOverrunTrend(
    viewer: AccessViewer,
    params: { startDate: string; endDate: string; projectId?: number; groupId?: number; consumedScope?: 'all' | 'approved' },
  ) {
    const { startDate, endDate, projectId, groupId, consumedScope = 'all' } = params;
    const { allocations, effectiveRows, coverageByQuotaGroup } =
      await this.loadOverrunBase(viewer, { startDate, endDate, projectId, groupId, consumedScope });
    if (!allocations.length) return { list: [], total: 0 };

    // 对每个配额组：过滤覆盖范围内的有效行后按月份累计
    const list: Array<{
      month: string;
      projectId: number;
      projectName: string;
      groupId: number;
      groupName: string;
      allocation: number;
      consumed: number;
      overrun: number;
    }> = [];
    for (const a of allocations) {
      const coverage = coverageByQuotaGroup.get(a.groupId) ?? new Set<number>();
      const monthMap = new Map<string, number>();
      for (const r of effectiveRows) {
        if (r.projectId !== a.projectId || r.userGroupId === null || !coverage.has(r.userGroupId)) continue;
        const month = r.date.slice(0, 7); // YYYY-MM
        monthMap.set(month, round2((monthMap.get(month) ?? 0) + Number(r.days)));
      }
      const total = round2(Number(a.allocation));
      for (const [month, consumed] of monthMap) {
        list.push({
          month,
          projectId: a.projectId,
          projectName: a.project?.name || '',
          groupId: a.groupId,
          groupName: a.group?.name || a.groupName || '',
          allocation: total,
          consumed,
          overrun: round2(Math.max(0, consumed - total)),
        });
      }
    }
    list.sort((x, y) => x.month.localeCompare(y.month) || x.projectId - y.projectId || x.groupId - y.groupId);
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
    // 与普通报表（summarizeTimesheets）统一为 { days, count } 形态，避免跨报表契约分裂
    const byUser = records.reduce((acc, record) => {
      addCountSummary(acc, record.user?.realName || UNKNOWN_USER, Number(record.days));
      return acc;
    }, {} as Record<string, SummaryWithCount>);
    const byGroup = records.reduce((acc, record) => {
      addHoursSummary(acc, record.groupSnapshotName || UNKNOWN_GROUP, Number(record.days));
      return acc;
    }, {} as Record<string, SummaryHours>);

    return { totalDays, byType, byUser, byGroup, records };
  }

  /**
   * 工时状态分布：approved / submitted / draft 各自按最新版本去重求和。
   *
   * 与主统计的关系：approved 档与报表主统计完全一致（同为 dedup 规则）；
   * submitted 档补上「已提交未审批」的负荷视角，draft 档为未提交草稿。
   * 各档独立去重，窗口期（v1 approved + v2 submitted 并存）下三档之和仍可能大于
   * 最新版本视图，但每一档数字本身是准确的，且不会因多版本双计虚高。
   */
  async getStatusBreakdown(startDate: string, endDate: string, filters: ReportFilters = {}) {
    assertReportRange(startDate, endDate);
    const qb = this.timesheetRepo.createQueryBuilder('t')
      .where('t.date BETWEEN :start AND :end', { start: startDate, end: endDate })
      .andWhere('t.status != :deprecated', { deprecated: 'deprecated' });
    if (filters.userId) qb.andWhere('t.userId = :userId', { userId: filters.userId });
    if (filters.departmentIds?.length) qb.andWhere('t.departmentSnapshotId IN (:...departmentIds)', { departmentIds: filters.departmentIds });
    else if (filters.departmentId) qb.andWhere('t.departmentSnapshotId = :departmentId', { departmentId: filters.departmentId });
    if (filters.groupIds?.length) qb.andWhere('t.groupSnapshotId IN (:...groupIds)', { groupIds: filters.groupIds });
    else if (filters.groupId) qb.andWhere('t.groupSnapshotId = :groupId', { groupId: filters.groupId });
    const records = await qb.getMany();
    return {
      approved: sumLatestByStatus(records, 'approved'),
      submitted: sumLatestByStatus(records, 'submitted'),
      draft: sumLatestByStatus(records, 'draft'),
    };
  }

  /**
   * 提交覆盖度：范围内在职成员数 vs 期间有工时提交（approved / submitted）的成员数。
   *
   * 分子分母同口径（均按成员当前组织归属），避免调岗导致快照归属与在职名单不一致。
   * 覆盖度用 distinct userId，不受版本去重影响。
   */
  async getCoverage(filters: {
    departmentId?: number;
    departmentIds?: number[];
    groupId?: number;
    groupIds?: number[];
    startDate: string;
    endDate: string;
  }) {
    const { departmentId, departmentIds, groupId, groupIds, startDate, endDate } = filters;
    assertReportRange(startDate, endDate);
    const memberQb = this.userRepo.createQueryBuilder('u').where('u.status = 1');
    if (departmentId) memberQb.andWhere('u.departmentId = :departmentId', { departmentId });
    else if (departmentIds?.length) memberQb.andWhere('u.departmentId IN (:...departmentIds)', { departmentIds });
    if (groupId) memberQb.andWhere('u.groupId = :groupId', { groupId });
    else if (groupIds?.length) memberQb.andWhere('u.groupId IN (:...groupIds)', { groupIds });
    const memberCount = await memberQb.getCount();

    const submitQb = this.timesheetRepo.createQueryBuilder('t')
      .innerJoin('users', 'u', 'u.id = t.userId AND u.status = 1')
      .where('t.date BETWEEN :start AND :end', { start: startDate, end: endDate })
      .andWhere("t.status IN ('approved', 'submitted')");
    if (departmentId) submitQb.andWhere('u.departmentId = :departmentId', { departmentId });
    else if (departmentIds?.length) submitQb.andWhere('u.departmentId IN (:...departmentIds)', { departmentIds });
    if (groupId) submitQb.andWhere('u.groupId = :groupId', { groupId });
    else if (groupIds?.length) submitQb.andWhere('u.groupId IN (:...groupIds)', { groupIds });
    const row = await submitQb
      .select('COUNT(DISTINCT t.userId)', 'cnt')
      .getRawOne<{ cnt: string | number }>();
    const submittedUserCount = Number(row?.cnt ?? 0);
    const coverageRate = memberCount > 0 ? round2((submittedUserCount / memberCount) * 100) : 0;
    return { memberCount, submittedUserCount, coverageRate };
  }

  /**
   * 审批效率：范围内工时单的审批时效与驳回率。
   *
   * 统计对象为 timesheet 类型的审批实例（ApprovalInstance，targetId 挂在提交组首行），
   * 按工时日期与快照组织范围过滤（与报表同期同范围）；只统计已闭合实例
   * （approved / rejected），平均时长 = submittedAt → finishedAt。
   */
  async getApprovalEfficiency(filters: {
    departmentId?: number;
    departmentIds?: number[];
    groupId?: number;
    groupIds?: number[];
    projectId?: number;
    userId?: number;
    startDate: string;
    endDate: string;
  }) {
    const { startDate, endDate } = filters;
    assertReportRange(startDate, endDate);
    const qb = this.instanceRepo.createQueryBuilder('i')
      .innerJoin('timesheets', 't', 't.id = i."targetId"')
      .where('i."targetType" = :tt', { tt: 'timesheet' })
      .andWhere('t.date BETWEEN :start AND :end', { start: startDate, end: endDate });
    if (filters.departmentId) qb.andWhere('t."departmentSnapshotId" = :departmentId', { departmentId: filters.departmentId });
    else if (filters.departmentIds?.length) qb.andWhere('t."departmentSnapshotId" IN (:...departmentIds)', { departmentIds: filters.departmentIds });
    if (filters.groupId) qb.andWhere('t."groupSnapshotId" = :groupId', { groupId: filters.groupId });
    else if (filters.groupIds?.length) qb.andWhere('t."groupSnapshotId" IN (:...groupIds)', { groupIds: filters.groupIds });
    if (filters.projectId) qb.andWhere('t.projectId = :projectId', { projectId: filters.projectId });
    if (filters.userId) qb.andWhere('t.userId = :userId', { userId: filters.userId });
    // 显式别名：raw 列名带表前缀（i_status）会导致取键 undefined
    const rows = await qb
      .select('i.status', 'status')
      .addSelect('i.submittedAt', 'submittedAt')
      .addSelect('i.finishedAt', 'finishedAt')
      .getRawMany<{ status: string; submittedAt: string | Date; finishedAt: string | Date | null }>();

    let durationMs = 0;
    let closedCount = 0;
    let rejectedCount = 0;
    for (const r of rows) {
      if (r.status === 'rejected') rejectedCount++;
      if (r.status === 'approved' || r.status === 'rejected') {
        closedCount++;
        if (r.finishedAt && r.submittedAt) {
          durationMs += new Date(r.finishedAt).getTime() - new Date(r.submittedAt).getTime();
        }
      }
    }
    const avgDurationHours = closedCount > 0 ? round2(durationMs / closedCount / 3_600_000) : 0;
    const rejectRate = closedCount > 0 ? round2((rejectedCount / closedCount) * 100) : 0;
    return { avgDurationHours, closedCount, rejectedCount, rejectRate };
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
    // 口径与报表一致：仅 approved + 版本去重（dedupReportTimesheets 按 (user,project,date) 取最大
    // approved submissionGroup）。此前用 status != deprecated 会同时计入草稿/审批中且窗口期新旧版本双计，
    // 与报表页数字对不上账。
    const [monthTimesheets, pendingResult, monthOvertime, draftTimesheetCount, weeklyReport] = await Promise.all([
      visibility.timesheet
        ? this.timesheetRepo.find({
          where: { userId, date: Between(monthStart, monthEnd), status: 'approved' },
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
    const effectiveRecords = this.dedupTimesheets(monthTimesheets);
    const monthByDate: Record<string, number> = {};
    for (const record of effectiveRecords) {
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
