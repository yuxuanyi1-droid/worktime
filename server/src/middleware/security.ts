import crypto from 'node:crypto';
import rateLimit, { ipKeyGenerator, type Options, type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { Request, RequestHandler } from 'express';
import { getRedis, isRedisReady } from '../config/redis';

type LimiterOpts = Partial<Options> & { windowMs: number; max: number; message: object; prefix: string };

function buildStore(prefix: string) {
  const client = getRedis();
  if (!client || !isRedisReady()) return undefined;
  return new RedisStore({
    prefix,
    sendCommand: (...args: string[]) => client.sendCommand(args) as Promise<RedisReply>,
  });
}

function createLimiter(opts: LimiterOpts): RateLimitRequestHandler {
  const { prefix, ...rest } = opts;
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    store: buildStore(prefix),
    ...rest,
  });
}

/** 登录后的请求按令牌隔离额度，避免公司 NAT 出口下所有员工共享同一个 IP 桶。 */
function authenticatedRateKey(req: Request): string {
  const authorization = req.headers.authorization || '';
  if (authorization.startsWith('Bearer ')) {
    return `token:${crypto.createHash('sha256').update(authorization.slice(7)).digest('hex').slice(0, 32)}`;
  }
  return `ip:${ipKeyGenerator(req.ip || 'unknown')}`;
}

/** 可在 Redis 就绪后替换实现的占位中间件 */
function deferredLimiter(): RequestHandler & { replace: (h: RequestHandler) => void } {
  let impl: RequestHandler = (_req, _res, next) => next();
  const mw = ((req, res, next) => impl(req, res, next)) as RequestHandler & { replace: (h: RequestHandler) => void };
  mw.replace = (h) => { impl = h; };
  return mw;
}

/**
 * 全局限流：登录后按令牌、未登录按 IP，避免办公网 NAT 误伤。
 * 启动时先放行，initRedis 成功后由 activateRateLimiters() 挂上真实限流（含 Redis store）。
 */
export const globalLimiter = deferredLimiter();
export const loginLimiter = deferredLimiter();
export const oidcCallbackLimiter = deferredLimiter();
export const agentLimiter = deferredLimiter();

/** Redis 连接完成后（或确认无 Redis）调用，启用限流 */
export function activateRateLimiters(): void {
  globalLimiter.replace(createLimiter({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.GLOBAL_RATE_MAX || 1000),
    prefix: 'rl:global:',
    keyGenerator: authenticatedRateKey,
    skip: (req) => req.path.endsWith('/auth/login'),
    message: { code: 429, message: '请求过于频繁，请稍后再试' },
  }));
  loginLimiter.replace(createLimiter({
    windowMs: 10 * 60 * 1000,
    max: Number(process.env.LOGIN_RATE_MAX || 100),
    prefix: 'rl:login:',
    skipSuccessfulRequests: true,
    message: { code: 429, message: '登录尝试过于频繁，请稍后再试' },
  }));
  oidcCallbackLimiter.replace(createLimiter({
    windowMs: 10 * 60 * 1000,
    max: 30,
    prefix: 'rl:oidc:',
    message: { code: 429, message: 'SSO 回调请求过于频繁，请稍后再试' },
  }));
  agentLimiter.replace(createLimiter({
    windowMs: 60 * 1000,
    max: 30,
    prefix: 'rl:agent:',
    message: { code: 429, message: '对话请求过于频繁，请稍后再试' },
  }));
}
