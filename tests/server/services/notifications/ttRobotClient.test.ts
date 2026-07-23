import { describe, expect, it, vi } from 'vitest';
import {
  buildTtSignature,
  TtRobotClient,
  type TtRobotConfig,
} from '@server/services/notifications/ttRobotClient';

function createConfig(overrides: Partial<TtRobotConfig> = {}): TtRobotConfig {
  return {
    enabled: true,
    appId: 'app-123',
    appSecret: 'secret-456',
    robotId: 'robot-789',
    baseUrl: 'https://apimarket.myoas.com',
    envId: 'UAT',
    timeoutMs: 5000,
    batchSize: 2000,
    ...overrides,
  };
}

function successResponse(data: unknown = { code: 0 }) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
  };
}

describe('buildTtSignature', () => {
  it('按照文档约定生成 HMAC-SHA1 Base64 签名', () => {
    expect(buildTtSignature({
      appSecret: 'secret-456',
      method: 'POST',
      host: 'apimarket.myoas.com',
      path: '/oppo-mtp/oppo-robot/messages/send',
      appId: 'app-123',
      timestamp: '1700000000',
      nonce: '123456',
    })).toBe('uU3jdrhvU9MkeYS32UtbemdkdiM=');
  });
});

describe('TtRobotClient', () => {
  it('发送单人文本消息并携带签名请求头', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return successResponse();
    });
    const client = new TtRobotClient(createConfig(), {
      fetch: fetchMock,
      now: () => 1700000000000,
      nonce: () => '123456',
    });

    await client.sendText('80012345', '你好');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = calls[0];
    expect(url).toBe('https://apimarket.myoas.com/oppo-mtp/oppo-robot/messages/send');
    expect(init.headers).toMatchObject({
      appid: 'app-123',
      nonce: '123456',
      timestamp: '1700000000',
      sign: 'uU3jdrhvU9MkeYS32UtbemdkdiM=',
      signversion: '2.0.0',
      envid: 'UAT',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      msg: { text: '你好' },
      from: { pub: 'robot-789' },
      to: { receiveId: '80012345', receiveType: 1 },
      type: 2,
    });
  });

  it('批量消息自动去重并按配置分批', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return successResponse();
    });
    const client = new TtRobotClient(createConfig({ batchSize: 2 }), {
      fetch: fetchMock,
      now: () => 1700000000000,
      nonce: () => '123456',
    });

    await client.batchSendText(['8001', '8002', '8001', '8003'], '待审批');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(calls[0][1].body as string);
    const secondBody = JSON.parse(calls[1][1].body as string);
    expect(firstBody.to).toEqual([{ user: ['8001', '8002'] }]);
    expect(secondBody.to).toEqual([{ user: ['8003'] }]);
  });

  it('拒绝在 API 基地址中注入路径或凭据', () => {
    expect(() => new TtRobotClient(createConfig({
      baseUrl: 'https://user:pass@apimarket.myoas.com/evil',
    }))).toThrow('TT_API_BASE_URL');
  });
});
