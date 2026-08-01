import request from '../utils/request';
import { OvertimeApplication, PageResult } from '../types';

export const overtimeApi = {
  getMy: (params: any) => request.get<any, { code: number; data: PageResult<OvertimeApplication> }>('/overtime/my', { params }),
  create: (data: any) => request.post<any, { code: number }>('/overtime', data),
  createAndSubmit: (data: any) => request.post<any, { code: number; data: OvertimeApplication }>('/overtime/submit-new', data),
  update: (id: number, data: any) => request.put<any, { code: number }>(`/overtime/${id}`, data),
  updateAndSubmit: (id: number, data: any) => request.post<any, { code: number; data: OvertimeApplication }>(`/overtime/update-submit/${id}`, data),
  delete: (id: number) => request.delete<any, { code: number }>(`/overtime/${id}`),
  submit: (ids: number[]) => request.post<any, { code: number }>('/overtime/submit', { ids }),
};
