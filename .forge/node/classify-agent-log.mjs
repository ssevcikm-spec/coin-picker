#!/usr/bin/env node
// K2 - KLASIFIKACE SELHANI: pojmenuj PRICINU, ne jen "failure".
//
// PROC TO EXISTUJE (namereno 12. 10. 2026):
//   - conductor vidi jen "GitHub Actions: failure" (sloupec `summary` v /status).
//     Nema jak rozlisit vycerpanou kvotu od velkeho requestu nebo od chyby modelu
//     - a proto nemuze ani rotovat poskytovatele, ani odpustit pokus granulí.
//   - workflow mel JEDEN spolecny `grep RateLimitError`, ktery slil dohromady
//     "request too large" (deterministicke) a "vycerpana kvota" (prechodne).
//     Dusledek: u velkeho requestu se PRESKOCIL druhy poskytovatel ("setrim
//     kvotu") - tedy presne ta cesta, ktera jedina muze pomoct.
//   - a kdyz agent nezměnil kod, report se NEPOSLAL vubec (krok "Report pri
//     selhani" ma podminku `tests.outcome != success`; pri "nochange" testy
//     projdou) - takze conductor dostal jeste min informace.
//
// CO DELA: precte agent.log + vysledky kroku a vrati JEDNU tridu + cisla.
// Poradi pravidel je podstatne: "Request too large" obsahuje i vetu
// "The API provider has rate limited you", takze se MUSI testovat pred kvotou.
//
// TRIDY: REQUEST_TOO_LARGE | QUOTA | AUTH | PROVIDER_DOWN | PARSE | TESTS |
//        SCRIPT_ERROR | NOCHANGE | OK
//
// Pouziti:
//   node .forge/node/classify-agent-log.mjs --log agent.log --zmena ne
//   node .forge/node/classify-agent-log.mjs --log agent.log --testy failed --parsovani failed --json

import { readFileSync, existsSync } from 'node:fs';

const PRAVIDLA = [
  // POZOR: sem NESMI patri "too many tokens" - to je text Cerebrasu u minutoveho
  // limitu (kvota), ne u velkeho requestu. Rozlisujici je "Request too large"
  // + vyzva "reduce your message size" (to pise Groq u 413).
  ['REQUEST_TOO_LARGE', /Request too large|REQUEST_TOO_LARGE|context_length_exceeded|maximum context length|prompt is too long|reduce your message size/i],
  ['QUOTA', /exceeded your current quota|rate limit reached|Tokens per minute limit exceeded|"code"\s*:\s*429|Error code:\s*429|status.?429/i],
  ['AUTH', /incorrect api key|invalid_api_key|Unauthorized|Error code:\s*401|could not read Username/i],
  ['PROVIDER_DOWN', /Error code:\s*(502|503|504)|ECONNRESET|ETIMEDOUT|socket hang up|timed out|fetch failed/i],
];

export const CISLA = /(?:[Ll]imit|Requested)\s+([\d\s.,]+)/g;

/** Vytahne z textu vsechna cisla "Limit X" / "Requested Y" (poskytovatel je pise do chyby). */
export function cislaZLogu(text) {
  const nalez = [...String(text).matchAll(CISLA)].map((m) => Number(m[1].replace(/[\s.,]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  const uniq = [...new Set(nalez)].sort((a, b) => a - b);
  return { hodnoty: uniq, limit: uniq.length ? Math.min(...uniq) : null, requested: uniq.length ? Math.max(...uniq) : null };
}

/** Prvni radek vypadajici jako chyba - do reportu (zkraceny). */
export function prvniChyba(text) {
  const radek = String(text).split('\n').find((l) =>
    /RateLimitError|Error code:|error:|Request too large|invalid_api_key|Repository not found/i.test(l));
  return radek ? radek.trim().replace(/^litellm\./, '').slice(0, 200) : '';
}

/**
 * Cista funkce: z textu logu a vysledku kroku vrati tridu.
 * `zmena` je 'ano' | 'ne' | '' (nezname).
 */
export function klasifikuj({ log = '', zmena = '', parsovani = '', testy = '' }) {
  for (const [trida, vzor] of PRAVIDLA) {
    if (vzor.test(log)) return trida;
  }
  // POZOR: 'skipped' NENI selhani. Krok se preskoci i tehdy, kdyz beh spadl
  // driv (napr. na rozpoctu) - kdyby se to cetlo jako PARSE/TESTS, dostal by
  // conductor jinou pricinu, nez jaká se stala.
  const selhalo = (v) => v === 'failure' || v === 'cancelled' || v === 'timed_out';
  if (selhalo(parsovani)) return 'PARSE';
  if (selhalo(testy)) return 'TESTS';
  if (/SCRIPT ERROR/.test(log)) return 'SCRIPT_ERROR';
  if (zmena === 'ne') return 'NOCHANGE';
  return 'OK';
}

function arg(n, d = '') { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; }

function main() {
  const cesta = arg('--log', 'agent.log');
  const log = existsSync(cesta) ? readFileSync(cesta, 'utf8') : '';
  const zmena = arg('--zmena');
  const trida = klasifikuj({ log, zmena, parsovani: arg('--parsovani'), testy: arg('--testy') });
  const c = cislaZLogu(log);
  const vystup = {
    trida,
    limit: c.limit, requested: c.requested,
    poskytovatel: arg('--poskytovatel', process.env.FORGE_PROVIDER || ''),
    model: arg('--model', process.env.FORGE_MODEL || ''),
    prvni_chyba: prvniChyba(log),
    zmena: zmena || '(nezname)',
    znaku_logu: log.length,
  };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(vystup, null, 2));
  } else {
    console.log(`TRIDA=${trida}`);
    console.log(`KLASIFIKACE: ${trida} | limit=${vystup.limit ?? '-'} requested=${vystup.requested ?? '-'}` +
      ` | poskytovatel=${vystup.poskytovatel || '-'} | zmena=${vystup.zmena}`);
    if (vystup.prvni_chyba) console.log(`PRVNI_CHYBA: ${vystup.prvni_chyba}`);
  }
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  main();
}
