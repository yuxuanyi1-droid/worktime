#!/usr/bin/env node
/**
 * 审批队列恢复演练：暂停指定 worker，制造一条已投递未 ACK 的任务，再恢复 worker，
 * 验证超过 CLAIM_IDLE_MS 后任务被接管且不会重复创建审批实例。
 * 用法：node scripts/drill-approval-recovery.cjs <workerPid...>
 */
require('../dist/config/env');
const { AppDataSource } = require('../dist/config/database');
const { createClient } = require('redis');

const STREAM_KEY = 'worktime:stream:timesheet-approval';
const GROUP = 'timesheet-approval-workers';
const workerPids = process.argv.slice(2).map(Number).filter(Number.isInteger);
const claimIdleMs = Math.max(5_000, Number(process.env.APPROVAL_CLAIM_IDLE_MS || 30_000));

async function main() {
  if (!workerPids.length) throw new Error('至少传入一个 worker PID');
  await AppDataSource.initialize();
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();

  try {
    const [sample] = await AppDataSource.query(`
      SELECT id AS "targetId", ARRAY[id] AS "recordIds", "projectId", "userId"
      FROM timesheets
      WHERE "approvalInstanceId" IS NOT NULL
      ORDER BY id DESC
      LIMIT 1
    `);
    if (!sample) throw new Error('没有可用于幂等演练的已审批工时');

    workerPids.forEach((pid) => process.kill(pid, 'SIGSTOP'));
    try {
      await redis.xAdd(STREAM_KEY, '*', {
        payload: JSON.stringify({ ...sample, title: '审批恢复验证' }),
      });
      await redis.xReadGroup(GROUP, 'crashed-worker', { key: STREAM_KEY, id: '>' }, { COUNT: 1 });
    } finally {
      workerPids.forEach((pid) => process.kill(pid, 'SIGCONT'));
    }

    const before = await redis.xPending(STREAM_KEY, GROUP);
    console.log(JSON.stringify({ phase: '模拟宕机后', pending: Number(before.pending) }));
    await new Promise((resolve) => setTimeout(resolve, claimIdleMs + 3_000));
    const after = await redis.xPending(STREAM_KEY, GROUP);
    const [duplicates] = await AppDataSource.query(`
      SELECT COUNT(*)::int AS count
      FROM approval_instances
      WHERE "targetType" = 'timesheet' AND "targetId" = $1
    `, [sample.targetId]);
    console.log(JSON.stringify({
      phase: '自动接管后',
      pending: Number(after.pending),
      approvalInstanceCount: duplicates.count,
      targetId: sample.targetId,
    }));

    if (Number(after.pending) !== 0 || Number(duplicates.count) !== 1) process.exitCode = 1;
  } finally {
    if (redis.isOpen) await redis.quit();
    await AppDataSource.destroy();
  }
}

main().catch((error) => {
  workerPids.forEach((pid) => {
    try { process.kill(pid, 'SIGCONT'); } catch { /* ignore */ }
  });
  console.error(error);
  process.exit(1);
});
