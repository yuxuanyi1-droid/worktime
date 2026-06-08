import request from '../utils/request';
import { OvertimeApplication, PageResult } from '../types';

export const overtimeApi = {
  getMy: (params: any) => request.get<any, { code: number; data: PageResult<OvertimeApplication> }>('/overtime/my', { params }),
  getStats: (year: number, month?: number) => request.get<any, { code: number; data: any[] }>('/overtime/stats', { params: { year, month } }),
  create: (data: any) => request.post<any, { code: number }>('/overtime', data),
  createAndSubmit: (data: any) => request.post<any, { code: number; data: OvertimeApplication }>('/overtime/submit-new', data),
  update: (id: number, data: any) => request.put<any, { code: number }>(`/overtime/${id}`, data),
  delete: (id: number) => request.delete<any, { code: number }>(`/overtime/${id}`),
  submit: (ids: number[]) => request.post<any, { code: number }>('/overtime/submit', { ids }),
};
