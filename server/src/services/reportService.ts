import { EntityManager } from 'typeorm';
import { AppDataSource } from '../config/database';
import { Timesheet } from '../entities/Timesheet';
import { OvertimeApplication } from '../entities/OvertimeApplication';
import { Between, Not } from 'typeorm';
import { ApprovalService } from './approvalService';
import { BusinessError } from '../utils/errors';

type SummaryWithCount = { hours: number; count: number };
type SummaryHours = { hours: number };

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

function addCountSummary(target: Record<string, SummaryWithCount>, key: string, hours: number) {
  if (!target[key]) target[key] = { hours: 0, count: 0 };
  target[key].hours += hours;
  target[key].count += 1;
}

function addHoursSummary(target: Record<string, SummaryHours>, key: string, hours: number) {
  if (!target[key]) target[key] = { hours: 0 };
  target[key].hours += hours;
}

function totalOfDates(byDate: Record<string, number>) {
  return Object.values(byDate).reduce((sum, hours) => sum + hours, 0);
}

/**
 * 报表工时去重：按 (userId, date, projectId) 去重，排除 deprecated，保留 id 最大的记录。
 * 抽成独立导出函数便于单元测试。
 *
 * 语义：同一条工时的多次提交/修改版本中，取最新非废弃的那一条，
 * 确保报表统计与工时填报页口径一致（填报页 getByUser 也是同样的去重逻辑）。
 */
export function dedupReportTimesheets(records: Timesheet[]): Timesheet[] {
  const map = new Map<string, Timesheet>();
  for (const record of records) {
    if (record.status === 'deprecated') continue;
    const key = `${record.userId}_${record.date}_${record.projectId}`;
    const existing = map.get(key);
    if (!existing || record.id > existing.id) {
      map.set(key, record);
    }
  }
  return Array.from(map.values());
}

export class ReportService {
  constructor(private manager?: EntityManager) {}

  private get timesheetRepo() { return (this.manager ?? AppDataSource).getRepository(Timesheet); }
  private get overtimeRepo() { return (this.manager ?? AppDataSource).getRepository(OvertimeApplication); }
  private get approvalService() { return new ApprovalService(this.manager); }

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
      const hours = Number(record.hours);
      const user = record.user as any;
      const project = record.project as any;
      const departmentName = record.departmentSnapshotName || UNKNOWN_DEPARTMENT;
      const groupName = record.groupSnapshotName || UNKNOWN_GROUP;

      byDate[record.date] = (byDate[record.date] || 0) + hours;
      addCountSummary(byUser, user?.realName || UNKNOWN_USER, hours);
      addCountSummary(byProject, project?.name || UNKNOWN_PROJECT, hours);
      addCountSummary(byDepartment, departmentName, hours);
      addCountSummary(byGroup, groupName, hours);
    }

    return {
      totalHours: totalOfDates(byDate),
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
   * 统计口径：status 为 approved 或 submitted 的记录（排除 deprecated/draft/rejected）。
   * - approved：已审批通过，正常统计
   * - submitted：修改审批中的最新版本——旧记录已 deprecated，新记录正在审批，
   *   纳入统计可避免「修改期间报表工时凭空消失」的问题
   * 然后由 dedupTimesheets 按 (userId, date, projectId) 去重保留 id 最大，
   * 确保同一条工时只计一次（取最新版本）。
   */
  private async getReportTimesheets(startDate: string, endDate: string, filters: ReportFilters = {}) {
    const qb = this.timesheetRepo.createQueryBuilder('t')
      .leftJoinAndSelect('t.user', 'u')
      .leftJoinAndSelect('t.project', 'p')
      .where('t.date BETWEEN :start AND :end', { start: startDate, end: endDate })
      // E8：报表统一只计 approved（与加班报表一致），避免未审批(submitted)工时虚增报表数据
      .andWhere('t.status = :status', { status: 'approved' });

    if (filters.userId) qb.andWhere('t.userId = :userId', { userId: filters.userId });
    if (filters.departmentIds?.length) qb.andWhere('t.departmentSnapshotId IN (:...departmentIds)', { departmentIds: filters.departmentIds });
    else if (filters.departmentId) qb.andWhere('t.departmentSnapshotId = :departmentId', { departmentId: filters.departmentId });
    if (filters.groupIds?.length) qb.andWhere('t.groupSnapshotId IN (:...groupIds)', { groupIds: filters.groupIds });
    else if (filters.groupId) qb.andWhere('t.groupSnapshotId = :groupId', { groupId: filters.groupId });

    return this.dedupTimesheets(await qb.getMany());
  }

  async getPersonalReport(userId: number, startDate: string, endDate: string) {
    const records = await this.getReportTimesheets(startDate, endDate, { userId });
    return this.summarizeTimesheets(records);
  }

  async getGroupReport(groupId: number, startDate: string, endDate: string, groupIds?: number[]) {
    const records = await this.getReportTimesheets(startDate, endDate, { groupId, groupIds });
    return this.summarizeTimesheets(records);
  }

  async getDepartmentReport(departmentId: number, startDate: string, endDate: string, filters: ReportFilters = {}) {
    const records = await this.getReportTimesheets(startDate, endDate, { ...filters, departmentId });
    return this.summarizeTimesheets(records);
  }

  async getProjectReport(projectId: number, startDate: string, endDate: string, filters: ReportFilters = {}) {
    const qb = this.timesheetRepo.createQueryBuilder('t')
      .leftJoinAndSelect('t.user', 'u')
      .leftJoinAndSelect('t.project', 'p')
      .where('p.id = :projectId', { projectId })
      .andWhere('t.date BETWEEN :start AND :end', { start: startDate, end: endDate })
      .andWhere('t.status = :status', { status: 'approved' });

    if (filters.departmentIds?.length) qb.andWhere('t.departmentSnapshotId IN (:...departmentIds)', { departmentIds: filters.departmentIds });
    else if (filters.departmentId) qb.andWhere('t.departmentSnapshotId = :departmentId', { departmentId: filters.departmentId });
    if (filters.groupIds?.length) qb.andWhere('t.groupSnapshotId IN (:...groupIds)', { groupIds: filters.groupIds });
    else if (filters.groupId) qb.andWhere('t.groupSnapshotId = :groupId', { groupId: filters.groupId });
    if (filters.userId) qb.andWhere('t.userId = :userId', { userId: filters.userId });

    const records = this.dedupTimesheets(await qb.getMany());
    return this.summarizeTimesheets(records);
  }

  async getOvertimeReport(params: { departmentId?: number; departmentIds?: number[]; groupId?: number; groupIds?: number[]; userId?: number; startDate: string; endDate: string; matchAnyScope?: boolean }) {
    const { departmentId, departmentIds, groupId, groupIds, userId, startDate, endDate, matchAnyScope } = params;
    // 安全防护：无任何数据范围约束时拒绝执行，避免全表泄露（调用方必须保证至少一个范围）
    const hasScope = departmentId || departmentIds?.length || groupId || groupIds?.length || userId;
    if (!hasScope) {
      throw new BusinessError('加班报表缺少数据范围约束');
    }
    const qb = this.overtimeRepo.createQueryBuilder('o')
      .leftJoinAndSelect('o.user', 'u')
      .where('o.date BETWEEN :start AND :end', { start: startDate, end: endDate })
      .andWhere('o.status = :status', { status: 'approved' });

    if (matchAnyScope) {
      const scopeConditions: string[] = [];
      if (departmentIds?.length) scopeConditions.push('o.departmentSnapshotId IN (:...departmentIds)');
      else if (departmentId) scopeConditions.push('o.departmentSnapshotId = :departmentId');
      if (groupIds?.length) scopeConditions.push('o.groupSnapshotId IN (:...groupIds)');
      else if (groupId) scopeConditions.push('o.groupSnapshotId = :groupId');
      if (scopeConditions.length) qb.andWhere(`(${scopeConditions.join(' OR ')})`, { departmentIds, departmentId, groupIds, groupId });
    } else {
      if (departmentIds?.length) qb.andWhere('o.departmentSnapshotId IN (:...departmentIds)', { departmentIds });
      else if (departmentId) qb.andWhere('o.departmentSnapshotId = :departmentId', { departmentId });
      if (groupIds?.length) qb.andWhere('o.groupSnapshotId IN (:...groupIds)', { groupIds });
      else if (groupId) qb.andWhere('o.groupSnapshotId = :groupId', { groupId });
    }
    if (userId) qb.andWhere('o.userId = :userId', { userId });

    const records = await qb.getMany();
    const totalHours = records.reduce((sum, record) => sum + Number(record.hours), 0);
    const byType = records.reduce((acc, record) => {
      acc[record.overtimeType] = (acc[record.overtimeType] || 0) + Number(record.hours);
      return acc;
    }, {} as Record<string, number>);
    const byUser = records.reduce((acc, record) => {
      const key = record.user?.realName || UNKNOWN_USER;
      acc[key] = (acc[key] || 0) + Number(record.hours);
      return acc;
    }, {} as Record<string, number>);
    const byGroup = records.reduce((acc, record) => {
      addHoursSummary(acc, record.groupSnapshotName || UNKNOWN_GROUP, Number(record.hours));
      return acc;
    }, {} as Record<string, SummaryHours>);

    return { totalHours, byType, byUser, byGroup, records };
  }

  async getDashboardData(userId: number) {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const monthEnd = formatLocalDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));

    // 本月工时：一次查询同时算 monthHours 和 trend（两者 where 条件相同，避免重复查询）
    const rawMonthTimesheets = await this.timesheetRepo.find({
      where: { userId, date: Between(monthStart, monthEnd), status: Not('deprecated') },
      order: { date: 'ASC' },
    });
    const monthTimesheets = this.dedupTimesheets(rawMonthTimesheets);
    const monthByDate: Record<string, number> = {};
    for (const record of monthTimesheets) {
      monthByDate[record.date] = (monthByDate[record.date] || 0) + Number(record.hours);
    }
    const monthHours = totalOfDates(monthByDate);
    const trend = Object.entries(monthByDate).map(([date, hours]) => ({ date, hours }));

    const pendingResult = await this.approvalService.getPendingList(userId, { page: 1, pageSize: 1 });
    const pendingCount = pendingResult.total;

    const monthOvertime = await this.overtimeRepo.find({
      where: { userId, date: Between(monthStart, monthEnd), status: 'approved' },
    });
    const overtimeHours = monthOvertime.reduce((sum, record) => sum + Number(record.hours), 0);

    return { monthHours, overtimeHours, pendingCount, trend };
  }
}
