import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { runAuthMiddleware } from '@server/routes/oidc';

describe('OIDC 条件认证控制流', () => {
  it('认证中间件直接返回 401 时 Promise 也会结束，不会让绑定请求永久挂起', async () => {
    class FakeResponse extends EventEmitter {
      statusCode = 200;
      payload: unknown;
      status(code: number) { this.statusCode = code; return this; }
      json(payload: unknown) {
        this.payload = payload;
        this.emit('finish');
        return this;
      }
    }
    const response = new FakeResponse();
    const result = await runAuthMiddleware({ headers: {} } as any, response as any);
    expect(result).toBe(false);
    expect(response.statusCode).toBe(401);
    expect(response.payload).toMatchObject({ code: 401 });
  });
});
