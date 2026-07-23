import request from '../utils/request';
import { DashboardData, PersonalReport, DepartmentReport, OvertimeReport, GroupReport, ProjectReport, ReportScope } from '../types';

export const reportApi = {
  getDashboard: () => request.get<any, { code: number; data: DashboardData }>('/reports/dashboard'),
  getScope: () => request.get<any, { code: number; data: ReportScope }>('/reports/scope'),
  getPersonal: (startDate: string, endDate: string, userId?: number) =>
    request.get<any, { code: number; data: PersonalReport }>('/reports/personal', { params: { startDate, endDate, userId } }),
  getGroup: (groupId: number, startDate: string, endDate: string) =>
    request.get<any, { code: number; data: GroupReport }>('/reports/group', { params: { groupId, startDate, endDate } }),
  getDepartment: (departmentId: number, startDate: string, endDate: string, groupId?: number) =>
    request.get<any, { code: number; data: DepartmentReport }>('/reports/department', { params: { departmentId, startDate, endDate, groupId } }),
  getProject: (projectId: number, startDate: string, endDate: string, params?: { departmentId?: number; groupId?: number }) =>
    request.get<any, { code: number; data: ProjectReport }>('/reports/project', { params: { projectId, startDate, endDate, ...params } }),
  getOvertime: (params: { startDate: string; endDate: string; departmentId?: number; groupId?: number; projectId?: number; userId?: number }) =>
    request.get<any, { code: number; data: OvertimeReport }>('/reports/overtime', { params }),
};
