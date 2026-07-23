import type { TimesheetReminderConfig } from '../api/system';

export const DEFAULT_TIMESHEET_REMINDER_CONFIG: TimesheetReminderConfig = {
  enabled: false,
  weekdays: [5],
  time: '17:30',
  targetScope: 'all',
  message: '请及时填写并提交本周工时，谢谢。',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 校验服务端保存的提醒配置，避免“JSON 可解析但字段损坏”时让设置页直接崩溃。
 * 返回新对象，调用方可安全修改，不会共享默认数组。
 */
export function parseStoredTimesheetReminderConfig(raw: string | undefined): TimesheetReminderConfig {
  if (!raw) return { ...DEFAULT_TIMESHEET_REMINDER_CONFIG, weekdays: [...DEFAULT_TIMESHEET_REMINDER_CONFIG.weekdays] };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('已保存的工时提醒配置不是有效 JSON');
  }
  if (!isRecord(value)) throw new Error('已保存的工时提醒配置格式异常');

  const weekdays = Array.isArray(value.weekdays)
    ? Array.from(new Set(value.weekdays.map(Number))).sort((a, b) => a - b)
    : [];
  if (!weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error('已保存的提醒日期无效');
  }

  const time = typeof value.time === 'string' ? value.time.trim() : '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('已保存的提醒时间无效');

  const scopes = ['all', 'department', 'group', 'user'] as const;
  const targetScope = scopes.includes(value.targetScope as typeof scopes[number])
    ? value.targetScope as typeof scopes[number]
    : undefined;
  if (!targetScope) throw new Error('已保存的提醒范围无效');

  const message = typeof value.message === 'string' ? value.message.trim() : '';
  if (!message || message.length > 1000) throw new Error('已保存的提醒内容无效');

  const config: TimesheetReminderConfig = {
    enabled: value.enabled === true,
    weekdays,
    time,
    targetScope,
    message,
  };
  if (targetScope === 'department') {
    config.targetDeptId = positiveInteger(value.targetDeptId);
    if (!config.targetDeptId) throw new Error('已保存的提醒部门无效');
  }
  if (targetScope === 'group') {
    config.targetGroupId = positiveInteger(value.targetGroupId);
    if (!config.targetGroupId) throw new Error('已保存的提醒分组无效');
  }
  if (targetScope === 'user') {
    if (!Array.isArray(value.targetUserIds) || !value.targetUserIds.length || value.targetUserIds.length > 2000) {
      throw new Error('已保存的提醒用户无效');
    }
    const targetUserIds = Array.from(new Set(value.targetUserIds.map(positiveInteger)));
    if (targetUserIds.some(id => id === undefined)) throw new Error('已保存的提醒用户无效');
    config.targetUserIds = targetUserIds as number[];
  }
  return config;
}

/** 保存前给出贴近表单字段的错误信息；服务端仍会执行同等强度的最终校验。 */
export function validateTimesheetReminderConfig(config: TimesheetReminderConfig): string | null {
  if (!config.weekdays.length) return '请至少选择一个提醒日';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.time)) return '请选择有效的提醒时间';
  if (!config.message.trim()) return '请输入提醒内容';
  if (config.message.trim().length > 1000) return '提醒内容不能超过1000个字符';
  if (config.targetScope === 'department' && !positiveInteger(config.targetDeptId)) return '请选择提醒部门';
  if (config.targetScope === 'group' && !positiveInteger(config.targetGroupId)) return '请选择提醒分组';
  if (config.targetScope === 'user' && !config.targetUserIds?.length) return '请至少选择一名提醒用户';
  if (config.targetScope === 'user' && config.targetUserIds!.length > 2000) return '提醒用户不能超过2000人';
  return null;
}
