#!/usr/bin/env node
// Pull-worker pro domácí uzel orchestra (telefon s Termuxem, PC, cokoli s Node).
//
// JAK TO FUNGUJE: worker se sám periodicky ptá conductora, jestli není práce pro
// jeho druh úkolů (POST /claim). Když dostane úkol, vykoná jeho kroky a výsledek
// hlásí zpět (POST /report). Mezi tím posílá heartbeat.
//
// PROČ PULL A NE PUSH:
//   • telefon je za NAT bez veřejné adresy – nemusíme otevírat porty ani tunel,
//   • nehrozí riziko self-hosted runneru: GitHub výslovně varuje, že runner
//     u VEŘEJNÉHO repa může přes fork PR spustit cizí kód na tvém zařízení,
//   • stejný skript funguje na telefonu (Termux) i na PC (Windows/Linux).
//
// VÝSTUP KROKŮ JDE DO SOUBORU, NE DO ROURY. Není to detail: roura (pipe) je
// v některých sandboxech zakázaná (spawn EPERM) a zároveň se ztrácí historie.
// Se souborem je vidět celý průběh i po pádu a poslední řádky jdou do reportu.
//
// BEZPEČNOST: kdo zná FORGE_SECRET, může přes frontu spustit příkazy na tomto
// uzlu (krok `shell:`). Tajemství proto patří jen do prostředí (nebo do .env
// s právy 600), nikdy do repa.
//
// NASTAVENÍ (prostředí nebo soubor .env vedle skriptu):
//   FORGE_URL      adresa conductora (https://…workers.dev nebo http://127.0.0.1:8787)
//   FORGE_SECRET   stejné tajemství jako WEBHOOK_SECRET v Cloudflare
//   FORGE_WORKER   název uzlu (např. "redmi-note8")
//   FORGE_KINDS    co uzel umí, čárkou (např. "test,build,assets")
//   FORGE_GODOT    cesta ke Godotu (nepovinné; jinak se hledá v PATH)
//   FORGE_CMD      cesta k lokální pipeline forge.cmd (krok `forge:`; jen na PC)
//   FORGE_WORKDIR  kam klonovat repo (výchozí ~/forge/work)
//   FORGE_WINDOW   okno práce "HH:MM-HH:MM" (např. "19:00-23:00"; prázdné = pořád)
//   FORGE_NO_SHELL=1  přeskočit kroky `shell:` bez ptaní (bezobslužný běh)
//   FORGE_ONCE=1   jeden cyklus a konec (totéž jako --once)
//
// SOUHLAS (consent): kroky `shell:` (libovolný příkaz) se vždy zeptají y/N
// v konzoli; deterministické kroky (godot-*, python, forge:*, make-dir) běží
// bez ptaní. Druhy úkolů se filtrují přes FORGE_KINDS. Bezobslužný běh
// (Task Scheduler) by měl běžet s --no-shell.
//
// SPUŠTĚNÍ:
//   node worker.mjs             smyčka (v Termuxu pod Termux:Boot)
//   node worker.mjs --once      jeden cyklus a konec (na test)
//   node worker.mjs --info      vypíše, co uzel umí (bez připojení k serveru)

import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, openSync, closeSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir, platform, arch, release } from 'node:os';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';

// ------------------------------------------------------------------ config ----
function loadEnv() {
  const f = join(HERE, '.env');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0 && !process.env[t.slice(0, i)]) process.env[t.slice(0, i)] = t.slice(i + 1).trim();
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

loadEnv();

const URL_BASE = (process.env.FORGE_URL || '').replace(/\/$/, '');
const SECRET = process.env.FORGE_SECRET || '';
const WORKER = process.env.FORGE_WORKER || `uzel-${arch()}`;
const KINDS = (process.env.FORGE_KINDS || 'test').split(',').map((s) => s.trim()).filter(Boolean);
const WORKDIR = process.env.FORGE_WORKDIR || join(homedir(), 'forge', 'work');
const LOGDIR = join(WORKDIR, '..', 'logs');
const GODOT = process.env.FORGE_GODOT || 'godot';
// Lokální pipeline forge.cmd (GPU assety, plánování přes Ollama) – jen na PC.
// Defaultní cesta sedí, když worker běží z orchestra template; v herním repu
// nastav FORGE_CMD ručně.
const FORGE_CMD = process.env.FORGE_CMD || join(HERE, '..', '..', '..', '..', 'forge.cmd');
// Souhlas: kroky `shell:` (libovolný příkaz) se vždy ZEPTAJÍ interaktivně (y/N).
// --no-shell je pro bezobslužný běh (Task Scheduler): shell kroky se přeskočí,
// nikdy se nespustí potichu.
const NO_SHELL = process.argv.includes('--no-shell') || process.env.FORGE_NO_SHELL === '1';
// Okno, ve kterém worker smí claimovat ("HH:MM-HH:MM"). Prázdné = bez omezení.
const WINDOW = process.env.FORGE_WINDOW || '';
const ONCE = process.argv.includes('--once') || process.env.FORGE_ONCE === '1';
const INTERVAL = Number(arg('--interval', '120'));

// Pracovní adresáře se musí vytvořit HNED: toolVersions()/have() běží s cwd=WORKDIR
// a dokud adresář neexistoval, spawn padal na ENOENT a nástroje hlásily null
// (naměřeno: --info na čerstvém stroji ukazovalo všechny nástroje null).
mkdirSync(WORKDIR, { recursive: true });
mkdirSync(LOGDIR, { recursive: true });

// --------------------------------------------------------------- nástroje ----
function have(cmd) {
  const probe = IS_WIN ? `where ${cmd}` : `command -v ${cmd}`;
  const tmp = join(LOGDIR, 'have.log');
  const r = runCmd(probe, WORKDIR, tmp, 15000);
  return r.code === 0;
}

function toolVersions() {
  // Verze zjišťujeme přes soubor, ne přes rouru – roura je v některých
  // sandboxech zakázaná (spawn EPERM) a chyba by se tiše schovala.
  const out = {};
  const tmp = join(LOGDIR, 'tools.log');
  const probe = (label, cmd) => {
    const before = existsSync(tmp) ? readFileSync(tmp, 'utf8').length : 0;
    const r = runCmd(cmd, WORKDIR, tmp, 30000);
    out[label] = r.code === 0
      ? readFileSync(tmp, 'utf8').slice(before).trim().split('\n')[0].slice(0, 80)
      : null;
  };
  probe('godot', `${quote(GODOT)} --headless --version`);
  probe('python', IS_WIN ? 'python --version' : 'python3 --version');
  probe('node', 'node --version');
  probe('git', 'git --version');
  return out;
}

function quote(p) {
  return String(p).includes(' ') ? `"${p}"` : String(p);
}

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function ask(otazka) {
  // Interaktivní potvrzení v konzoli (y/N). Uživatel u počítače odpoví jedním písmenem.
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(otazka, (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
  });
}

function vOkne() {
  // FORGE_WINDOW = "HH:MM-HH:MM" – worker claimuje jen v tomhle okně
  // (i přes půlnoc, např. 22:00-02:00). Prázdné = bez omezení.
  if (!WINDOW) return true;
  const m = WINDOW.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return true;
  const min = new Date().getHours() * 60 + new Date().getMinutes();
  const a = Number(m[1]) * 60 + Number(m[2]);
  const b = Number(m[3]) * 60 + Number(m[4]);
  return a <= b ? (min >= a && min <= b) : (min >= a || min <= b);
}

// ------------------------------------------------------------------- API ----
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'x-forge-secret': SECRET, 'x-forge-worker': WORKER };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${URL_BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${String(text).slice(0, 200)}`);
  return data;
}

// ------------------------------------------------------------ spouštění ----
// Výstup jde do souboru (fd) – nikoli do roury. Na Windows i v Termuxu stejné.
function runCmd(cmd, cwd, logPath, timeout = 3600000) {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  try {
    const r = spawnSync(cmd, {
      cwd, shell: true, stdio: ['ignore', fd, fd], timeout, windowsHide: true,
    });
    return { code: r.status, signal: r.signal, error: r.error ? String(r.error) : null };
  } finally {
    closeSync(fd);
  }
}

// Spuštění programu BEZ shellu (žádné cmd/sh) – používají to git operace.
// Důvod: Git pro Windows si u některých operací volá Cygwin `sh`, který
// v omezených prostředích padá na "couldn't create signal pipe". Přímé volání
// programu shell vůbec nepotřebuje.
function runArgv(file, args, cwd, logPath, timeout = 900000) {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  try {
    const r = spawnSync(file, args, {
      cwd, stdio: ['ignore', fd, fd], timeout, windowsHide: true,
    });
    return { code: r.status, signal: r.signal, error: r.error ? String(r.error) : null };
  } finally {
    closeSync(fd);
  }
}

function logTail(logPath, lines = 25) {  if (!existsSync(logPath)) return '';
  const text = readFileSync(logPath, 'utf8');
  return text.split('\n').slice(-lines).join('\n').slice(-4000);
}

// Co který krok znamená. Držíme krátký a uzavřený seznam – co v něm není,
// se odmítne, aby se z fronty nedalo spustit cokoli.
function stepCommand(step) {
  const [kind, ...rest] = step.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'shell':
      return arg;
    case 'godot-import':
      return `${quote(GODOT)} --headless --path . --import`;
    case 'godot-test':
      return `${quote(GODOT)} --headless --path . --script res://tests/run_tests.gd`;
    case 'godot-export': {
      // tvar: godot-export:Windows Desktop:build/windows/hra.exe
      const preset = rest[0];
      const out = rest.slice(1).join(':');
      if (!preset || !out) throw new Error('godot-export potřebuje předpis i cestu');
      return `${quote(GODOT)} --headless --path . --export-release "${preset}" "${out}"`;
    }
    case 'python':
      return `${IS_WIN ? 'python' : 'python3'} ${arg}`;
    case 'forge':
      // Lokální pipeline (GPU assety, plánování přes Ollama) – jen na PC.
      return `${quote(FORGE_CMD)} ${arg}`;
    default:
      throw new Error(`Neznámý krok '${kind}'. Povolené: shell, godot-import, godot-test, `
                      + 'godot-export, python, forge, make-dir');
  }
}

function collectArtifacts(repoDir, rel) {
  const dir = join(repoDir, rel);
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d, depth = 0) => {
    if (depth > 3) return;
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, depth + 1);
      else out.push({ file: full.slice(repoDir.length + 1), bytes: st.size });
    }
  };
  walk(dir);
  return out.slice(0, 50);
}

// ------------------------------------------------------------- vykonání ----
async function execute(task, runKey) {
  const payload = task.payload ? JSON.parse(task.payload) : {};
  const steps = payload.steps || [];
  const repoDir = join(WORKDIR, payload.name || 'repo');
  const logPath = join(LOGDIR, `${runKey}.log`);
  const artifacts = () => (payload.artifacts ? collectArtifacts(repoDir, payload.artifacts) : []);

  mkdirSync(WORKDIR, { recursive: true });
  mkdirSync(LOGDIR, { recursive: true });

  const results = [];
  const fail = (step, tail) => ({ status: 'failed', summary: `Krok '${step}' selhal`,
                                  results, artifacts: artifacts(), log: logPath });

  // 1) repozitář
  if (payload.repo) {
    const ref = payload.ref || 'main';
    const gitAuth = payload.token
      ? payload.repo.replace('https://', `https://x-access-token:${payload.token}@`)
      : payload.repo;
    let r;
    if (existsSync(join(repoDir, '.git'))) {
      r = runArgv('git', ['fetch', '--depth', '1', 'origin', ref], repoDir, logPath, 600000);
      if (!r.error && r.code === 0) {
        r = runArgv('git', ['checkout', '-f', 'FETCH_HEAD'], repoDir, logPath, 300000);
      }
    } else {
      r = runArgv('git', ['clone', '--depth', '1', '--branch', ref, gitAuth, repoDir],
                  WORKDIR, logPath, 900000);
    }
    results.push({ step: 'git', ok: !r.error && r.code === 0,
                   seconds: '0', tail: logTail(logPath, 6) });
    if (r.error || r.code !== 0) return fail('git', logTail(logPath));
  }

  // 2) kroky
  for (const step of steps) {
    const t0 = Date.now();
    try {
      if (step.startsWith('make-dir:')) {
        mkdirSync(join(repoDir, step.slice('make-dir:'.length)), { recursive: true });
        results.push({ step, ok: true, seconds: '0.0', tail: 'vytvořeno' });
        continue;
      }
      const cmd = stepCommand(step);
      // Souhlas: krok `shell:` (libovolný příkaz) se VŽDY zeptá interaktivně.
      // --no-shell ho přeskočí (bezobslužný běh); nikdy se nespustí potichu.
      if (step.startsWith('shell:')) {
        if (NO_SHELL) {
          results.push({ step, ok: false, seconds: '0.0', tail: 'shell přeskočen (--no-shell)' });
          return fail(step, 'shell přeskočen (--no-shell)');
        }
        const odp = await ask(`Spustit shell: ${cmd}\n  [y/N] `);
        if (odp !== 'y' && odp !== 'yes') {
          results.push({ step, ok: false, seconds: '0.0', tail: 'odmítnuto uživatelem' });
          return fail(step, 'odmítnuto uživatelem');
        }
      }
      const r = runCmd(cmd, repoDir, logPath);
      const ok = !r.error && r.code === 0;
      results.push({
        step, ok, seconds: ((Date.now() - t0) / 1000).toFixed(1),
        tail: logTail(logPath, 20),
      });
      if (!ok) return fail(step, logTail(logPath));
    } catch (e) {
      results.push({ step, ok: false, seconds: ((Date.now() - t0) / 1000).toFixed(1),
                     tail: String(e).slice(0, 500) });
      return fail(step, String(e));
    }
  }

  return { status: 'success', summary: `Hotovo: ${steps.length} kroků`,
           results, artifacts: artifacts(), log: logPath };
}

// ----------------------------------------------------------------- smyčka ----
async function cycle() {
  if (!vOkne()) {
    log(`mimo okno (${WINDOW}) – čekám`);
    return false;
  }
  await api('/heartbeat', {
    method: 'POST',
    body: { kinds: KINDS, info: toolVersions(), platform: `${platform()} ${arch()} ${release()}` },
  });

  const claim = await api('/claim', { method: 'POST', body: { kinds: KINDS } });
  if (!claim.task) {
    log('žádná práce');
    return false;
  }
  const { task, run_key: runKey } = claim;
  log(`úkol #${task.id}: ${task.title} (${task.kind})`);

  let result;
  try {
    result = await execute(task, runKey);
  } catch (e) {
    result = { status: 'failed', summary: `Chyba workera: ${String(e).slice(0, 300)}`,
               results: [], artifacts: [] };
  }

  const tail = result.results
    .map((r) => `--- ${r.step} (${r.ok ? 'OK' : 'CHYBA'}, ${r.seconds}s)\n${r.tail || ''}`)
    .join('\n');

  await api('/report', {
    method: 'POST',
    body: {
      run_key: runKey,
      status: result.status,
      summary: `${WORKER}: ${result.summary}`,
      log_tail: tail,
      artifacts: result.artifacts,
    },
  });
  log(`report odeslán: ${result.status}${result.log ? ` (log: ${result.log})` : ''}`);
  return true;
}

// ------------------------------------------------------------------- main ----
if (process.argv.includes('--info')) {
  console.log(JSON.stringify({
    worker: WORKER,
    kinds: KINDS,
    workdir: WORKDIR,
    platform: `${platform()} ${arch()} ${release()}`,
    shell: IS_WIN ? 'cmd.exe' : '/bin/sh',
    forge_cmd: FORGE_CMD,
    no_shell: NO_SHELL,
    window: WINDOW || '(bez omezení)',
    tools: toolVersions(),
    nastroje: {
      godot: have(GODOT), python: have(IS_WIN ? 'python' : 'python3'),
      git: have('git'), node: have('node'),
    },
  }, null, 2));
  process.exit(0);
}

if (!URL_BASE || !SECRET) {
  console.error('Chybí FORGE_URL nebo FORGE_SECRET (prostředí nebo .env vedle skriptu).');
  console.error('Zjištění stavu uzlu:  node worker.mjs --info');
  process.exit(2);
}

log(`worker '${WORKER}' startuje: druhy=${KINDS.join(',')} server=${URL_BASE}`);
log(`nástroje: ${JSON.stringify(toolVersions())}`);

if (ONCE) {
  await cycle();
  process.exit(0);
}

for (;;) {
  try {
    await cycle();
  } catch (e) {
    log(`chyba cyklu: ${String(e).slice(0, 300)}`);
  }
  await new Promise((r) => setTimeout(r, INTERVAL * 1000));
}
