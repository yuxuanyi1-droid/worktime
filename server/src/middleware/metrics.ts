import { Request, Response, NextFunction } from 'express';
import promClient from 'prom-client';

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

/** 标准化路由路径（去掉 :id 等参数，便于聚合） */
function normalizeRoute(path: string): string {
  if (!path) return 'unknown';
  return path
    .replace(/\/\d+/g, '/:id') // 数字 id
    .replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '/:uuid');
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
