import { describe, expect, it, vi } from 'vitest';
import { NotificationService } from '../notificationService';
import { NotificationPublisher } from './notificationPublisher';
import { TtRobotClient, type TtRobotConfig } from './ttRobotClient';

function config(enabled: boolean): TtRobotConfig {
  return {
    enabled,
    appId: 'app-123',
    appSecret: 'secret-456',
    robotId: 'robot-789',
    baseUrl: 'https://apimarket.myoas.com',
    timeoutMs: 5000,
    batchSize: 2000,
  };
}

function inAppService() {
  return {
    createBatch: vi.fn(async (userIds: number[], input: Record<string, unknown>) =>
      userIds.map(userId => ({ userId, ...input }))),
  } as unknown as NotificationService;
}

describe('NotificationPublisher', () => {
  it('TT 关闭时只写站内通知，不解析接收人', async () => {
    const inApp = inAppService();
    const resolver = vi.fn(async () => ['8001']);
    const publisher = new NotificationPublisher(inApp, new TtRobotClient(config(false)), resolver);

    const result = await publisher.publishToUsers([1, 1, 2], {
      type: 'system',
      title: '系统通知',
      content: '测试内容',
    });

    expect(inApp.createBatch).toHaveBeenCalledWith([1, 2], expect.objectContaining({ title: '系统通知' }));
    expect(resolver).not.toHaveBeenCalled();
    expect(result.ttStatus).toBe('disabled');
  });

  it('TT 开启时使用解析后的工号发送文本消息', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0 }),
      };
    });
    const tt = new TtRobotClient(config(true), {
      fetch: fetchMock,
      now: () => 1700000000000,
      nonce: () => '123456',
    });
    const publisher = new NotificationPublisher(
      inAppService(),
      tt,
      async () => ['8001', '8002'],
    );

    const result = await publisher.publishToUsers([1, 2], {
      type: 'approval_pending',
      title: '待审批：工时',
      content: '张三提交了一份工时申请',
    });

    expect(result.ttStatus).toBe('sent');
    const body = JSON.parse(calls[0][1].body as string);
    expect(body.to).toEqual([{ user: ['8001', '8002'] }]);
    expect(body.msg).toEqual({ text: '待审批：工时\n张三提交了一份工时申请' });
  });
});
