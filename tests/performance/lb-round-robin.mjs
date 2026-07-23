#!/usr/bin/env node
/**
 * 简易轮询反向代理，用于多实例压测入口。
 *
 * 用法:
 *   LB_PORT=3001 BACKENDS=127.0.0.1:3011,127.0.0.1:3012,127.0.0.1:3013 \
 *     node tests/performance/lb-round-robin.mjs
 */
import http from 'node:http';
import net from 'node:net';

const LB_PORT = Number(process.env.LB_PORT || 3001);
const BACKENDS = (process.env.BACKENDS || '127.0.0.1:3011,127.0.0.1:3012,127.0.0.1:3013')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [host, port] = s.split(':');
    return { host, port: Number(port) };
  });

if (!BACKENDS.length) {
  console.error('BACKENDS 为空');
  process.exit(1);
}

let rr = 0;
const counts = BACKENDS.map(() => 0);

const server = http.createServer((req, res) => {
  const i = rr++ % BACKENDS.length;
  const b = BACKENDS[i];
  counts[i] += 1;

  const proxy = http.request(
    {
      host: b.host,
      port: b.port,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: req.headers.host || `${b.host}:${b.port}`,
        'x-forwarded-for': req.socket.remoteAddress || '',
        'x-forwarded-proto': 'http',
      },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  proxy.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 502, message: `upstream ${b.host}:${b.port} 不可用: ${err.message}` }));
  });
  req.pipe(proxy);
});

server.on('upgrade', (req, socket, head) => {
  const i = rr++ % BACKENDS.length;
  const b = BACKENDS[i];
  const up = net.connect(b.port, b.host, () => {
    up.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
        Object.entries(req.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') +
        '\r\n',
    );
    if (head?.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(LB_PORT, () => {
  console.log(`[lb] http://127.0.0.1:${LB_PORT} → ${BACKENDS.map((b) => `${b.host}:${b.port}`).join(', ')}`);
});

setInterval(() => {
  console.log(`[lb] routed ${counts.map((c, i) => `${BACKENDS[i].port}=${c}`).join(' ')}`);
}, 10000);
