#!/usr/bin/env node
// Lokální ZKUŠEBNÍ conductor – stejné endpointy jako Cloudflare Worker, ale stav
// drží v paměti. Slouží k ověření workera a protokolu bez Cloudflare a bez D1.
//
// NENÍ to náhrada conductora: po restartu zapomene všechno a neumí spouštět
// GitHub Actions. Na vývoj a testy ale stačí (a je to nejrychlejší cesta, jak
// zjistit, že worker dělá, co má).
//
// Spuštění:
//   node tools/mock-conductor.mjs              (port 8787)
//   PORT=9000 MOCK_SECRET=tajemstvi node tools/mock-conductor.mjs

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.MOCK_SECRET || 'test-secret';

const tasks = [];
const runs = [];
const workers = new Map();
let nextTask = 1;
let nextRun = 1;

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function send(res, code, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function auth(req) {
  return (req.headers['x-forge-secret'] || '') === SECRET;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  const workerName = req.headers['x-forge-worker'] || '';

  if (path === '/' || path === '/index') {
    return send(res, 200, {
      service: 'mock-conductor (jen pro testy)',
      endpoints: ['/health', '/queue', '/status', '/workers', '/task', '/claim', '/heartbeat', '/report'],
    });
  }

  if (path === '/health') {
    return send(res, 200, {
      ok: true, mock: true, time: now(),
      ready: tasks.filter((t) => t.status === 'ready').length,
      running: runs.filter((r) => r.status === 'running').length,
      workers: [...workers.values()],
    });
  }

  if (!auth(req)) return send(res, 401, { error: 'bad secret' });

  if (path === '/task' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.title || !b.prompt) return send(res, 400, { error: 'chybi title nebo prompt' });
    const t = {
      id: nextTask++, title: b.title, kind: b.kind || 'code',
      target: b.target === 'lan' ? 'lan' : 'cloud',
      prompt: b.prompt, payload: b.payload ? JSON.stringify(b.payload) : null,
      status: 'ready', attempts: 0, created_at: now(),
    };
    tasks.push(t);
    console.log(`[mock] nový úkol #${t.id} (${t.kind}, ${t.target}): ${t.title}`);
    return send(res, 200, { ok: true, id: t.id, target: t.target });
  }

  if (path === '/queue') return send(res, 200, { tasks });
  if (path === '/workers') return send(res, 200, { workers: [...workers.values()] });
  if (path === '/status') {
    return send(res, 200, {
      runs: runs.map((r) => ({ ...r, title: tasks.find((t) => t.id === r.task_id)?.title })),
    });
  }

  if (path === '/heartbeat' && req.method === 'POST') {
    if (!workerName) return send(res, 400, { error: 'chybi x-forge-worker' });
    const b = await readBody(req);
    const prev = workers.get(workerName) || { name: workerName, jobs_done: 0, jobs_failed: 0 };
    workers.set(workerName, {
      ...prev, kinds: (b.kinds || []).join(','), info: JSON.stringify(b.info),
      platform: b.platform, last_seen: now(),
    });
    return send(res, 200, { ok: true, name: workerName });
  }

  if (path === '/claim' && req.method === 'POST') {
    if (!workerName) return send(res, 400, { error: 'chybi x-forge-worker' });
    const b = await readBody(req);
    const kinds = b.kinds && b.kinds.length ? b.kinds : ['test'];
    const task = tasks.find((t) => t.status === 'ready' && t.target === 'lan' && kinds.includes(t.kind));
    if (!task) return send(res, 200, { task: null });
    task.status = 'running';
    task.attempts += 1;
    const runKey = `mock-${nextRun++}`;
    runs.push({ id: nextRun, task_id: task.id, run_key: runKey, worker: workerName,
                status: 'running', started_at: now(), summary: null, pr_url: null });
    console.log(`[mock] úkol #${task.id} si vzal ${workerName} (run ${runKey})`);
    return send(res, 200, { task, run_key: runKey });
  }

  if (path === '/report' && req.method === 'POST') {
    const b = await readBody(req);
    const run = runs.find((r) => r.run_key === b.run_key);
    if (!run) return send(res, 404, { error: 'neznamy run_key' });
    run.status = b.status;
    run.finished_at = now();
    run.summary = b.summary;
    run.log_tail = (b.log_tail || '').slice(0, 8000);
    run.artifacts = b.artifacts || [];
    const task = tasks.find((t) => t.id === run.task_id);
    if (task) task.status = b.status === 'success' ? 'done' : 'ready';
    const w = workers.get(run.worker);
    if (w) w[b.status === 'success' ? 'jobs_done' : 'jobs_failed'] += 1;
    console.log(`[mock] report ${b.run_key}: ${b.status} – ${b.summary}`);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: `neznámá cesta ${path}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] conductor poslouchá na http://127.0.0.1:${PORT} (tajemství: ${SECRET})`);
});
