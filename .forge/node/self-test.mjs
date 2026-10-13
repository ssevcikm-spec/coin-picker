#!/usr/bin/env node
// Samoobslužný test uzlu: ověří, že worker umí převzít úkol a vykonat ho,
// a to BEZ cloudu – spustí si vlastní zkušební conductor (mock-conductor.mjs).
//
// K čemu to je: než uzel (telefon, PC) zapojíš do opravdového orchestra, můžeš
// si ověřit, že na něm worker vůbec běží. Nevyžaduje žádný účet ani klíč.
//
// Použití:
//   node self-test.mjs              projde celý test a uklidí po sobě
//   node self-test.mjs --keep       nechá testovací soubory k ladění
//
// POZNÁMKA: potomci se spouštět s stdio 'inherit' (ne rourou) – v omezených
// prostředích je roura zakázaná (spawn EPERM) a navíc je tak vidět celý výstup.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.SELF_TEST_PORT || '8788';
const SECRET = 'self-test';
const URL_BASE = `http://127.0.0.1:${PORT}`;
const WORKDIR = join(process.env.FORGE_SELFTEST_DIR || join(homedir(), 'forge'), 'selftest');
const KEEP = process.argv.includes('--keep');

function say(msg) {
  console.log(`\n=== ${msg} ===`);
}

function startMock() {
  return spawn(process.execPath, [join(HERE, 'mock-conductor.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, PORT, MOCK_SECRET: SECRET },
  });
}

function runOnce(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HERE, 'worker.mjs'), '--once'], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

async function waitForHealth(tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${URL_BASE}/health`);
      if (r.ok) return true;
    } catch { /* ještě neběží */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const api = (path, body) => fetch(`${URL_BASE}${path}`, {
  method: body ? 'POST' : 'GET',
  headers: { 'x-forge-secret': SECRET, 'x-forge-worker': 'self-test',
             ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());

// ------------------------------------------------------------------ test ----
say('1/4 Prostředí');
console.log('node:      ', process.version);
console.log('platforma: ', `${process.platform} ${process.arch}`);
console.log('workdir:   ', WORKDIR);
mkdirSync(WORKDIR, { recursive: true });

say('2/4 Spouštím zkušební conductor');
const mock = startMock();
if (!(await waitForHealth())) {
  console.error('CHYBA: zkušební conductor nenaběhl.');
  mock.kill();
  process.exit(1);
}
console.log('conductor odpovídá na', URL_BASE);

let ok = true;
try {
  say('3/4 Zakládám úkol a nechávám ho workera vykonat');
  await api('/task', {
    title: 'Samoobslužný test uzlu',
    kind: 'test',
    target: 'lan',
    prompt: 'Ověření, že uzel umí převzít a vykonat úkol (nedělá nic složitého).',
    payload: {
      name: 'selftest',
      // Krok 'make-dir' je schválně bez závislostí: kdyby test potřeboval git
      // nebo Godot, nešlo by odlišit "uzel je rozbitý" od "chybí nástroj".
      steps: ['make-dir:artifacts/selftest'],
    },
  });

  const env = {
    FORGE_URL: URL_BASE,
    FORGE_SECRET: SECRET,
    FORGE_WORKER: 'self-test',
    FORGE_KINDS: 'test',
    FORGE_WORKDIR: WORKDIR,
  };
  const code = await runOnce(env);

  say('4/4 Výsledek');
  const status = await api('/status');
  const run = (status.runs || [])[0];
  const workers = await api('/workers');
  const me = (workers.workers || [])[0];

  if (!run) {
    console.error('CHYBA: conductor nezaznamenal žádný běh.');
    ok = false;
  } else {
    console.log(`běh:   ${run.status}  (${run.summary || '-'})`);
    console.log(`uzel:  ${me ? `${me.name} | hotovo ${me.jobs_done} | chyb ${me.jobs_failed}` : '-'}`);
    const marker = join(WORKDIR, 'selftest', 'artifacts', 'selftest');
    console.log(`krok:  ${existsSync(marker) ? 'vytvořil složku artifacts/selftest' : 'složku nevytvořil!'}`);
    ok = run.status === 'success' && existsSync(marker) && code === 0;
  }
} catch (e) {
  console.error('CHYBA testu:', String(e));
  ok = false;
} finally {
  mock.kill();
  if (!KEEP) {
    // úklid necháváme na uživateli, jen o něm informujeme
    console.log(`\n(testovací soubory zůstaly v ${WORKDIR}; smaž je, až nebudeš potřebovat)`);
  }
}

console.log(ok
  ? '\nVÝSLEDEK: uzel funguje – umí si vyzvednout úkol a vykonat ho.'
  : '\nVÝSLEDEK: NĚCO NEFUNGOVALO (viz výpis výše).');
process.exit(ok ? 0 : 1);
