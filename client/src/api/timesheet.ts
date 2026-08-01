import request from '../utils/request';
import { Timesheet, PageResult } from '../types';

export const timesheetApi = {
  getMy: (params: any) => request.get<any, { code: number; data: PageResult<Timesheet> }>('/timesheets/my', { params }),
  getWeeklySummary: (weekStart: string, weekEnd: string, userId?: number) =>
    request.get<any, { code: number; data: any }>('/timesheets/weekly-summary', { params: { weekStart, weekEnd, userId } }),
  replaceWeekDrafts: (weekStart: string, items: any[]) =>
    request.post<any, { code: number }>('/timesheets/drafts/replace', { weekStart, items }),
  delete: (id: number) => request.delete<any, { code: number }>(`/timesheets/${id}`),
  submitByRows: (rows: any[]) => request.post<any, { code: number }>('/timesheets/submit-rows', { rows }),
  modifySubmitted: (rows: any[]) => request.post<any, { code: number }>('/timesheets/modify', { rows }),
};
