#!/usr/bin/env node
// Pošle výsledek běhu agenta conductorovi (Cloudflare Worker), podepsaný HMAC-SHA256.
//
// Použití v Actions (poslední krok):
//   node .forge/report.mjs success "co se povedlo" [pr_url]
//   node .forge/report.mjs failed  "co selhalo"
//
// Když FORGE_URL nebo FORGE_SECRET chybí, jen se to oznámí a běh to nezhodí –
// report není důležitější než samotná práce.

import { readFileSync, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const [status = 'failed', summary = '', prUrl = ''] = process.argv.slice(2);

const url = process.env.FORGE_URL;
const secret = process.env.FORGE_SECRET;
const runKey = process.env.FORGE_RUN_KEY;

if (!url || !secret || !runKey) {
  console.log('Report přeskočen: chybí FORGE_URL / FORGE_SECRET / FORGE_RUN_KEY');
  process.exit(0);
}

// Posledních pár řádků logu pomůže při ladění přímo z notifikace.
let logTail = '';
const logPath = join(HERE, '..', 'agent.log');
if (existsSync(logPath)) {
  logTail = readFileSync(logPath, 'utf8').split('\n').slice(-40).join('\n');
}

const body = JSON.stringify({
  run_key: runKey,
  status,
  summary: summary.slice(0, 800),
  pr_url: prUrl || undefined,
  log_tail: logTail,
});
const signature = createHmac('sha256', secret).update(body).digest('hex');

try {
  const res = await fetch(`${url.replace(/\/$/, '')}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forge-signature': signature },
    body,
  });
  console.log(`Report → ${res.status} ${await res.text()}`);
} catch (e) {
  console.log(`Report se nepodařilo odeslat: ${String(e)}`);
}
