#!/usr/bin/env node
// OTUKANI POSKYTOVATELE: zmeri, co poskytovatel SKUTECNE unese.
//
// PROC TO EXISTUJE (namereno 12. 10. 2026): dnesni kontroly (pick-provider
// max_tokens=8, providers-check max_tokens=1) meri jen "odpovi na mrnavy
// dotaz?". Nase selhani je jine: odpovi na mrnavy dotaz a NAS skutecny request
// odmitne - v CI mel 25 065 / 27 557 / 39 167 tokenu proti stropu 8 000.
//
// Tenhle nastroj bere cisla z toho, co poskytovatel SAM vraci:
//   - hlavicky `x-ratelimit-limit-tokens` / `-remaining-` / `-reset-`
//   - telo chyby 413/429 ("Limit 8000, Requested 27557")
//   - `usage.prompt_tokens` (kolik si z naseho textu napocital)
// Diky tomu se da zmerit i UCETNICTVE (pocita se vstup, nebo i rezervovany
// vystup?) a STROP VSTUPU - bez hádání.
//
// Pouziti:
//   node .forge/node/probe-provider.mjs --jen groq --stdout
//   node .forge/node/probe-provider.mjs --out .forge/karta.json
//   node .forge/node/probe-provider.mjs --base http://127.0.0.1:8788/v1 --key test --model m --stdout
//
// POZOR: nikdy netiskne klice (jen odkud byly vzaty) a kazdy request se pocita
// do denni kvoty poskytovatele - proto `--bez-velkeho` na skromnych zdrojich.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HRA = process.env.FORGE_HRA || resolve(HERE, '..', '..');             // koren repa hry (.forge/node -> ..)
// Klice lokálně: v repu orchestry (`.secrets/<nazev>_key.txt`) nebo v prostředí.
// V CI jsou klice v Secrets, takže se sem chodí jen při ručním měření.
const ORCHESTRA = [process.env.FORGE_ORCHESTRA, resolve(HRA, '..', 'forge-orchestra'), resolve(HRA, '..')]
  .filter(Boolean)
  .find((p) => existsSync(join(p, '.secrets'))) || resolve(HRA, '..');

const arg = (name, dflt = '') => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

function keyFor(provider) {
  const env = process.env[provider.keyEnv];
  if (env) return { key: env, odkud: 'env' };
  for (const p of [join(ORCHESTRA, '.secrets', `${provider.name}_key.txt`),
    join(ORCHESTRA, '.secrets', `${provider.name}.txt`)]) {
    if (existsSync(p)) {
      const k = readFileSync(p, 'utf8').trim();
      if (k) return { key: k, odkud: p.replace(ORCHESTRA, '<orchestra>') };
    }
  }
  return { key: '', odkud: '' };
}

async function request(base, key, body, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://github.com/',
        'X-Title': 'forge-otukani',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const headers = {};
    for (const [k, v] of res.headers.entries()) {
      if (/^(x-ratelimit|retry-after|ratelimit)/i.test(k)) headers[k] = v;
    }
    return { status: res.status, ms: Date.now() - t0, headers, text };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, headers: {}, text: String(e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** Cisla z tela chyby - poskytovatel sam napise svuj limit i nasi velikost. */
export function cislaZChyby(text) {
  const out = {};
  const limit = text.match(/[Ll]imit\s+([\d\s.,]+)/);
  const requested = text.match(/Requested\s+([\d\s.,]+)/);
  if (limit) out.limit = Number(limit[1].replace(/[\s.,]/g, ''));
  if (requested) out.requested = Number(requested[1].replace(/[\s.,]/g, ''));
  if (/per minute \(TPM\)|Tokens per minute|TPM/i.test(text)) out.jednotka = 'TPM';
  else if (/per day|RPD|requests per day/i.test(text)) out.jednotka = 'RPD';
  return out;
}

export function usageZTextu(text) {
  try {
    const u = JSON.parse(text)?.usage;
    if (!u) return null;
    return { prompt: u.prompt_tokens ?? null, completion: u.completion_tokens ?? null, total: u.total_tokens ?? null };
  } catch {
    return null;
  }
}

const napln = (znaku) => 'x'.repeat(znaku);

/** Zmeri jednoho poskytovatele (jeden model) - vse ostatni je nad tim. */
export async function probeProvider({ name, baseUrl, key, model, velkyTest = true, timeoutMs = 60000 }) {
  const karta = {
    provider: name, model, base_url: baseUrl, key_present: Boolean(key),
    measured_at: new Date().toISOString(), kroky: {},
  };
  if (!key) { karta.chyba = 'chybi klic'; return karta; }

  // 1) KATALOG (zdarma, nespotrebovava kvotu na inference)
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${key}` } });
    karta.kroky.katalog = { status: r.status };
    if (r.ok) {
      const j = await r.json();
      const ids = (j?.data || j?.models || []).map((m) => (typeof m === 'string' ? m : m.id));
      karta.kroky.katalog.modelu = ids.length;
      karta.kroky.katalog.model_je_v_katalogu =
        ids.includes(model) || ids.includes(`models/${model}`) || ids.some((id) => String(id).endsWith(`/${model}`));
    }
  } catch (e) {
    karta.kroky.katalog = { status: 0, chyba: String(e).slice(0, 120) };
  }

  // 2) PING s malym vystupem - a hlavne hlavicky s limity
  const ping = await request(baseUrl, key, { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }, timeoutMs);
  karta.kroky.ping = {
    status: ping.status, ms: ping.ms, headers: ping.headers,
    usage: usageZTextu(ping.text), chyba_cisla: cislaZChyby(ping.text), ukazka: ping.text.slice(0, 200),
  };
  karta.merena_latence_ms = ping.ms;

  // 3) UCETNICTVE: stejny obsah, jiný max_tokens. Kdyz "requested"/remaining
  //    naroste o rezervu, uctuje se i vystup.
  const obsah = napln(4000);
  const ucet1 = await request(baseUrl, key, { model, messages: [{ role: 'user', content: obsah }], max_tokens: 1 }, timeoutMs);
  const ucet2 = await request(baseUrl, key, { model, messages: [{ role: 'user', content: obsah }], max_tokens: 4096 }, timeoutMs);
  const u1 = usageZTextu(ucet1.text);
  const u2 = usageZTextu(ucet2.text);
  karta.kroky.uctovani = {
    max1: { status: ucet1.status, usage: u1, chyba_cisla: cislaZChyby(ucet1.text), headers: ucet1.headers },
    max4096: { status: ucet2.status, usage: u2, chyba_cisla: cislaZChyby(ucet2.text), headers: ucet2.headers },
  };
  if (u1?.prompt != null) karta.znaku_na_token = Math.round((obsah.length / u1.prompt) * 100) / 100;
  if (ucet1.status === 200 && ucet2.status === 200) karta.uctovani_zaver = 'rozhoduje vstup (max_tokens nezmenil prijeti)';
  else if (ucet1.status === 200) karta.uctovani_zaver = 'uctuje i rezervovany vystup (vetsi max_tokens request odmitl)';
  else karta.uctovani_zaver = 'odmitnuto uz pri max_tokens=1 - viz chyba_cisla';

  // 4) STROP VSTUPU: zamerne velky request; z chyby se precte limit i to, kolik
  //    si poskytovatel z naseho textu napocital.
  if (velkyTest) {
    const velky = napln(80000);
    const r = await request(baseUrl, key, { model, messages: [{ role: 'user', content: velky }], max_tokens: 1 }, timeoutMs);
    karta.kroky.velky_test = {
      znaku: velky.length, status: r.status, chyba_cisla: cislaZChyby(r.text), ukazka: r.text.slice(0, 300),
    };
    if (r.status === 200) karta.mereny_strop_vstupu = `> ${Math.round(velky.length / 3.03)} tokenu (prosel)`;
    else if (karta.kroky.velky_test.chyba_cisla.limit) karta.mereny_strop_vstupu = karta.kroky.velky_test.chyba_cisla.limit;
  }
  return karta;
}

async function main() {
  const out = arg('--out', join(HRA, '.forge', 'karta-poskytovatele.json'));
  const jen = arg('--jen');
  const baseOverride = arg('--base');
  const keyOverride = arg('--key');
  const modelOverride = arg('--model');
  const velkyTest = !process.argv.includes('--bez-velkeho');

  let seznam;
  if (baseOverride) {
    const m = modelOverride || 'm';
    seznam = [{ name: jen || 'mock', baseUrl: baseOverride, key: keyOverride, models: [m] }];
  } else {
    const cfg = JSON.parse(readFileSync(join(HRA, '.forge', 'providers.json'), 'utf8'));
    seznam = (cfg.providers || []).filter((p) => !jen || p.name === jen);
  }

  const karty = [];
  for (const p of seznam) {
    let key = p.key; let odkud = 'override';
    if (!key) ({ key, odkud } = keyFor(p));
    if (!key) { console.log(`- ${p.name}: preskoceno (chybi klic)`); continue; }
    let hotovo = false;
    for (const model of p.models) {
      const karta = await probeProvider({ name: p.name, baseUrl: p.baseUrl, key, model, velkyTest });
      karta.klic_odkud = odkud;
      karty.push(karta);
      const st = karta.kroky?.ping?.status;
      console.log(`${p.name} / ${model}: ping HTTP ${st}, latence ${karta.merena_latence_ms} ms` +
        (karta.mereny_strop_vstupu ? `, strop vstupu ${karta.mereny_strop_vstupu}` : ''));
      if (st === 200) { hotovo = true; break; }
    }
    if (!hotovo) console.log(`  (${p.name}: zadny model neodpovedel na ping)`);
  }
  const vystup = { measured_at: new Date().toISOString(), karty };
  // V sandboxu DSH nemuze podproces zapsat soubor (EPERM) - proto `--stdout`.
  if (process.argv.includes('--stdout')) console.log(JSON.stringify(vystup, null, 2));
  else {
    writeFileSync(out, JSON.stringify(vystup, null, 2));
    console.log(`\nKarty zapsany: ${out} (${karty.length})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('CHYBA:', e.message); process.exit(1); });
}
