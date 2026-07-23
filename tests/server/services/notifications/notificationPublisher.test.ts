import { describe, expect, it, vi } from 'vitest';
import { NotificationService } from '@server/services/notificationService';
import { NotificationPublisher } from '@server/services/notifications/notificationPublisher';
import { TtRobotClient, type TtRobotConfig } from '@server/services/notifications/ttRobotClient';

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

  it('仅发 TT 时不会创建重复的站内通知', async () => {
    const inApp = inAppService();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0 }),
    }));
    const publisher = new NotificationPublisher(
      inApp,
      new TtRobotClient(config(true), { fetch: fetchMock }),
      async () => ['8001'],
    );

    const status = await publisher.publishTtOnly([1], {
      type: 'announcement',
      title: '公告标题',
      content: '公告内容',
    });

    expect(status).toBe('sent');
    expect(inApp.createBatch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('审批抄送会向去重后的接收人创建可跳转通知', async () => {
    const inApp = inAppService();
    const publisher = new NotificationPublisher(
      inApp,
      new TtRobotClient(config(false)),
      vi.fn(async () => []),
    );

    await publisher.notifyApprovalCc([4, 4, 6], 'weekly_report', 23, '张三');

    expect(inApp.createBatch).toHaveBeenCalledWith([4, 6], {
      type: 'approval_cc',
      title: '审批抄送：周报申请',
      content: '张三向您抄送了一份周报申请，请查看详情',
      targetType: 'weekly_report',
      targetId: 23,
    });
  });
});
