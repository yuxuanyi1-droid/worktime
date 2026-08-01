import request from '../utils/request';

/** 个人访问令牌（PAT）—— 用于 pi skill / 外部工具调后端 API */
export interface PersonalAccessToken {
  id: number;
  userId: number;
  name: string;
  /** 仅创建响应包含完整明文；列表永不返回 */
  tokenPlain?: string;
  /** 明文前缀预览 */
  prefix: string;
  scopes: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** PAT 可选权限范围（权限码目录） */
export interface PatScopeOption {
  code: string;
  name: string;
}

export const patApi = {
  list: () => request.get<any, { code: number; data: PersonalAccessToken[] }>('/pats'),
  getScopes: () => request.get<any, { code: number; data: PatScopeOption[] }>('/pats/scopes'),
  create: (data: { name: string; expiresAt?: string; scopes?: string[] }) =>
    request.post<any, { code: number; data: PersonalAccessToken }>('/pats', data),
  remove: (id: number) => request.delete<any, { code: number }>(`/pats/${id}`),
};
