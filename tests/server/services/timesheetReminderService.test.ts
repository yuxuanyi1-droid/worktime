import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TIMESHEET_REMINDER_CONFIG,
  normalizeTimesheetReminderConfig,
  parseTimesheetReminderConfig,
  TimesheetReminderScheduler,
} from '@server/services/timesheetReminderService';
import { AppDataSource } from '@server/config/database';
import { UserAudienceService } from '@server/services/notifications/userAudienceService';
import { NotificationPublisher } from '@server/services/notifications/notificationPublisher';

afterEach(() => vi.restoreAllMocks());

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

  it('显式错误的提醒范围不会降级成全员发送', () => {
    expect(() => normalizeTimesheetReminderConfig({
      enabled: true,
      weekdays: [5],
      time: '17:30',
      targetScope: 'departmnt',
      targetDeptId: 1,
      message: '提醒',
    })).toThrow('提醒范围无效');
  });

  it('兼容早期未保存提醒范围的配置', () => {
    expect(normalizeTimesheetReminderConfig({
      enabled: false,
      weekdays: [5],
      time: '17:30',
      message: '提醒',
    }).targetScope).toBe('all');
  });

  it('拒绝损坏 JSON、空用户范围和过长内容', () => {
    expect(() => parseTimesheetReminderConfig('{bad json')).toThrow('不是有效 JSON');
    expect(() => normalizeTimesheetReminderConfig({
      enabled: true,
      weekdays: [5],
      time: '17:30',
      targetScope: 'user',
      targetUserIds: [],
      message: '提醒',
    })).toThrow('请选择1至2000名提醒用户');
    expect(() => normalizeTimesheetReminderConfig({
      enabled: true,
      weekdays: [5],
      time: '17:30',
      targetScope: 'all',
      message: 'x'.repeat(1001),
    })).toThrow('不能超过1000个字符');
  });

  it('仅在上海时区命中计划且抢到槽位后发送一次 TT', async () => {
    const config = {
      enabled: true,
      weekdays: [5],
      time: '17:30',
      targetScope: 'department',
      targetDeptId: 3,
      message: '请填写工时',
    };
    const originalInitialized = AppDataSource.isInitialized;
    AppDataSource.isInitialized = true;
    vi.spyOn(AppDataSource, 'getRepository').mockReturnValue({
      findOne: vi.fn().mockResolvedValue({ value: JSON.stringify(config) }),
    } as any);
    vi.spyOn(UserAudienceService.prototype, 'resolveUserIds').mockResolvedValue([2, 4]);
    const publish = vi.spyOn(NotificationPublisher.prototype, 'publishTtOnly').mockResolvedValue('sent');
    const scheduler = new TimesheetReminderScheduler();
    vi.spyOn(scheduler as any, 'claimSlot').mockResolvedValue(true);

    await scheduler.tick(new Date('2026-07-24T09:30:00.000Z'));

    expect(publish).toHaveBeenCalledWith([2, 4], {
      type: 'timesheet_reminder',
      title: '工时填写提醒',
      content: '请填写工时',
      targetType: 'timesheet',
    });
    AppDataSource.isInitialized = originalInitialized;
  });

  it('未命中时间或槽位已执行时不发送', async () => {
    const originalInitialized = AppDataSource.isInitialized;
    AppDataSource.isInitialized = true;
    vi.spyOn(AppDataSource, 'getRepository').mockReturnValue({
      findOne: vi.fn().mockResolvedValue({ value: JSON.stringify({
        enabled: true,
        weekdays: [5],
        time: '17:30',
        targetScope: 'all',
        message: '提醒',
      }) }),
    } as any);
    const publish = vi.spyOn(NotificationPublisher.prototype, 'publishTtOnly');
    const scheduler = new TimesheetReminderScheduler();
    const claim = vi.spyOn(scheduler as any, 'claimSlot').mockResolvedValue(false);

    await scheduler.tick(new Date('2026-07-24T09:29:00.000Z'));
    expect(claim).not.toHaveBeenCalled();
    await scheduler.tick(new Date('2026-07-24T09:30:00.000Z'));
    expect(claim).toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    AppDataSource.isInitialized = originalInitialized;
  });
});
