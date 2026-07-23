import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  getRedis: vi.fn(),
  isRedisReady: vi.fn(),
}));

vi.mock('@server/config/redis', () => ({
  getRedis: mocks.getRedis,
  isRedisReady: mocks.isRedisReady,
}));

const {
  activateRateLimiters,
  agentLimiter,
  authenticatedRateKey,
  globalLimiter,
} = await import('@server/middleware/security');

describe('安全限流配置', () => {
  beforeEach(() => {
    mocks.getRedis.mockReset().mockReturnValue(null);
    mocks.isRedisReady.mockReset().mockReturnValue(false);
  });

  it('登录用户按令牌哈希隔离限流桶，键中不包含明文令牌', () => {
    const keyA = authenticatedRateKey({
      headers: { authorization: 'Bearer token-a' }, ip: '127.0.0.1',
    } as any);
    const keyB = authenticatedRateKey({
      headers: { authorization: 'Bearer token-b' }, ip: '127.0.0.1',
    } as any);
    expect(keyA).toMatch(/^token:[a-f0-9]{32}$/);
    expect(keyA).not.toContain('token-a');
    expect(keyA).not.toBe(keyB);
  });

  it('未登录请求按规范化 IP 限流', () => {
    expect(authenticatedRateKey({ headers: {}, ip: '10.0.0.8' } as any))
      .toMatch(/^ip:/);
  });

  it('Redis 初始化前占位中间件放行；激活后 AI 限流按令牌隔离额度', async () => {
    const nextBefore = vi.fn();
    globalLimiter({} as any, {} as any, nextBefore);
    expect(nextBefore).toHaveBeenCalledOnce();

    activateRateLimiters();
    const app = express();
    app.set('trust proxy', 1);
    app.use(agentLimiter);
    app.get('/', (_req, res) => res.json({ code: 0 }));

    for (let index = 0; index < 30; index += 1) {
      const response = await request(app).get('/').set('Authorization', 'Bearer same-user-token');
      expect(response.status).toBe(200);
    }
    const limited = await request(app).get('/').set('Authorization', 'Bearer same-user-token');
    expect(limited.status).toBe(429);
    expect(limited.body.message).toBe('对话请求过于频繁，请稍后再试');

    const otherUser = await request(app).get('/').set('Authorization', 'Bearer another-user-token');
    expect(otherUser.status).toBe(200);
  });
});
