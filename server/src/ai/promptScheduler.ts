type Waiter = {
  sessionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
};

/**
 * AI 生成任务的进程内并发与排队控制。
 * 同一会话任何时刻只能有一个生成任务；排队任务可被 abort 取消。
 */
export class PromptScheduler {
  private active = 0;
  private readonly queue: Waiter[] = [];
  private readonly busySessions = new Set<string>();

  constructor(
    private readonly maxActive: number,
    private readonly maxQueued: number,
    private readonly onStatsChange?: (stats: { active: number; queued: number }) => void,
  ) {
    if (!Number.isInteger(maxActive) || maxActive < 1) throw new Error('AI 最大并发数必须是正整数');
    if (!Number.isInteger(maxQueued) || maxQueued < 0) throw new Error('AI 最大排队数必须是非负整数');
  }

  async run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    if (this.busySessions.has(sessionId)) throw new Error('当前会话正在处理中');
    this.busySessions.add(sessionId);
    let acquired = false;
    try {
      await this.acquire(sessionId);
      acquired = true;
      return await task();
    } finally {
      if (acquired) this.release();
      this.busySessions.delete(sessionId);
    }
  }

  cancelQueued(sessionId: string): boolean {
    const index = this.queue.findIndex((waiter) => waiter.sessionId === sessionId);
    if (index < 0) return false;
    const [waiter] = this.queue.splice(index, 1);
    waiter.reject(new Error('任务已取消'));
    this.notifyStats();
    return true;
  }

  stats() {
    return { active: this.active, queued: this.queue.length };
  }

  private acquire(sessionId: string): Promise<void> {
    if (this.active < this.maxActive) {
      this.active += 1;
      this.notifyStats();
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new Error('AI 服务当前任务较多，请稍后重试'));
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ sessionId, resolve, reject });
      this.notifyStats();
    });
  }

  private release() {
    const next = this.queue.shift();
    if (next) {
      // 当前槽位直接移交给排队任务，active 数量保持不变。
      this.notifyStats();
      next.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
    this.notifyStats();
  }

  private notifyStats() {
    try {
      this.onStatsChange?.(this.stats());
    } catch {
      // 可观测性回调不得影响 AI 任务调度。
    }
  }
}
