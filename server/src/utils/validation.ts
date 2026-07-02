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

/**
 * R13：校验 weekStart 是有效的周一（ISO 周起始）。
 * 周报/工时周查询依赖 weekStart 作为周锚点，非周一会导致周数据桶错位、报表跨周重叠。
 */
export function validateWeekStartMonday(value: unknown, field: string = 'weekStart'): string {
  parseDateString(value, field);
  // getDay: 0=周日, 1=周一 ... 6=周六。本地时间与 parseDateString 一致。
  const day = new Date(`${value}T00:00:00`).getDay();
  if (day !== 1) {
    throw new BusinessError(`${field}必须是周一（ISO 周起始日）`);
  }
  return value as string;
}

/**
 * E4：校验每日工时/加班时长不超过上限（默认 24 小时）。
 * entries 形如 [{ date, hours }]，按 date 聚合后判断。
 */
export function validateDailyHours(
  entries: { date: string; hours: number }[],
  maxHoursPerDay: number = 24,
  label: string = '工时',
) {
  const dailyTotals: Record<string, number> = {};
  for (const e of entries) {
    if (typeof e.hours !== 'number' || e.hours < 0) continue;
    dailyTotals[e.date] = (dailyTotals[e.date] || 0) + e.hours;
  }
  for (const [date, total] of Object.entries(dailyTotals)) {
    if (total > maxHoursPerDay) {
      throw new BusinessError(`${date} ${label}合计 ${total.toFixed(1)} 小时，超过${maxHoursPerDay}小时上限`);
    }
  }
}

/**
 * E5：校验日期不是未来日期（加班不允许提交未来日期）。
 */
export function validateNotFutureDate(value: string, field: string = 'date') {
  parseDateString(value, field);
  const today = new Date();
  today.setHours(23, 59, 59, 999); // 今天结束前都允许
  const input = new Date(`${value}T00:00:00`);
  if (input.getTime() > today.getTime()) {
    throw new BusinessError(`${field}不能是未来日期`);
  }
}

export function parseDateString(value: unknown, field: string) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) throw new BusinessError(`${field}必须是YYYY-MM-DD格式`);
  // R12：用本地时间验证（不加 Z），与 checkTimesheetLock 的 dayjs() 本地时间基准一致。
  // 原先用 UTC（T00:00:00Z）会导致非 UTC 时区下月份边界日期验证与锁定逻辑差一天。
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    throw new BusinessError(`${field}不是有效日期`);
  }
  // 用本地日期分量回拼校验（避免 toISOString 的 UTC 偏移问题）
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  if (`${y}-${m}-${d}` !== value) {
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

export function parseString(value: unknown, field: string, options: { required?: boolean; max?: number } = {}) {
  if (value === undefined || value === null) {
    if (options.required) throw new BusinessError(`${field}不能为空`);
    return undefined;
  }
  if (typeof value !== 'string') throw new BusinessError(`${field}必须是字符串`);
  const trimmed = value.trim();
  if (options.required && !trimmed) throw new BusinessError(`${field}不能为空`);
  if (options.max !== undefined && trimmed.length > options.max) throw new BusinessError(`${field}不能超过${options.max}个字符`);
  return trimmed;
}

export function parseHours(value: unknown, field = 'hours') {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || num > 24) throw new BusinessError(`${field}必须大于0且不超过24`);
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
 * 密码策略配置。默认策略：至少 8 位、需含字母和数字。
 * 可通过 SystemSetting（password_min_length / password_require_digit / password_require_letter）覆盖。
 */
export interface PasswordPolicy {
  minLength: number;
  requireDigit: boolean;
  requireLetter: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireDigit: true,
  requireLetter: true,
};

/**
 * 校验密码是否符合策略。返回 null 表示通过，否则返回中文错误描述。
 */
export function validatePassword(password: string, policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY): string | null {
  if (typeof password !== 'string' || password.length < policy.minLength) {
    return `密码至少需要 ${policy.minLength} 个字符`;
  }
  if (password.length > 128) {
    return '密码长度不能超过 128 个字符';
  }
  if (policy.requireLetter && !/[a-zA-Z]/.test(password)) {
    return '密码必须包含字母';
  }
  if (policy.requireDigit && !/\d/.test(password)) {
    return '密码必须包含数字';
  }
  return null;
}

