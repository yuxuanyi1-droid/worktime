import rateLimit from 'express-rate-limit';
import { NextFunction, Request, Response } from 'express';

/**
 * 全局限流：每个 IP 每 15 分钟最多 1000 次请求。
 * 生产环境应配合反向代理的 trust proxy + Redis store（多实例共享计数）。
 */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: '请求过于频繁，请稍后再试' },
});

/**
 * 登录接口限流：同一 IP 每 10 分钟最多 20 次登录尝试。
 * 与 auth.ts 内存级登录失败计数互补——后者防单账号爆破，这里防 IP 维度扫描。
 */
export const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: '当前网络登录请求过多，请稍后再试（IP 限流）' },
});
