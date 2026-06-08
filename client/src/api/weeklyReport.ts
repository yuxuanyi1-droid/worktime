import request from '../utils/request';
import { WeeklyReport, PageResult } from '../types';

export const weeklyReportApi = {
  getMy: (params: any) => request.get<any, { code: number; data: PageResult<WeeklyReport> }>('/weekly-reports/my', { params }),
  getByWeek: (weekStart: string) => request.get<any, { code: number; data: WeeklyReport | null }>('/weekly-reports/week', { params: { weekStart } }),
  save: (data: any) => request.post<any, { code: number; data: WeeklyReport }>('/weekly-reports', data),
  submit: (id: number) => request.post<any, { code: number }>('/weekly-reports/submit', { id }),
};
