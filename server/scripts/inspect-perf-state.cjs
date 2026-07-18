#!/usr/bin/env node
/**
 * 性能压测后的数据一致性检查：审批缺失、重复审批实例、队列积压与连接占用。
 * 先执行 npm run build，再从 server/ 目录运行本脚本。
 */
require('../dist/config/env');
const { AppDataSource } = require('../dist/config/database');
const { createClient } = require('redis');

async function main() {
  await AppDataSource.initialize();
  try {
    const [timesheets] = await AppDataSource.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE status = 'submitted' AND "approvalInstanceId" IS NULL
        )::int AS waiting_for_approval,
        COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
        COUNT(*) FILTER (WHERE status = 'submitted')::int AS submitted
      FROM timesheets
      WHERE description LIKE '压测提交 #%'
         OR description LIKE '同周并发提交 %'
    `);
    const [duplicates] = await AppDataSource.query(`
      SELECT COUNT(*)::int AS duplicate_targets
      FROM (
        SELECT "targetType", "targetId"
        FROM approval_instances
        GROUP BY "targetType", "targetId"
        HAVING COUNT(*) > 1
      ) duplicated
    `);
    const [connections] = await AppDataSource.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE state = 'active')::int AS active,
        COUNT(*) FILTER (WHERE state = 'idle')::int AS idle
      FROM pg_stat_activity
      WHERE datname = current_database()
    `);
    const [sampleJob] = await AppDataSource.query(`
      SELECT
        id AS "targetId",
        ARRAY[id] AS "recordIds",
        "projectId",
        "userId",
        '审批恢复验证' AS title
      FROM timesheets
      WHERE description LIKE '压测提交 #%'
      ORDER BY id DESC
      LIMIT 1
    `);

    let queue = null;
    const redisUrl = (process.env.REDIS_URL || '').trim();
    if (redisUrl) {
      const redis = createClient({ url: redisUrl });
      try {
        await redis.connect();
        const streamLength = await redis.xLen('worktime:stream:timesheet-approval');
        let pending = 0;
        try {
          const summary = await redis.xPending(
            'worktime:stream:timesheet-approval',
            'timesheet-approval-workers',
          );
          pending = Number(summary?.pending ?? 0);
        } catch { /* consumer group 尚未创建 */ }
        queue = {
          streamLength,
          pending,
          legacyListLength: await redis.lLen('worktime:queue:timesheet-approval'),
        };
      } finally {
        if (redis.isOpen) await redis.quit();
      }
    }

    console.log(JSON.stringify({ timesheets, duplicates, connections, queue, sampleJob }, null, 2));
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
