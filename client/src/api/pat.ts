import request from '../utils/request';

/** 个人访问令牌（PAT）—— 用于 pi skill / 外部工具调后端 API */
export interface PersonalAccessToken {
  id: number;
  userId: number;
  name: string;
  /** sha256，前端一般不展示 */
  tokenHash: string;
  /** 明文令牌，完整 wpat_<32hex>，可复制 */
  tokenPlain: string;
  /** 明文前缀预览 */
  prefix: string;
  scopes: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const patApi = {
  list: () => request.get<any, { code: number; data: PersonalAccessToken[] }>('/pats'),
  create: (data: { name: string; expiresAt?: string }) =>
    request.post<any, { code: number; data: PersonalAccessToken }>('/pats', data),
  remove: (id: number) => request.delete<any, { code: number }>(`/pats/${id}`),
};
