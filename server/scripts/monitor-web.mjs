#!/usr/bin/env node
/**
 * 临时主机监控页（独立于工时系统，压测用完可停）。
 *
 *   node scripts/monitor-web.mjs
 *   → http://127.0.0.1:3099/
 *
 * 环境变量: MONITOR_PORT=3099
 *
 * 展示：CPU 仅负载(load)；内存、磁盘分开统计。
 */
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const PORT = Number(process.env.MONITOR_PORT || 3099);

function sh(cmd) {
  try {
    return execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', timeout: 8000 });
  } catch {
    return '';
  }
}

function parseLoad() {
  const parts = sh('cat /proc/loadavg').trim().split(/\s+/);
  const cores = Number(sh('nproc').trim()) || 1;
  return {
    load1: Number(parts[0]) || 0,
    load5: Number(parts[1]) || 0,
    load15: Number(parts[2]) || 0,
    cores,
  };
}

function parseMem() {
  const raw = sh('cat /proc/meminfo');
  const get = (k) => {
    const m = raw.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  const totalKb = get('MemTotal');
  const availKb = get('MemAvailable') || get('MemFree');
  const usedKb = Math.max(0, totalKb - availKb);
  return {
    usedPct: totalKb ? (usedKb / totalKb) * 100 : 0,
    usedMb: usedKb / 1024,
    availableMb: availKb / 1024,
    totalMb: totalKb / 1024,
  };
}

function parseDisk() {
  // util%
  const util = Number(
    sh("iostat -dx 1 1 2>/dev/null | awk 'NR>3 && NF>1 {u=$NF+0; if(u>m)m=u} END{print m+0}'").trim(),
  ) || 0;
  // 根分区用量
  const df = sh("df -P -B1 / 2>/dev/null | awk 'NR==2 {print $2,$3,$4,$5}'").trim().split(/\s+/);
  const total = Number(df[0]) || 0;
  const used = Number(df[1]) || 0;
  const avail = Number(df[2]) || 0;
  const usedPct = total ? (used / total) * 100 : (Number(String(df[3] || '').replace('%', '')) || 0);
  return {
    utilPct: util,
    usedPct,
    usedGb: used / (1024 ** 3),
    availGb: avail / (1024 ** 3),
    totalGb: total / (1024 ** 3),
  };
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
  return { cpu, rssMb: rssKb / 1024, pids: pids.length };
}

function collect() {
  const load = parseLoad();
  const mem = parseMem();
  const disk = parseDisk();
  const processes = {
    node: parseProcGroup('dist/app\\.js|lb-round-robin|monitor-web'),
    postgres: parseProcGroup('postgres'),
    redis: parseProcGroup('redis-server'),
  };

  let hint = '资源较空闲或负载中等';
  if (load.load1 >= load.cores * 0.9) hint = `负载偏高（load1=${load.load1.toFixed(2)} / ${load.cores}核）：CPU 接近打满`;
  else if (disk.utilPct >= 10) hint = '磁盘 util 偏高：同机 IO 争用，分机可能有收益';
  else if (mem.usedPct >= 85) hint = '内存占用偏高，留意 OOM / 换页';
  else if (processes.postgres.cpu > 5 && processes.postgres.cpu >= processes.node.cpu * 0.7) {
    hint = 'Postgres 与 Node CPU 接近：库与应用争用';
  } else if (processes.node.cpu > 30 && processes.postgres.cpu < processes.node.cpu * 0.4) {
    hint = 'Node CPU 明显高于 Postgres：瓶颈更偏业务逻辑';
  } else if (processes.redis.cpu < 1) hint = 'Redis CPU 很低：不是当前瓶颈';

  return {
    ts: new Date().toISOString(),
    load,
    mem,
    disk,
    processes,
    hint,
  };
}

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WSL 主机监控（临时）</title>
<style>
  :root { --bg:#f7f4ef; --card:#fffdf9; --text:#2c2418; --muted:#7a6f60; --accent:#6b8f71; --warn:#c0564b; --line:#e8e0d4; --blue:#4a6fa5; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: "Segoe UI", system-ui, sans-serif; background:var(--bg); color:var(--text); }
  header { padding:16px 20px; display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid var(--line); background:var(--card); }
  h1 { margin:0; font-size:18px; font-weight:650; }
  .sub { color:var(--muted); font-size:12px; margin-top:4px; }
  .controls { display:flex; gap:8px; align-items:center; }
  button, select { border:1px solid var(--line); background:#fff; border-radius:8px; padding:6px 10px; cursor:pointer; color:var(--text); }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  main { padding:16px 20px 28px; max-width:1200px; margin:0 auto; }
  .hint { margin:0 0 14px; padding:10px 12px; background:var(--card); border:1px solid var(--line); border-radius:10px; font-size:13px; }
  .section { margin-bottom:16px; }
  .section h2 { margin:0 0 10px; font-size:14px; font-weight:650; color:var(--muted); }
  .grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin-bottom:10px; }
  .grid4 { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-bottom:10px; }
  @media (max-width:900px){ .grid,.grid4 { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; }
  .label { font-size:12px; color:var(--muted); }
  .value { font-size:22px; font-weight:650; margin-top:4px; }
  .unit { font-size:12px; font-weight:400; color:var(--muted); margin-left:4px; }
  .bar { height:6px; background:var(--line); border-radius:99px; margin-top:8px; overflow:hidden; }
  .bar > i { display:block; height:100%; background:var(--accent); }
  .bar.warn > i { background:var(--warn); }
  .charts { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  @media (max-width:900px){ .charts { grid-template-columns:1fr; } }
  canvas { width:100%; height:220px; display:block; background:#fff; border-radius:8px; border:1px solid var(--line); }
  .chart-title { font-size:13px; margin:0 0 8px; font-weight:600; }
  .legend { font-size:11px; color:var(--muted); margin-top:6px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>WSL 主机监控</h1>
    <div class="sub">CPU 只看负载 · 内存 / 磁盘分开 · 临时压测工具</div>
  </div>
  <div class="controls">
    <label><input type="checkbox" id="live" checked /> 实时</label>
    <select id="interval">
      <option value="1000">1s</option>
      <option value="2000">2s</option>
    </select>
    <button class="primary" id="refresh">立即刷新</button>
  </div>
</header>
<main>
  <div class="hint" id="hint">加载中…</div>

  <div class="section">
    <h2>CPU 负载</h2>
    <div class="grid" id="loadCards"></div>
    <div class="card"><div class="chart-title">Load Average</div><canvas id="cLoad" width="1200" height="220"></canvas>
      <div class="legend"><span class="dot" style="background:#6b8f71"></span>1m &nbsp; <span class="dot" style="background:#4a6fa5"></span>5m &nbsp; <span class="dot" style="background:#c0564b"></span>15m</div>
    </div>
  </div>

  <div class="section">
    <h2>内存</h2>
    <div class="grid" id="memCards"></div>
    <div class="card"><div class="chart-title">内存占用 %</div><canvas id="cMem" width="1200" height="220"></canvas></div>
  </div>

  <div class="section">
    <h2>磁盘</h2>
    <div class="grid" id="diskCards"></div>
    <div class="card"><div class="chart-title">磁盘 util% / 根分区占用%</div><canvas id="cDisk" width="1200" height="220"></canvas>
      <div class="legend"><span class="dot" style="background:#c0564b"></span>iostat util% &nbsp; <span class="dot" style="background:#8b7355"></span>根分区 used%</div>
    </div>
  </div>

  <div class="section">
    <h2>进程（参考）</h2>
    <div class="grid4" id="procCards"></div>
    <div class="card"><div class="chart-title">进程 CPU%</div><canvas id="cProc" width="1200" height="220"></canvas>
      <div class="legend"><span class="dot" style="background:#6b8f71"></span>Node &nbsp; <span class="dot" style="background:#4a6fa5"></span>Postgres &nbsp; <span class="dot" style="background:#c0564b"></span>Redis</div>
    </div>
  </div>
</main>
<script>
const MAX = 120;
const history = [];
let timer = null;

function card(title, value, unit, pct, warn) {
  const w = warn ? ' warn' : '';
  const p = pct == null ? '' : \`<div class="bar\${w}"><i style="width:\${Math.min(100,Math.max(0,pct))}%"></i></div>\`;
  return \`<div class="card"><div class="label">\${title}</div><div class="value">\${value}<span class="unit">\${unit||''}</span></div>\${p}</div>\`;
}

function draw(canvas, series, colors, maxY) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle = '#e8e0d4'; ctx.lineWidth = 1;
  for (let i=0;i<=4;i++){ const y=h*i/4; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  if (!history.length) return;
  const n = history.length;
  const ymax = maxY || Math.max(1, ...series.flatMap(s => history.map(p => p[s] || 0)));
  series.forEach((key, si) => {
    ctx.strokeStyle = colors[si]; ctx.lineWidth = 2; ctx.beginPath();
    history.forEach((p, i) => {
      const x = n===1 ? w/2 : (i/(n-1))*w;
      const y = h - (Math.min(ymax, p[key] || 0)/ymax)*h;
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
  });
}

function render(d) {
  document.getElementById('hint').textContent = d.hint + ' · ' + new Date(d.ts).toLocaleTimeString();
  const cores = d.load.cores || 1;
  const loadWarn = d.load.load1 >= cores * 0.9;

  document.getElementById('loadCards').innerHTML = [
    card('Load 1m', d.load.load1.toFixed(2), \`/ \${cores} 核\`, (d.load.load1/cores)*100, loadWarn),
    card('Load 5m', d.load.load5.toFixed(2), \`/ \${cores} 核\`, (d.load.load5/cores)*100),
    card('Load 15m', d.load.load15.toFixed(2), \`/ \${cores} 核\`, (d.load.load15/cores)*100),
  ].join('');

  document.getElementById('memCards').innerHTML = [
    card('已用', d.mem.usedMb.toFixed(0), 'MB', d.mem.usedPct, d.mem.usedPct>=85),
    card('可用', d.mem.availableMb.toFixed(0), 'MB'),
    card('总量', d.mem.totalMb.toFixed(0), \`MB · \${d.mem.usedPct.toFixed(1)}%\`, d.mem.usedPct),
  ].join('');

  document.getElementById('diskCards').innerHTML = [
    card('IO util', d.disk.utilPct.toFixed(1), '%', d.disk.utilPct, d.disk.utilPct>=10),
    card('根分区已用', d.disk.usedGb.toFixed(1), \`GB · \${d.disk.usedPct.toFixed(1)}%\`, d.disk.usedPct, d.disk.usedPct>=85),
    card('根分区可用', d.disk.availGb.toFixed(1), \`GB / 共 \${d.disk.totalGb.toFixed(1)}GB\`),
  ].join('');

  document.getElementById('procCards').innerHTML = [
    card(\`Node (\${d.processes.node.pids})\`, d.processes.node.cpu.toFixed(1), \`% · RSS \${d.processes.node.rssMb.toFixed(0)}MB\`, Math.min(100,d.processes.node.cpu)),
    card(\`Postgres (\${d.processes.postgres.pids})\`, d.processes.postgres.cpu.toFixed(1), \`% · RSS \${d.processes.postgres.rssMb.toFixed(0)}MB\`, Math.min(100,d.processes.postgres.cpu)),
    card(\`Redis (\${d.processes.redis.pids})\`, d.processes.redis.cpu.toFixed(1), \`% · RSS \${d.processes.redis.rssMb.toFixed(0)}MB\`, Math.min(100,d.processes.redis.cpu)),
  ].join('');

  history.push({
    load1: d.load.load1, load5: d.load.load5, load15: d.load.load15,
    mem: d.mem.usedPct,
    diskUtil: d.disk.utilPct, diskUsed: d.disk.usedPct,
    node: d.processes.node.cpu, pg: d.processes.postgres.cpu, redis: d.processes.redis.cpu,
  });
  if (history.length > MAX) history.shift();

  const loadMax = Math.max(cores, ...history.map(p => Math.max(p.load1, p.load5, p.load15)));
  draw(document.getElementById('cLoad'), ['load1','load5','load15'], ['#6b8f71','#4a6fa5','#c0564b'], loadMax);
  draw(document.getElementById('cMem'), ['mem'], ['#8b7355'], 100);
  draw(document.getElementById('cDisk'), ['diskUtil','diskUsed'], ['#c0564b','#8b7355'], 100);
  draw(document.getElementById('cProc'), ['node','pg','redis'], ['#6b8f71','#4a6fa5','#c0564b']);
}

async function pull() {
  const res = await fetch('/api/snapshot');
  const d = await res.json();
  render(d);
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = null;
  if (!document.getElementById('live').checked) return;
  const ms = Number(document.getElementById('interval').value) || 1000;
  timer = setInterval(pull, ms);
}

document.getElementById('refresh').onclick = pull;
document.getElementById('live').onchange = schedule;
document.getElementById('interval').onchange = schedule;
pull().then(schedule);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/api/snapshot') {
    const data = collect();
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(data));
    return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[monitor-web] http://127.0.0.1:${PORT}/`);
  console.log('[monitor-web] 临时服务，Ctrl+C 结束');
});
