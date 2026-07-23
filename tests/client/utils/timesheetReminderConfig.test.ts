import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMESHEET_REMINDER_CONFIG,
  parseStoredTimesheetReminderConfig,
  validateTimesheetReminderConfig,
} from '@client/utils/timesheetReminderConfig';

describe('工时提醒前端配置保护', () => {
  it('缺少配置时返回互不共享数组的安全默认值', () => {
    const first = parseStoredTimesheetReminderConfig(undefined);
    first.weekdays.push(1);
    const second = parseStoredTimesheetReminderConfig(undefined);

    expect(second).toEqual(DEFAULT_TIMESHEET_REMINDER_CONFIG);
  });

  it('规范化日期、文本和重复用户', () => {
    expect(parseStoredTimesheetReminderConfig(JSON.stringify({
      enabled: true,
      weekdays: [5, 1, 5],
      time: '17:30',
      targetScope: 'user',
      targetUserIds: [3, 2, 3],
      message: ' 请填写工时 ',
    }))).toEqual({
      enabled: true,
      weekdays: [1, 5],
      time: '17:30',
      targetScope: 'user',
      targetUserIds: [3, 2],
      message: '请填写工时',
    });
  });

  it('拒绝可解析但结构损坏的配置，避免设置页渲染崩溃', () => {
    expect(() => parseStoredTimesheetReminderConfig('{bad')).toThrow('不是有效 JSON');
    expect(() => parseStoredTimesheetReminderConfig(JSON.stringify({
      enabled: true,
      weekdays: null,
      time: '17:30',
      targetScope: 'all',
      message: '提醒',
    }))).toThrow('提醒日期无效');
    expect(() => parseStoredTimesheetReminderConfig(JSON.stringify({
      enabled: true,
      weekdays: [5],
      time: '17:30',
      targetScope: 'department',
      message: '提醒',
    }))).toThrow('提醒部门无效');
  });

  it('保存前校验各类范围的必填目标', () => {
    expect(validateTimesheetReminderConfig({
      ...DEFAULT_TIMESHEET_REMINDER_CONFIG,
      targetScope: 'department',
    })).toBe('请选择提醒部门');
    expect(validateTimesheetReminderConfig({
      ...DEFAULT_TIMESHEET_REMINDER_CONFIG,
      targetScope: 'group',
      targetGroupId: 7,
    })).toBeNull();
    expect(validateTimesheetReminderConfig({
      ...DEFAULT_TIMESHEET_REMINDER_CONFIG,
      targetScope: 'user',
      targetUserIds: [],
    })).toBe('请至少选择一名提醒用户');
  });
});
