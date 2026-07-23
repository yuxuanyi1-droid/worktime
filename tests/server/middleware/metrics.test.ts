import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const queueMetrics = vi.hoisted(() => ({
  queue: vi.fn(async () => 7),
  dead: vi.fn(async () => 2),
}));

vi.mock('@server/services/approvalQueue', () => ({
  approvalQueueLength: queueMetrics.queue,
  approvalDeadLetterLength: queueMetrics.dead,
}));

const { metricsHandler, metricsMiddleware, setAiWorkerStats } = await import('@server/middleware/metrics');

describe('Prometheus 指标中间件', () => {
  it('记录请求耗时并归一化数字 ID 与 UUID，避免标签基数失控', async () => {
    const response = new EventEmitter() as any;
    response.statusCode = 201;
    const next = vi.fn();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_250);

    metricsMiddleware({
      method: 'GET',
      path: '/users/42/sessions/123e4567-e89b-12d3-a456-426614174000',
    } as any, response, next);
    response.emit('finish');

    expect(next).toHaveBeenCalledOnce();

    let payload = '';
    const metricsResponse = {
      set: vi.fn(),
      end: vi.fn((value: string) => { payload = value; }),
    } as any;
    await metricsHandler({} as any, metricsResponse);

    expect(metricsResponse.set).toHaveBeenCalledWith('Content-Type', expect.stringContaining('text/plain'));
    expect(payload).toContain('route="/users/:id/sessions/:uuid"');
    expect(payload).toContain('status="201"');
    expect(payload).toContain('approval_queue_messages 7');
    expect(payload).toContain('approval_dead_letter_messages 2');
    setAiWorkerStats({ active: 8, queued: 3, residentSessions: 42 });
    await metricsHandler({} as any, metricsResponse);
    expect(payload).toContain('ai_active_prompts 8');
    expect(payload).toContain('ai_queued_prompts 3');
    expect(payload).toContain('ai_resident_sessions 42');
  });

  it('空路径统一记录为 unknown', async () => {
    const response = new EventEmitter() as any;
    response.statusCode = 204;
    metricsMiddleware({ method: 'POST', path: '' } as any, response, vi.fn());
    response.emit('finish');

    let payload = '';
    await metricsHandler({} as any, {
      set: vi.fn(),
      end: (value: string) => { payload = value; },
    } as any);
    expect(payload).toContain('route="unknown"');
  });
});
