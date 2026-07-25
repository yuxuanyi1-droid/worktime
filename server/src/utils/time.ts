import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import isoWeek from 'dayjs/plugin/isoWeek';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isoWeek);

/**
 * 业务时区常量：所有周界/月界/锁定日/提醒调度均以此为准，
 * 避免依赖进程 TZ（容器默认常为 UTC，会导致月初/周一/锁定日边界偏移 8 小时）。
 */
export const BUSINESS_TIME_ZONE = 'Asia/Shanghai';

/** 以业务时区解读给定时刻（默认当前）为 dayjs 对象。 */
export function businessDayjs(now: Date | string | number = new Date()): dayjs.Dayjs {
  return dayjs(now).tz(BUSINESS_TIME_ZONE);
}

/** 业务时区下的今天（YYYY-MM-DD）。 */
export function businessToday(now: Date | string | number = new Date()): string {
  return businessDayjs(now).format('YYYY-MM-DD');
}

/** 业务时区下的本月起止（YYYY-MM-DD，含首尾）。 */
export function businessMonthRange(now: Date | string | number = new Date()) {
  const t = businessDayjs(now);
  return {
    monthStart: t.startOf('month').format('YYYY-MM-DD'),
    monthEnd: t.endOf('month').format('YYYY-MM-DD'),
  };
}

/** 业务时区下的本周起止（周一~周日，YYYY-MM-DD）。 */
export function businessWeekRange(now: Date | string | number = new Date()) {
  const monday = businessDayjs(now).startOf('isoWeek');
  return {
    weekStart: monday.format('YYYY-MM-DD'),
    weekEnd: monday.add(6, 'day').format('YYYY-MM-DD'),
  };
}
