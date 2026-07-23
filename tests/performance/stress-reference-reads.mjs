#!/usr/bin/env node
/** 模拟集中打开页面时的共享参考数据读取（项目、设置，可选组织目录）。从仓库根目录运行。 */
import { performance } from 'node:perf_hooks';

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3001/worktime').replace(/\/+$/, '');
const concurrency = Math.max(1, Number(process.argv[2] || 100));
const total = Math.max(1, Number(process.argv[3] || 1000));
const includeOrg = process.env.INCLUDE_ORG === '1';
const paths = [
  '/api/v1/system/projects/active',
  '/api/v1/system/settings',
  ...(includeOrg ? ['/api/v1/system/departments', '/api/v1/system/groups/tree'] : []),
];

async function login() {
  const response = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'stress_emp', password: '123456' }),
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0) throw new Error(`登录失败: ${JSON.stringify(body)}`);
  return body.data.token;
}

function percentile(values, p) {
  return values[Math.min(values.length - 1, Math.ceil(values.length * p / 100) - 1)] || 0;
}

async function main() {
  const token = await login();
  const results = new Array(total);
  let next = 0;
  const started = performance.now();

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= total) return;
      const t0 = performance.now();
      const responses = await Promise.all(paths.map((path) => fetch(`${BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      })));
      const bodies = await Promise.all(responses.map((response) => response.json().catch(() => ({}))));
      results[index] = {
        ok: responses.every((response, i) => response.ok && bodies[i].code === 0),
        ms: performance.now() - t0,
      };
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const wallMs = performance.now() - started;
  const ok = results.filter((result) => result.ok);
  const latencies = ok.map((result) => result.ms).sort((a, b) => a - b);
  console.log(JSON.stringify({
    target: BASE_URL,
    paths,
    concurrency,
    pageLoads: total,
    requests: total * paths.length,
    success: ok.length,
    pageLoadsPerSecond: Number((total / (wallMs / 1000)).toFixed(2)),
    requestsPerSecond: Number((total * paths.length / (wallMs / 1000)).toFixed(2)),
    p50Ms: Number(percentile(latencies, 50).toFixed(1)),
    p95Ms: Number(percentile(latencies, 95).toFixed(1)),
    maxMs: Number((latencies.at(-1) || 0).toFixed(1)),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
