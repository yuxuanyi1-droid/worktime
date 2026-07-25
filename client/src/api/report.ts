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

// ==================== 自定义报表 ====================

/** 自定义报表数据源 */
export type CustomReportSource = 'timesheet' | 'overtime';

/** 加班类型（与后端 reportQueryEngine.ALLOWED_OVERTIME_TYPES 同源，勿改单值） */
export type ReportOvertimeType = 'weekend' | 'holiday' | 'weekday';

/** 自定义报表度量 */
export type CustomReportMeasure = 'sumDays' | 'count' | 'distinctUsers';

/** 自定义报表维度 */
export type CustomReportDimension = 'user' | 'project' | 'date' | 'month' | 'department' | 'group' | 'overtimeType';

/** 自定义报表筛选条件 */
export interface CustomReportFilters {
  departmentIds?: number[];
  groupIds?: number[];
  userIds?: number[];
  projectIds?: number[];
  /** 工时/加班状态，默认 ['approved'] */
  statuses?: string[];
  /** 加班类型筛选（仅 source=overtime 时有效；复数数组，字段名与后端一致） */
  overtimeTypes?: ReportOvertimeType[];
}

/** 自定义报表配置（运行与保存的 config） */
export interface CustomReportConfig {
  source: CustomReportSource;
  startDate: string;
  endDate: string;
  rowDimension: CustomReportDimension;
  colDimension?: CustomReportDimension | null;
  measures: CustomReportMeasure[];
  filters: CustomReportFilters;
}

/** 行/列键 */
export interface CustomReportKey {
  key: string;
  label: string;
}

/** 单元格聚合值 */
export interface CustomReportCell {
  sumDays?: number;
  count?: number;
  distinctUsers?: number;
}

/** 运行结果 */
export interface CustomReportResult {
  rowKeys: CustomReportKey[];
  colKeys: CustomReportKey[];
  cells: Record<string, Record<string, CustomReportCell>>;
  rowTotals: Record<string, CustomReportCell>;
  colTotals: Record<string, CustomReportCell>;
  grandTotal: CustomReportCell;
}

/** 共享范围 */
export type CustomReportScopeType = 'private' | 'group' | 'department' | 'public';

/** 报表定义的所有者 */
export interface CustomReportOwner {
  id: number;
  realName: string;
}

/** 已保存的报表定义 */
export interface CustomReportDefinition {
  id: number;
  name: string;
  scope: CustomReportScopeType;
  owner: CustomReportOwner;
  config: CustomReportConfig;
  createdAt: string;
}

/** 创建/更新报表定义的请求体 */
export interface CustomDefinitionPayload {
  name: string;
  config: CustomReportConfig;
  scope: CustomReportScopeType;
  scopeGroupId?: number;
  scopeDepartmentId?: number;
}

export const customReportApi = {
  /** 运行自定义报表配置，返回透视结果 */
  run: (config: CustomReportConfig) =>
    request.post<any, { code: number; data: CustomReportResult }>('/reports/custom/run', config),
  /** 列出我的/共享报表定义 */
  listDefinitions: () =>
    request.get<any, { code: number; data: CustomReportDefinition[] }>('/reports/custom/definitions'),
  /** 获取单个报表定义 */
  getDefinition: (id: number) =>
    request.get<any, { code: number; data: CustomReportDefinition }>(`/reports/custom/definitions/${id}`),
  /** 保存新报表定义 */
  createDefinition: (payload: CustomDefinitionPayload) =>
    request.post<any, { code: number; data: CustomReportDefinition }>('/reports/custom/definitions', payload),
  /** 更新已有报表定义 */
  updateDefinition: (id: number, payload: CustomDefinitionPayload) =>
    request.put<any, { code: number; data: CustomReportDefinition }>(`/reports/custom/definitions/${id}`, payload),
  /** 删除报表定义 */
  deleteDefinition: (id: number) =>
    request.delete<any, { code: number }>(`/reports/custom/definitions/${id}`),
};
