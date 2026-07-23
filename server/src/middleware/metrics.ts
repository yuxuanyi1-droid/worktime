import { Request, Response, NextFunction } from 'express';
import promClient from 'prom-client';
import { approvalDeadLetterLength, approvalQueueLength } from '../services/approvalQueue';

/**
 * Prometheus 指标采集。
 * - HTTP 请求计数（按 method/route/status）
 * - HTTP 请求耗时直方图
 * - 进程/默认指标（CPU/内存/GC）
 * 暴露 /api/metrics 端点供 Prometheus 抓取。
 */

// 注册表：收集所有指标
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// HTTP 请求总数
const httpRequestTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'HTTP 请求总数',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
});

// HTTP 请求耗时（秒）
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP 请求耗时',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

new promClient.Gauge({
  name: 'approval_queue_messages',
  help: '工时审批队列中待处理及待重试消息数',
  registers: [register],
  async collect() {
    this.set(await approvalQueueLength());
  },
});

const aiActivePrompts = new promClient.Gauge({
  name: 'ai_active_prompts',
  help: '当前 API 实例正在生成的 AI 会话数',
  registers: [register],
});
const aiQueuedPrompts = new promClient.Gauge({
  name: 'ai_queued_prompts',
  help: '当前 API 实例等待生成的 AI 会话数',
  registers: [register],
});
const aiResidentSessions = new promClient.Gauge({
  name: 'ai_resident_sessions',
  help: '当前 API 实例 AI Worker 内存驻留会话数',
  registers: [register],
});

export function setAiWorkerStats(stats: { active: number; queued: number; residentSessions: number }) {
  aiActivePrompts.set(Math.max(0, Number(stats.active) || 0));
  aiQueuedPrompts.set(Math.max(0, Number(stats.queued) || 0));
  aiResidentSessions.set(Math.max(0, Number(stats.residentSessions) || 0));
}

export function resetAiWorkerStats() {
  setAiWorkerStats({ active: 0, queued: 0, residentSessions: 0 });
}

new promClient.Gauge({
  name: 'approval_dead_letter_messages',
  help: '工时审批死信队列消息数，需要人工排查',
  registers: [register],
  async collect() {
    this.set(await approvalDeadLetterLength());
  },
});

/** 标准化路由路径（去掉 :id 等参数，便于聚合） */
function normalizeRoute(path: string): string {
  if (!path) return 'unknown';
  return path
    // UUID 可能以数字开头，必须先于数字 ID 归一化，避免被截断成 `/:id...`。
    .replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '/:uuid')
    .replace(/\/\d+/g, '/:id'); // 数字 id
}

/** 指标采集中间件：记录每个请求的 method/route/status/耗时 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = normalizeRoute(req.route?.path || req.path);
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };
    httpRequestTotal.inc(labels);
    httpRequestDuration.observe(labels, duration);
  });
  next();
}

/** /api/metrics 端点处理器 */
export async function metricsHandler(_req: Request, res: Response) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}
