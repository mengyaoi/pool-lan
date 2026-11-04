/**
 * dev/serve.mjs — 本地跑与 Vercel 完全相同的函数（api/ws.mjs）+ 静态文件。
 * 用途：部署前先在本机验证联机逻辑，避免把错误推上线。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;

const { default: wsHandler } = await import('../api/ws.mjs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health' || url.pathname === '/api/ws') {
    wsHandler.emit('request', req, res);
    return;
  }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(ROOT, decodeURIComponent(rel)));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// 把 WebSocket upgrade 转发给函数内部的 server
server.on('upgrade', (req, socket, head) => {
  wsHandler.emit('upgrade', req, socket, head);
});

server.listen(PORT, () => console.log('dev server on http://127.0.0.1:' + PORT));