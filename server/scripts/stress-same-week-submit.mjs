#!/usr/bin/env node
/**
 * 场景 A：多人同时提交同一周
 *
 * 用法:
 *   node scripts/stress-same-week-submit.mjs [users] [rounds]
 * 环境变量:
 *   BASE_URL, WEEK_START(默认 2030-01-07), PROJECT_ID
 */
import { performance } from 'node:perf_hooks';

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3001/worktime').replace(/\/+$/, '');
const PROJECT_ID = Number(process.env.PROJECT_ID || 1);
const WEEK_START = process.env.WEEK_START || '2030-01-07'; // 周一
const userCount = Math.max(2, Number(process.argv[2] || 10));
const rounds = Math.max(1, Number(process.argv[3] || 5));

function userName(i) {
  return i === 1 ? 'stress_emp' : `stress_emp${i}`;
}

async function login(username) {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' }),
  });
  const body = await res.json();
  if (!res.ok || body.code !== 0) throw new Error(`登录失败 ${username}: ${JSON.stringify(body)}`);
  return body.data.token;
}

async function submit(token, username, round) {
  // 每轮换一周，避免与上一轮冲突；同轮内所有人同一周
  const d = new Date(WEEK_START + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + (round - 1) * 7);
  const weekStart = d.toISOString().slice(0, 10);
  const t0 = performance.now();
  let httpStatus = 0;
  let code = -1;
  let message = '';
  try {
    const res = await fetch(`${BASE_URL}/api/v1/timesheets/submit-rows`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: [{
          projectId: PROJECT_ID,
          description: `同周并发提交 ${username} R${round}`,
          weekStart,
          entries: [{ date: weekStart, days: 0.5 }],
        }],
      }),
    });
    httpStatus = res.status;
    const body = await res.json().catch(() => ({}));
    code = body.code ?? -1;
    message = body.message || '';
  } catch (e) {
    message = e.message || String(e);
  }
  return { ok: httpStatus === 200 && code === 0, httpStatus, code, message, ms: performance.now() - t0, username, weekStart };
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function run() {
  const users = Array.from({ length: userCount }, (_, i) => userName(i + 1));
  console.log(`场景: 多人同时提交同一周`);
  console.log(`目标: ${BASE_URL}`);
  console.log(`用户数: ${userCount}  轮次: ${rounds}  基线周: ${WEEK_START}`);
  console.log(`每轮并发 = ${userCount}（同周）\n`);

  const tokens = {};
  for (const u of users) tokens[u] = await login(u);
  console.log('全部登录成功\n');

  const all = [];
  const wall0 = performance.now();
  for (let r = 1; r <= rounds; r++) {
    const roundResults = await Promise.all(users.map((u) => submit(tokens[u], u, r)));
    all.push(...roundResults);
    const ok = roundResults.filter((x) => x.ok).length;
    console.log(`Round ${r}: ${ok}/${users.length} 成功  week=${roundResults[0].weekStart}`);
  }
  const wallMs = performance.now() - wall0;

  const ok = all.filter((r) => r.ok);
  const fail = all.filter((r) => !r.ok);
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  const errBuckets = new Map();
  for (const r of fail) {
    const k = `HTTP ${r.httpStatus} / code ${r.code} / ${r.message}`;
    errBuckets.set(k, (errBuckets.get(k) || 0) + 1);
  }

  console.log('\n========== 同周并发提交结果 ==========');
  console.log(`总请求:     ${all.length}`);
  console.log(`总耗时:     ${(wallMs / 1000).toFixed(2)} s`);
  console.log(`吞吐:       ${(all.length / (wallMs / 1000)).toFixed(2)} req/s`);
  console.log(`成功:       ${ok.length}/${all.length} (${((ok.length / all.length) * 100).toFixed(1)}%)`);
  console.log(`失败:       ${fail.length}`);
  if (lat.length) {
    console.log(`延迟 ms:    p50=${pct(lat, 50).toFixed(1)} p95=${pct(lat, 95).toFixed(1)} max=${lat[lat.length - 1].toFixed(1)} avg=${(lat.reduce((s, x) => s + x, 0) / lat.length).toFixed(1)}`);
  }
  if (errBuckets.size) {
    console.log('--- 错误分布 ---');
    for (const [k, n] of [...errBuckets.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x  ${k}`);
  }
  console.log('======================================');
}

run().catch((e) => { console.error(e); process.exit(1); });
