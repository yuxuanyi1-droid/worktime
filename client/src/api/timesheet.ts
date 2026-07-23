import request from '../utils/request';
import { Timesheet, PageResult } from '../types';

export const timesheetApi = {
  getMy: (params: any) => request.get<any, { code: number; data: PageResult<Timesheet> }>('/timesheets/my', { params }),
  getWeeklySummary: (weekStart: string, weekEnd: string, userId?: number) =>
    request.get<any, { code: number; data: any }>('/timesheets/weekly-summary', { params: { weekStart, weekEnd, userId } }),
  create: (data: any) => request.post<any, { code: number; data: Timesheet }>('/timesheets', data),
  batchCreate: (items: any[]) => request.post<any, { code: number }>('/timesheets/batch', { items }),
  replaceWeekDrafts: (weekStart: string, items: any[]) =>
    request.post<any, { code: number }>('/timesheets/drafts/replace', { weekStart, items }),
  update: (id: number, data: any) => request.put<any, { code: number }>(`/timesheets/${id}`, data),
  delete: (id: number) => request.delete<any, { code: number }>(`/timesheets/${id}`),
  submit: (ids: number[]) => request.post<any, { code: number }>('/timesheets/submit', { ids }),
  submitByRows: (rows: any[]) => request.post<any, { code: number }>('/timesheets/submit-rows', { rows }),
  modifySubmitted: (rows: any[]) => request.post<any, { code: number }>('/timesheets/modify', { rows }),
};
