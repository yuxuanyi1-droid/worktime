#!/usr/bin/env node
/**
 * 工时提交（submit-rows）压测脚本
 *
 * 用法:
 *   node scripts/stress-timesheet-submit.mjs [concurrency] [total]
 * 环境变量:
 *   BASE_URL   默认 http://127.0.0.1:3001/worktime
 *   USERNAME   默认 stress_emp
 *   PASSWORD   默认 123456
 *   PROJECT_ID 默认 1
 */
import { performance } from 'node:perf_hooks';

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3001/worktime').replace(/\/+$/, '');
const USERNAME = process.env.USERNAME || 'stress_emp';
const PASSWORD = process.env.PASSWORD || '123456';
const PROJECT_ID = Number(process.env.PROJECT_ID || 1);
const WEEK_OFFSET = Number(process.env.WEEK_OFFSET || Math.floor(Date.now() / 1000) % 100000);
const concurrency = Math.max(1, Number(process.argv[2] || 10));
const total = Math.max(1, Number(process.argv[3] || 50));

function mondayPlusWeeks(weeks) {
  // 2015-01-05 是周一；每请求独占一周，避免日上限与同周版本冲突
  const d = new Date(Date.UTC(2015, 0, 5));
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

async function login() {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const body = await res.json();
  if (!res.ok || body.code !== 0 || !body.data?.token) {
    throw new Error(`登录失败: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body.data.token;
}

async function submit(token, weekIndex) {
  const weekStart = mondayPlusWeeks(weekIndex);
  const t0 = performance.now();
  let httpStatus = 0;
  let code = -1;
  let message = '';
  try {
    const res = await fetch(`${BASE_URL}/api/v1/timesheets/submit-rows`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rows: [{
          projectId: PROJECT_ID,
          description: `压测提交 #${weekIndex}`,
          weekStart,
          entries: [{ date: weekStart, days: 0.5 }],
        }],
      }),
    });
    httpStatus = res.status;
    const body = await res.json().catch(() => ({}));
    code = body.code ?? -1;
    message = body.message || '';
  } catch (err) {
    message = err.message || String(err);
  }
  const ms = performance.now() - t0;
  return { ok: httpStatus === 200 && code === 0, httpStatus, code, message, ms, weekStart };
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

async function run() {
  console.log(`目标: ${BASE_URL}`);
  console.log(`账号: ${USERNAME}  项目: ${PROJECT_ID}`);
  console.log(`并发: ${concurrency}  总请求: ${total}`);
  const token = await login();
  console.log('登录成功，开始压测...\n');

  const results = new Array(total);
  let next = 0;
  const wall0 = performance.now();

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= total) return;
      results[i] = await submit(token, WEEK_OFFSET + i);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const wallMs = performance.now() - wall0;

  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  const latencies = ok.map((r) => r.ms).sort((a, b) => a - b);
  const allLat = results.map((r) => r.ms).sort((a, b) => a - b);

  const errBuckets = new Map();
  for (const r of fail) {
    const key = `HTTP ${r.httpStatus} / code ${r.code} / ${r.message}`;
    errBuckets.set(key, (errBuckets.get(key) || 0) + 1);
  }

  console.log('========== 工时提交压测结果 ==========');
  console.log(`总耗时:     ${(wallMs / 1000).toFixed(2)} s`);
  console.log(`吞吐:       ${(total / (wallMs / 1000)).toFixed(2)} req/s`);
  console.log(`成功:       ${ok.length}/${total} (${((ok.length / total) * 100).toFixed(1)}%)`);
  console.log(`失败:       ${fail.length}`);
  console.log('--- 成功请求延迟 (ms) ---');
  if (latencies.length) {
    console.log(`  min  ${latencies[0].toFixed(1)}`);
    console.log(`  p50  ${pct(latencies, 50).toFixed(1)}`);
    console.log(`  p90  ${pct(latencies, 90).toFixed(1)}`);
    console.log(`  p95  ${pct(latencies, 95).toFixed(1)}`);
    console.log(`  p99  ${pct(latencies, 99).toFixed(1)}`);
    console.log(`  max  ${latencies[latencies.length - 1].toFixed(1)}`);
    console.log(`  avg  ${(latencies.reduce((s, x) => s + x, 0) / latencies.length).toFixed(1)}`);
  } else {
    console.log('  (无成功请求)');
  }
  console.log('--- 全部请求延迟 (ms) ---');
  console.log(`  p50  ${pct(allLat, 50).toFixed(1)}  p95  ${pct(allLat, 95).toFixed(1)}  max  ${allLat[allLat.length - 1].toFixed(1)}`);
  if (errBuckets.size) {
    console.log('--- 错误分布 ---');
    for (const [k, n] of [...errBuckets.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n}x  ${k}`);
    }
  }
  console.log('======================================');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
