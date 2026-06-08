import { AppDataSource } from '../config/database';
import { Timesheet } from '../entities/Timesheet';
import { OvertimeApplication } from '../entities/OvertimeApplication';
import { Between, Not } from 'typeorm';
import { ApprovalService } from './approvalService';

type SummaryWithCount = { hours: number; count: number };
type SummaryHours = { hours: number };

export type ReportFilters = {
  departmentId?: number;
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

export class ReportService {
  private timesheetRepo = AppDataSource.getRepository(Timesheet);
  private overtimeRepo = AppDataSource.getRepository(OvertimeApplication);
  private approvalService = new ApprovalService();

  private dedupTimesheets(records: Timesheet[]): Timesheet[] {
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
      const departmentName = user?.department?.name || UNKNOWN_DEPARTMENT;
      const groupName = user?.group?.name || UNKNOWN_GROUP;

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

  private async getApprovedTimesheets(startDate: string, endDate: string, filters: ReportFilters = {}) {
    const qb = this.timesheetRepo.createQueryBuilder('t')
      .leftJoinAndSelect('t.user', 'u')
      .leftJoinAndSelect('u.department', 'd')
      .leftJoinAndSelect('u.group', 'g')
      .leftJoinAndSelect('t.project', 'p')
      .where('t.date BETWEEN :start AND :end', { start: startDate, end: endDate })
      .andWhere('t.status = :status', { status: 'approved' });

    if (filters.userId) qb.andWhere('t.userId = :userId', { userId: filters.userId });
    if (filters.departmentId) qb.andWhere('u.departmentId = :departmentId', { departmentId: filters.departmentId });
    if (filters.groupIds?.length) qb.andWhere('u.groupId IN (:...groupIds)', { groupIds: filters.groupIds });
    else if (filters.groupId) qb.andWhere('u.groupId = :groupId', { groupId: filters.groupId });

    return this.dedupTimesheets(await qb.getMany());
  }

  async getPersonalReport(userId: number, startDate: string, endDate: string) {
    const records = await this.getApprovedTimesheets(startDate, endDate, { userId });
    return this.summarizeTimesheets(records);
  }

  async getGroupReport(groupId: number, startDate: string, endDate: string, groupIds?: number[]) {
    const records = await this.getApprovedTimesheets(startDate, endDate, { groupId, groupIds });
    return this.summarizeTimesheets(records);
  }

  async getDepartmentReport(departmentId: number, startDate: string, endDate: string, filters: ReportFilters = {}) {
    const records = await this.getApprovedTimesheets(startDate, endDate, { ...filters, departmentId });
    return this.summarizeTimesheets(records);
  }

  async getProjectReport(projectId: number, startDate: string, endDate: string, filters: ReportFilters = {}) {
    const qb = this.timesheetRepo.createQueryBuilder('t')
      .leftJoinAndSelect('t.user', 'u')
      .leftJoinAndSelect('u.department', 'd')
      .leftJoinAndSelect('u.group', 'g')
      .leftJoinAndSelect('t.project', 'p')
      .where('p.id = :projectId', { projectId })
      .andWhere('t.date BETWEEN :start AND :end', { start: startDate, end: endDate })
      .andWhere('t.status = :status', { status: 'approved' });

    if (filters.departmentId) qb.andWhere('u.departmentId = :departmentId', { departmentId: filters.departmentId });
    if (filters.groupIds?.length) qb.andWhere('u.groupId IN (:...groupIds)', { groupIds: filters.groupIds });
    else if (filters.groupId) qb.andWhere('u.groupId = :groupId', { groupId: filters.groupId });
    if (filters.userId) qb.andWhere('t.userId = :userId', { userId: filters.userId });

    const records = this.dedupTimesheets(await qb.getMany());
    return this.summarizeTimesheets(records);
  }

  async getOvertimeReport(params: { departmentId?: number; groupId?: number; groupIds?: number[]; userId?: number; startDate: string; endDate: string }) {
    const { departmentId, groupId, groupIds, userId, startDate, endDate } = params;
    const qb = this.overtimeRepo.createQueryBuilder('o')
      .leftJoinAndSelect('o.user', 'u')
      .leftJoinAndSelect('u.department', 'd')
      .leftJoinAndSelect('u.group', 'g')
      .where('o.date BETWEEN :start AND :end', { start: startDate, end: endDate })
      .andWhere('o.status = :status', { status: 'approved' });

    if (departmentId) qb.andWhere('u.departmentId = :departmentId', { departmentId });
    if (groupIds?.length) qb.andWhere('u.groupId IN (:...groupIds)', { groupIds });
    else if (groupId) qb.andWhere('u.groupId = :groupId', { groupId });
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
      addHoursSummary(acc, (record.user as any)?.group?.name || UNKNOWN_GROUP, Number(record.hours));
      return acc;
    }, {} as Record<string, SummaryHours>);

    return { totalHours, byType, byUser, byGroup, records };
  }

  async getDashboardData(userId: number) {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const monthEnd = formatLocalDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));

    const rawMonthTimesheets = await this.timesheetRepo.find({
      where: { userId, date: Between(monthStart, monthEnd), status: Not('deprecated') },
    });
    const monthTimesheets = this.dedupTimesheets(rawMonthTimesheets);
    const monthByDate = monthTimesheets.reduce((acc: Record<string, number>, record) => {
      acc[record.date] = (acc[record.date] || 0) + Number(record.hours);
      return acc;
    }, {});
    const monthHours = totalOfDates(monthByDate);

    const pendingResult = await this.approvalService.getPendingList(userId, { page: 1, pageSize: 1 });
    const pendingCount = pendingResult.total;

    const monthOvertime = await this.overtimeRepo.find({
      where: { userId, date: Between(monthStart, monthEnd), status: 'approved' },
    });
    const overtimeHours = monthOvertime.reduce((sum, record) => sum + Number(record.hours), 0);

    const rawTrend = await this.timesheetRepo.find({
      where: { userId, date: Between(monthStart, monthEnd), status: Not('deprecated') },
      order: { date: 'ASC' },
    });
    const trendRecords = this.dedupTimesheets(rawTrend);
    const trendByDate: Record<string, number> = {};
    for (const timesheet of trendRecords) {
      trendByDate[timesheet.date] = (trendByDate[timesheet.date] || 0) + Number(timesheet.hours);
    }
    const trend = Object.entries(trendByDate).map(([date, hours]) => ({ date, hours }));

    return { monthHours, overtimeHours, pendingCount, trend };
  }
}
