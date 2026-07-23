import { describe, expect, it, vi } from 'vitest';
import { PromptScheduler } from '@server/ai/promptScheduler';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('PromptScheduler', () => {
  it('限制并发并按顺序释放排队任务', async () => {
    const scheduler = new PromptScheduler(1, 2);
    const firstGate = deferred();
    const secondTask = vi.fn().mockResolvedValue('second');

    const first = scheduler.run('session-1', async () => {
      await firstGate.promise;
      return 'first';
    });
    const second = scheduler.run('session-2', secondTask);
    await Promise.resolve();
    expect(scheduler.stats()).toEqual({ active: 1, queued: 1 });
    expect(secondTask).not.toHaveBeenCalled();

    firstGate.resolve();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('同一会话拒绝并行生成，队列满时返回友好错误', async () => {
    const scheduler = new PromptScheduler(1, 1);
    const gate = deferred();
    const running = scheduler.run('session-1', () => gate.promise);
    await expect(scheduler.run('session-1', async () => undefined)).rejects.toThrow('当前会话正在处理中');
    const queued = scheduler.run('session-2', async () => undefined);
    await expect(scheduler.run('session-3', async () => undefined)).rejects.toThrow('任务较多');
    gate.resolve();
    await running;
    await queued;
  });

  it('可取消尚未开始的排队会话，且不占用后续槽位', async () => {
    const scheduler = new PromptScheduler(1, 2);
    const gate = deferred();
    const running = scheduler.run('session-1', () => gate.promise);
    const queued = scheduler.run('session-2', async () => 'should-not-run');
    await Promise.resolve();

    expect(scheduler.cancelQueued('session-2')).toBe(true);
    await expect(queued).rejects.toThrow('任务已取消');
    gate.resolve();
    await running;
    expect(scheduler.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('并发和排队变化会通知监控，监控异常不影响任务', async () => {
    const snapshots: Array<{ active: number; queued: number }> = [];
    const scheduler = new PromptScheduler(1, 1, stats => snapshots.push({ ...stats }));
    await expect(scheduler.run('session-1', async () => 'ok')).resolves.toBe('ok');
    expect(snapshots).toEqual([
      { active: 1, queued: 0 },
      { active: 0, queued: 0 },
    ]);

    const resilient = new PromptScheduler(1, 0, () => { throw new Error('metrics failed'); });
    await expect(resilient.run('session-2', async () => 'still-ok')).resolves.toBe('still-ok');
  });
});
