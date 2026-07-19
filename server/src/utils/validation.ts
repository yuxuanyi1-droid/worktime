import { BusinessError } from './errors';

type QueryValue = string | string[] | undefined;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parsePositiveInt(value: unknown, field: string, options: { defaultValue?: number; max?: number } = {}) {
  if (value === undefined || value === null || value === '') {
    if (options.defaultValue !== undefined) return options.defaultValue;
    throw new BusinessError(`${field}不能为空`);
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) throw new BusinessError(`${field}必须是正整数`);
  if (options.max !== undefined && num > options.max) throw new BusinessError(`${field}不能超过${options.max}`);
  return num;
}

export function parseOptionalPositiveInt(value: unknown, field: string, options: { max?: number } = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  return parsePositiveInt(value, field, options);
}

export function parsePagination(query: { page?: QueryValue; pageSize?: QueryValue }, defaultPageSize = 20) {
  return {
    page: parsePositiveInt(firstQueryValue(query.page), 'page', { defaultValue: 1, max: 100000 }),
    pageSize: parsePositiveInt(firstQueryValue(query.pageSize), 'pageSize', { defaultValue: defaultPageSize, max: 200 }),
  };
}

export function parseDateString(value: unknown, field: string) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) throw new BusinessError(`${field}必须是YYYY-MM-DD格式`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BusinessError(`${field}不是有效日期`);
  }
  return value;
}

export function parseOptionalDateString(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return undefined;
  return parseDateString(value, field);
}

export function parseEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]) {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new BusinessError(`${field}取值无效`);
  }
  return value as T;
}

export function parseOptionalEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]) {
  if (value === undefined || value === null || value === '') return undefined;
  return parseEnum(value, field, allowed);
}

export function parseBooleanQuery(value: unknown) {
  return value === true || value === 'true';
}

export function parseString(
  value: unknown,
  field: string,
  options: { required?: boolean; min?: number; max?: number; trim?: boolean } = {},
) {
  if (value === undefined || value === null) {
    if (options.required) throw new BusinessError(`${field}不能为空`);
    return undefined;
  }
  if (typeof value !== 'string') throw new BusinessError(`${field}必须是字符串`);
  const parsed = options.trim === false ? value : value.trim();
  if (options.required && !parsed) throw new BusinessError(`${field}不能为空`);
  if (options.min !== undefined && parsed.length < options.min) throw new BusinessError(`${field}不能少于${options.min}个字符`);
  if (options.max !== undefined && parsed.length > options.max) throw new BusinessError(`${field}不能超过${options.max}个字符`);
  return parsed;
}

export function parseDays(value: unknown, field = 'days') {
  const num = Number(value);
  // 工时按"天"计：单条须大于0，单日上限1天
  if (!Number.isFinite(num) || num <= 0 || num > 1) throw new BusinessError(`${field}必须大于0且不超过1`);
  return num;
}

export function parseNonNegativeNumber(value: unknown, field: string, options: { max?: number } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) throw new BusinessError(`${field}必须是非负数字`);
  if (options.max !== undefined && num > options.max) throw new BusinessError(`${field}不能超过${options.max}`);
  return num;
}

export function parseArray<T>(value: unknown, field: string, parser: (item: unknown, index: number) => T, options: { min?: number; max?: number } = {}) {
  if (!Array.isArray(value)) throw new BusinessError(`${field}必须是数组`);
  if (options.min !== undefined && value.length < options.min) throw new BusinessError(`${field}至少需要${options.min}项`);
  if (options.max !== undefined && value.length > options.max) throw new BusinessError(`${field}不能超过${options.max}项`);
  return value.map(parser);
}

export function firstQueryValue(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 四舍五入到 2 位小数，消除工时累加的浮点误差
 * （如 0.1+0.2=0.30000000000000004）。工时最小步长 0.1 天，
 * 合计最多 1 位小数，2 位容差足够。
 */
export function round2(value: number): number {
  return Number(value.toFixed(2));
}
