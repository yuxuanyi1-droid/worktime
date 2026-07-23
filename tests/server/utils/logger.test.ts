import { describe, expect, it } from 'vitest';
import { createLogger } from '@server/utils/logger';

describe('结构化日志脱敏', () => {
  it('记录错误请求时隐藏认证头、Cookie 和常见凭据字段', () => {
    const chunks: string[] = [];
    const logger = createLogger({
      pretty: false,
      destination: {
        write(chunk: string) {
          chunks.push(chunk);
        },
      } as any,
    });

    logger.error({
      req: {
        headers: {
          authorization: 'Bearer private-jwt',
          cookie: 'session=private-cookie',
          accept: 'application/json',
        },
      },
      apiKey: 'private-api-key',
      clientSecret: 'private-client-secret',
    }, '测试错误');

    const output = chunks.join('');
    const record = JSON.parse(output);
    expect(output).not.toContain('private-jwt');
    expect(output).not.toContain('private-cookie');
    expect(output).not.toContain('private-api-key');
    expect(output).not.toContain('private-client-secret');
    expect(record.req.headers).toMatchObject({
      authorization: '[已脱敏]',
      cookie: '[已脱敏]',
      accept: 'application/json',
    });
    expect(record.apiKey).toBe('[已脱敏]');
    expect(record.clientSecret).toBe('[已脱敏]');
  });
});
