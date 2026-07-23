import pino, { type DestinationStream, type LoggerOptions } from 'pino';

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

export const SENSITIVE_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'request.headers.authorization',
  'request.headers.cookie',
  'request.headers["set-cookie"]',
  'response.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'authorization',
  'cookie',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'apiKey',
] as const;

export function createLogger(options: {
  pretty?: boolean;
  destination?: DestinationStream;
} = {}) {
  const pretty = options.pretty ?? isDev;
  const loggerOptions: LoggerOptions = {
    level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    redact: {
      paths: [...SENSITIVE_LOG_PATHS],
      censor: '[已脱敏]',
    },
    transport: pretty
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
    base: { service: 'worktime-server' },
  };
  return options.destination
    ? pino({ ...loggerOptions, transport: undefined }, options.destination)
    : pino(loggerOptions);
}

export const logger = createLogger();
