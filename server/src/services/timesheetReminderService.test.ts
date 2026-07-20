import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMESHEET_REMINDER_CONFIG,
  normalizeTimesheetReminderConfig,
  parseTimesheetReminderConfig,
} from './timesheetReminderService';

describe('工时定时提醒配置', () => {
  it('未配置时使用安全的停用默认值', () => {
    expect(parseTimesheetReminderConfig(undefined)).toEqual(DEFAULT_TIMESHEET_REMINDER_CONFIG);
  });

  it('归一化提醒日期并保留分组范围', () => {
    expect(normalizeTimesheetReminderConfig({
      enabled: true,
      weekdays: [5, 1, 5],
      time: '17:30',
      targetScope: 'group',
      targetGroupId: 12,
      message: ' 请填写工时 ',
    })).toEqual({
      enabled: true,
      weekdays: [1, 5],
      time: '17:30',
      targetScope: 'group',
      targetGroupId: 12,
      message: '请填写工时',
    });
  });

  it('拒绝无效时间和缺失的范围参数', () => {
    expect(() => normalizeTimesheetReminderConfig({
      enabled: true,
      weekdays: [1],
      time: '25:00',
      targetScope: 'all',
      message: '提醒',
    })).toThrow('提醒时间格式无效');
    expect(() => normalizeTimesheetReminderConfig({
      enabled: true,
      weekdays: [1],
      time: '09:00',
      targetScope: 'department',
      message: '提醒',
    })).toThrow('targetDeptId必须是正整数');
  });
});
