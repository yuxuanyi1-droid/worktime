#!/usr/bin/env node
/**
 * 场景 B：提交 + 审批组合链路
 *
 * 每个 VU：员工 submit-rows → 审批人拉 pending → approve
 *
 * 用法:
 *   node scripts/stress-submit-approve.mjs [concurrency] [total]
 */
import { performance } from 'node:perf_hooks';

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3001/worktime').replace(/\/+$/, '');
const PROJECT_ID = Number(process.env.PROJECT_ID || 1);
const APPROVER = process.env.APPROVER || 'admin';
const WEEK_OFFSET = Number(process.env.WEEK_OFFSET || (Math.floor(Date.now() / 1000) % 90000) + 10000);
const concurrency = Math.max(1, Number(process.argv[2] || 10));
const total = Math.max(1, Number(process.argv[3] || 50));

const USER_POOL = Math.max(1, Number(process.env.USER_POOL || 100));

function empName(i) {
  // 轮转使用 stress_emp / stress_emp2..N
  const n = (i % USER_POOL) + 1;
  return n === 1 ? 'stress_emp' : `stress_emp${n}`;
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

function mondayPlusWeeks(weeks) {
  const d = new Date(Date.UTC(2028, 0, 3)); // 周一
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

async function submit(token, weekIndex, username) {
  const weekStart = mondayPlusWeeks(weekIndex);
  const t0 = performance.now();
  const res = await fetch(`${BASE_URL}/api/v1/timesheets/submit-rows`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rows: [{
        projectId: PROJECT_ID,
        description: `提交审批链路 ${username} #${weekIndex}`,
        weekStart,
        entries: [{ date: weekStart, days: 0.5 }],
      }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  return {
    ok: res.status === 200 && body.code === 0,
    httpStatus: res.status,
    code: body.code ?? -1,
    message: body.message || '',
    ms: performance.now() - t0,
    weekStart,
  };
}

async function findPendingTarget(approverToken, weekStart, applicantName, retries = 40) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(`${BASE_URL}/api/v1/approvals/pending?targetType=timesheet&page=1&pageSize=100`, {
      headers: { Authorization: `Bearer ${approverToken}` },
    });
    const body = await res.json().catch(() => ({}));
    const list = body.data?.list || body.data?.items || [];
    const hit = list.find((it) => {
      const dateOk = it.weekStart === weekStart || it.date === weekStart;
      const userOk = !applicantName || it.applicant === applicantName || String(it.applicant || '').includes(applicantName);
      return it.targetType === 'timesheet' && dateOk && userOk;
    });
    if (hit) {
      return {
        targetType: hit.targetType || 'timesheet',
        targetId: hit.targetId || hit.id,
        raw: hit,
      };
    }
    await new Promise((r) => setTimeout(r, 30 + i * 20));
  }
  return null;
}

async function approve(approverToken, targetType, targetId) {
  const t0 = performance.now();
  const res = await fetch(`${BASE_URL}/api/v1/approvals/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${approverToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ targetType, targetId, action: 'approve', comment: '压测自动通过' }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  return {
    ok: res.status === 200 && body.code === 0,
    httpStatus: res.status,
    code: body.code ?? -1,
    message: body.message || '',
    ms: performance.now() - t0,
  };
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const REAL_NAMES = Object.fromEntries(
  Array.from({ length: USER_POOL }, (_, i) => {
    const u = empName(i);
    const n = (i % USER_POOL) + 1;
    return [u, n === 1 ? '压测员工' : `压测员工${n}`];
  }),
);

async function runOne(empTokens, approverToken, index) {
  const username = empName(index);
  const token = empTokens[username];
  const t0 = performance.now();
  const stages = { submitMs: 0, findMs: 0, approveMs: 0 };
  const errors = [];

  const sub = await submit(token, WEEK_OFFSET + index, username);
  stages.submitMs = sub.ms;
  if (!sub.ok) {
    errors.push(`submit: HTTP ${sub.httpStatus} code ${sub.code} ${sub.message}`);
    return { ok: false, ms: performance.now() - t0, stages, errors, username };
  }

  const f0 = performance.now();
  const pending = await findPendingTarget(approverToken, sub.weekStart, REAL_NAMES[username]);
  stages.findMs = performance.now() - f0;
  if (!pending?.targetId) {
    errors.push('pending: 未找到待审批记录');
    return { ok: false, ms: performance.now() - t0, stages, errors, username, weekStart: sub.weekStart };
  }

  const appr = await approve(approverToken, pending.targetType, pending.targetId);
  stages.approveMs = appr.ms;
  if (!appr.ok) {
    errors.push(`approve: HTTP ${appr.httpStatus} code ${appr.code} ${appr.message}`);
  }

  return {
    ok: appr.ok,
    ms: performance.now() - t0,
    stages,
    errors,
    username,
    weekStart: sub.weekStart,
    targetId: pending.targetId,
  };
}

async function run() {
  console.log('场景: 提交 + 审批组合');
  console.log(`目标: ${BASE_URL}`);
  console.log(`并发: ${concurrency}  总链路: ${total}  审批人: ${APPROVER}\n`);

  const empNames = Array.from({ length: USER_POOL }, (_, i) => empName(i));
  const empTokens = {};
  for (const u of empNames) empTokens[u] = await login(u);
  const approverToken = await login(APPROVER);
  console.log(`登录完成（员工池 ${USER_POOL}），开始压测...\n`);

  const results = new Array(total);
  let next = 0;
  const wall0 = performance.now();

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= total) return;
      results[i] = await runOne(empTokens, approverToken, i);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const wallMs = performance.now() - wall0;

  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  const e2e = ok.map((r) => r.ms).sort((a, b) => a - b);
  const submitLat = results.map((r) => r.stages.submitMs).sort((a, b) => a - b);
  const approveLat = results.filter((r) => r.stages.approveMs).map((r) => r.stages.approveMs).sort((a, b) => a - b);

  const errBuckets = new Map();
  for (const r of fail) {
    const k = r.errors.join(' | ') || 'unknown';
    errBuckets.set(k, (errBuckets.get(k) || 0) + 1);
  }

  console.log('========== 提交+审批链路结果 ==========');
  console.log(`总耗时:     ${(wallMs / 1000).toFixed(2)} s`);
  console.log(`吞吐:       ${(total / (wallMs / 1000)).toFixed(2)} 链路/s`);
  console.log(`成功:       ${ok.length}/${total} (${((ok.length / total) * 100).toFixed(1)}%)`);
  console.log(`失败:       ${fail.length}`);
  if (e2e.length) {
    console.log(`端到端 ms:  p50=${pct(e2e, 50).toFixed(1)} p95=${pct(e2e, 95).toFixed(1)} max=${e2e[e2e.length - 1].toFixed(1)} avg=${(e2e.reduce((s, x) => s + x, 0) / e2e.length).toFixed(1)}`);
  }
  console.log(`提交 ms:    p50=${pct(submitLat, 50).toFixed(1)} p95=${pct(submitLat, 95).toFixed(1)}`);
  if (approveLat.length) {
    console.log(`审批 ms:    p50=${pct(approveLat, 50).toFixed(1)} p95=${pct(approveLat, 95).toFixed(1)}`);
  }
  if (errBuckets.size) {
    console.log('--- 错误分布 ---');
    for (const [k, n] of [...errBuckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${n}x  ${k}`);
    }
  }
  console.log('======================================');
}

run().catch((e) => { console.error(e); process.exit(1); });
