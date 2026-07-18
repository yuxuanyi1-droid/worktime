#!/usr/bin/env node
/**
 * WSL/Linux 资源采样：压测时并行跑，量化 CPU/内存/磁盘与关键进程占用。
 *
 * 用法:
 *   node scripts/monitor-wsl.mjs [秒数] [间隔秒]
 *   node scripts/monitor-wsl.mjs --until-file /tmp/stress.done [间隔秒]
 *
 * 与压测一起:
 *   DONE=/tmp/stress.done
 *   rm -f "$DONE"
 *   node scripts/monitor-wsl.mjs --until-file "$DONE" 1 &
 *   node scripts/stress-timesheet-submit.mjs 100 300
 *   touch "$DONE"; wait
 *
 * 环境变量 MONITOR_CSV 可指定输出路径。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
let untilFile = '';
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--until-file') untilFile = args[++i] || '';
  else positional.push(args[i]);
}
const durationSec = Math.max(1, Number(positional[0]) || 60);
const intervalSec = Math.max(1, Number(positional[untilFile ? 0 : 1]) || 1);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outCsv = process.env.MONITOR_CSV || `/tmp/worktime-monitor-${stamp}.csv`;

const header = [
  'ts', 'elapsed_s', 'load1',
  'cpu_user', 'cpu_system', 'cpu_iowait', 'cpu_idle',
  'mem_used_pct', 'mem_available_mb', 'disk_util_pct',
  'node_cpu', 'node_rss_mb',
  'postgres_cpu', 'postgres_rss_mb',
  'redis_cpu', 'redis_rss_mb',
].join(',');

writeFileSync(outCsv, `${header}\n`);
console.log(`[monitor] 间隔 ${intervalSec}s  输出 ${outCsv}`);
if (untilFile) {
  console.log(`[monitor] 直到文件出现: ${untilFile}`);
  try { unlinkSync(untilFile); } catch { /* ok */ }
} else {
  console.log(`[monitor] 持续 ${durationSec}s`);
}

function sh(cmd) {
  try {
    return execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', timeout: 8000 });
  } catch {
    return '';
  }
}

function parseMem() {
  const raw = sh('cat /proc/meminfo');
  const get = (k) => {
    const m = raw.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  const total = get('MemTotal');
  const avail = get('MemAvailable') || get('MemFree');
  return {
    usedPct: total ? ((total - avail) / total) * 100 : 0,
    availMb: avail / 1024,
  };
}

function parseLoad() {
  return Number(sh('cat /proc/loadavg').trim().split(/\s+/)[0]) || 0;
}

function parseCpuTop() {
  const cpuLine = sh("top -bn1 | grep '%Cpu(s)' | head -1");
  const num = (re) => {
    const m = cpuLine.match(re);
    return m ? Number(m[1]) : 0;
  };
  return {
    user: num(/([0-9.]+)\s*us/),
    system: num(/([0-9.]+)\s*sy/),
    idle: num(/([0-9.]+)\s*id/),
    iowait: num(/([0-9.]+)\s*wa/),
  };
}

function parseDiskUtil() {
  // 取 util% 最大的设备；无 iostat 则 0
  const raw = sh(
    "iostat -dx 1 1 2>/dev/null | awk 'NR>3 && NF>1 {u=$NF+0; if(u>m)m=u} END{print m+0}'",
  );
  return Number(raw.trim()) || 0;
}

function parseProcGroup(pattern) {
  const raw = sh(`ps -eo pid,rss,comm,args --no-headers | grep -E '${pattern}' | grep -v grep || true`);
  const pids = raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((p) => /^\d+$/.test(p));
  let cpu = 0;
  let rssKb = 0;
  for (const pid of pids) {
    const st = sh(`ps -p ${pid} -o %cpu=,rss= --no-headers`).trim().split(/\s+/);
    cpu += Number(st[0]) || 0;
    rssKb += Number(st[1]) || 0;
  }
  return { cpu, rssMb: rssKb / 1024 };
}

const samples = [];
const t0 = performance.now();
let n = 0;

function sampleOnce() {
  const elapsed = (performance.now() - t0) / 1000;
  const mem = parseMem();
  const cpu = parseCpuTop();
  // 汇总完整应用拓扑：API、独立 worker，以及 Node/Caddy 两种网关。
  const node = parseProcGroup('dist/app\\.js|dist/approvalWorker\\.js|lb-round-robin|caddy run');
  const pg = parseProcGroup('postgres:');
  const redis = parseProcGroup('redis-server');

  const row = {
    ts: new Date().toISOString(),
    elapsed_s: elapsed.toFixed(1),
    load1: parseLoad().toFixed(2),
    cpu_user: cpu.user.toFixed(1),
    cpu_system: cpu.system.toFixed(1),
    cpu_iowait: cpu.iowait.toFixed(1),
    cpu_idle: cpu.idle.toFixed(1),
    mem_used_pct: mem.usedPct.toFixed(1),
    mem_available_mb: mem.availMb.toFixed(0),
    disk_util_pct: parseDiskUtil().toFixed(1),
    node_cpu: node.cpu.toFixed(1),
    node_rss_mb: node.rssMb.toFixed(0),
    postgres_cpu: pg.cpu.toFixed(1),
    postgres_rss_mb: pg.rssMb.toFixed(0),
    redis_cpu: redis.cpu.toFixed(1),
    redis_rss_mb: redis.rssMb.toFixed(0),
  };
  samples.push(row);
  appendFileSync(outCsv, `${Object.values(row).join(',')}\n`);
  n += 1;
  process.stdout.write(
    `\r[monitor] #${n} load=${row.load1} idle=${row.cpu_idle}% iowait=${row.cpu_iowait}% `
      + `node=${row.node_cpu}% pg=${row.postgres_cpu}% mem=${row.mem_used_pct}%   `,
  );
}

function summarize() {
  console.log('\n');
  if (!samples.length) {
    console.log('[monitor] 无样本');
    return;
  }
  const keys = [
    'load1', 'cpu_user', 'cpu_system', 'cpu_iowait', 'cpu_idle',
    'mem_used_pct', 'disk_util_pct',
    'node_cpu', 'postgres_cpu', 'redis_cpu',
    'node_rss_mb', 'postgres_rss_mb',
  ];
  const avg = (k) => samples.reduce((s, r) => s + Number(r[k]), 0) / samples.length;
  const max = (k) => Math.max(...samples.map((r) => Number(r[k])));

  console.log('========== WSL 资源采样摘要 ==========');
  console.log(`样本数: ${samples.length}  文件: ${outCsv}`);
  console.log('指标              avg      max');
  for (const k of keys) {
    console.log(`${k.padEnd(16)} ${avg(k).toFixed(1).padStart(7)} ${max(k).toFixed(1).padStart(7)}`);
  }
  console.log('======================================');
  console.log('解读:');
  console.log('  cpu_idle 长期 <20%      → CPU 打满');
  console.log('  cpu_iowait 经常 >10%    → 磁盘忙，PG 同机抢 IO');
  console.log('  postgres_cpu ≈ node_cpu → 库与应用争用，分机可能有收益');
  console.log('  postgres_cpu << node    → 瓶颈更偏 Node/业务逻辑');
  console.log('  redis_cpu 很低          → Redis 不是瓶颈');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const deadline = untilFile ? Infinity : Date.now() + durationSec * 1000;
  sampleOnce();
  while (Date.now() < deadline) {
    if (untilFile && existsSync(untilFile)) break;
    await sleep(intervalSec * 1000);
    if (untilFile && existsSync(untilFile)) break;
    sampleOnce();
  }
  summarize();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
