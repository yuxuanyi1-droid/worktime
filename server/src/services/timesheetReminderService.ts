import { AppDataSource, databaseType } from '../config/database';
import { SystemSetting } from '../entities/SystemSetting';
import { BusinessError } from '../utils/errors';
import { logger } from '../utils/logger';
import { NotificationPublisher } from './notifications/notificationPublisher';
import { UserAudienceScope, UserAudienceService } from './notifications/userAudienceService';

export const TIMESHEET_REMINDER_SETTING_KEY = 'timesheet_reminder_config';
const LAST_SLOT_SETTING_KEY = 'timesheet_reminder_last_slot';
const REMINDER_LOCK_ID = 782_041_904;
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

export interface TimesheetReminderConfig {
  enabled: boolean;
  weekdays: number[];
  time: string;
  targetScope: UserAudienceScope;
  targetDeptId?: number;
  targetGroupId?: number;
  targetUserIds?: number[];
  message: string;
}

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

function parsePositiveId(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new BusinessError(`${field}必须是正整数`);
  return parsed;
}

/** 严格校验并归一化系统设置中的工时提醒配置。 */
export function normalizeTimesheetReminderConfig(value: unknown): TimesheetReminderConfig {
  if (!isRecord(value)) throw new BusinessError('工时提醒配置格式无效');
  const enabled = value.enabled === true;
  const weekdays = Array.isArray(value.weekdays)
    ? Array.from(new Set(value.weekdays.map(day => Number(day)))).sort((a, b) => a - b)
    : [];
  if (!weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new BusinessError('请至少选择一个有效提醒日');
  }

  const time = typeof value.time === 'string' ? value.time.trim() : '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new BusinessError('提醒时间格式无效');

  const scopes: UserAudienceScope[] = ['all', 'department', 'group', 'user'];
  // 兼容早期未保存 targetScope 的配置（视为全员）；但显式错误值必须拒绝，
  // 否则一个拼写错误就可能把部门提醒扩大成全员提醒。
  if (value.targetScope !== undefined && !scopes.includes(value.targetScope as UserAudienceScope)) {
    throw new BusinessError('提醒范围无效');
  }
  const targetScope = (value.targetScope ?? 'all') as UserAudienceScope;
  const message = typeof value.message === 'string' ? value.message.trim() : '';
  if (!message) throw new BusinessError('提醒内容不能为空');
  if (message.length > 1000) throw new BusinessError('提醒内容不能超过1000个字符');

  const config: TimesheetReminderConfig = { enabled, weekdays, time, targetScope, message };
  if (targetScope === 'department') config.targetDeptId = parsePositiveId(value.targetDeptId, 'targetDeptId');
  if (targetScope === 'group') config.targetGroupId = parsePositiveId(value.targetGroupId, 'targetGroupId');
  if (targetScope === 'user') {
    if (!Array.isArray(value.targetUserIds) || !value.targetUserIds.length || value.targetUserIds.length > 2000) {
      throw new BusinessError('请选择1至2000名提醒用户');
    }
    config.targetUserIds = Array.from(new Set(value.targetUserIds.map((id, index) => (
      parsePositiveId(id, `targetUserIds[${index}]`)
    ))));
  }
  return config;
}

export function parseTimesheetReminderConfig(raw: string | null | undefined): TimesheetReminderConfig {
  if (!raw) return { ...DEFAULT_TIMESHEET_REMINDER_CONFIG };
  try {
    return normalizeTimesheetReminderConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw new BusinessError('工时提醒配置不是有效 JSON');
  }
}

type LocalTime = { slot: string; weekday: number; time: string };

function getShanghaiLocalTime(now: Date): LocalTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value || '';
  const time = `${part('hour')}:${part('minute')}`;
  const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    slot: `${part('year')}-${part('month')}-${part('day')} ${time}`,
    weekday: weekdayMap[part('weekday')] || 0,
    time,
  };
}

/** 定时读取配置并触发 TT 工时填写提醒；数据库槽位锁避免多实例重复发送。 */
export class TimesheetReminderScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 30_000);
    this.timer.unref();
    const initial = setTimeout(() => { void this.tick(); }, 2_000);
    initial.unref();
    logger.info({ timeZone: DEFAULT_TIME_ZONE }, '[timesheet-reminder] 调度器已启动');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running || !AppDataSource.isInitialized) return;
    this.running = true;
    try {
      const setting = await AppDataSource.getRepository(SystemSetting).findOne({
        where: { key: TIMESHEET_REMINDER_SETTING_KEY },
      });
      const config = parseTimesheetReminderConfig(setting?.value);
      if (!config.enabled) return;

      const local = getShanghaiLocalTime(now);
      if (config.time !== local.time || !config.weekdays.includes(local.weekday)) return;
      if (!await this.claimSlot(local.slot)) return;

      try {
        const userIds = await new UserAudienceService().resolveUserIds(config);
        // 站内通知（可靠载体）+ best-effort TT：未绑 SIAM 或 TT 失败时用户仍可在站内收到，
        // 同时形成可审计的提醒记录（原 publishTtOnly 不建站内通知，失败即无痕）。
        const result = await new NotificationPublisher().publishToUsers(userIds, {
          type: 'timesheet_reminder',
          title: '工时填写提醒',
          content: config.message,
          targetType: 'timesheet',
        });
        if (userIds.length && !result.notifications?.length) {
          // 站内投递失败：释放槽位以便下一 tick 重试，避免该周提醒永久丢失
          await this.releaseSlot(local.slot);
          logger.warn({ slot: local.slot, targetCount: userIds.length, ttStatus: result.ttStatus }, '[timesheet-reminder] 站内通知投递失败，已释放槽位待重试');
          return;
        }
        logger.info({ slot: local.slot, targetCount: userIds.length, ttStatus: result.ttStatus }, '[timesheet-reminder] 提醒任务执行完成');
      } catch (error) {
        // 发送过程异常：释放槽位以便重试（错误由外层 catch 记录）
        await this.releaseSlot(local.slot).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      logger.error({ err: error }, '[timesheet-reminder] 提醒任务执行失败');
    } finally {
      this.running = false;
    }
  }

  private async claimSlot(slot: string): Promise<boolean> {
    return AppDataSource.transaction(async manager => {
      if (databaseType === 'postgres') {
        await manager.query('SELECT pg_advisory_xact_lock($1)', [REMINDER_LOCK_ID]);
      }
      const repo = manager.getRepository(SystemSetting);
      let setting = await repo.findOne({ where: { key: LAST_SLOT_SETTING_KEY } });
      if (setting?.value === slot) return false;
      if (setting) {
        setting.value = slot;
      } else {
        setting = repo.create({
          key: LAST_SLOT_SETTING_KEY,
          value: slot,
          label: '工时提醒最近执行时间',
          description: '系统内部幂等标记，请勿手工修改',
        });
      }
      await repo.save(setting);
      return true;
    });
  }

  /** 释放已占用的槽位，使下一 tick 可重试（仅在投递失败时调用）。 */
  private async releaseSlot(slot: string): Promise<void> {
    try {
      await AppDataSource.getRepository(SystemSetting).delete({ key: LAST_SLOT_SETTING_KEY });
    } catch (err) {
      logger.warn({ err, slot }, '[timesheet-reminder] 释放槽位失败');
    }
  }
}

export const timesheetReminderScheduler = new TimesheetReminderScheduler();
