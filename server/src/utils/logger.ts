import pino from 'pino';

/**
 * 结构化日志器（pino）。
 * - 开发环境：pretty 打印，便于阅读
 * - 生产环境：JSON 行，便于采集（ELK/Loki）
 *
 * 用法：import { logger } from './utils/logger';
 *      logger.info({ userId }, '用户登录');
 *      logger.error({ err }, '审批失败');
 */
const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
  base: { service: 'worktime-server' },
});
