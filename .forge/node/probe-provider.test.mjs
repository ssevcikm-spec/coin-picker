#!/usr/bin/env node
// Saboter k probe-provider.mjs: postavi FALESNEHO poskytovatele a overi, ze
// probe opravdu CTE cisla - na trech znamych pripadech:
//   A) 429 s telem "Limit 8000, Requested 24 000" -> musi precist OBE cisla
//   B) 429 BEZ cisel (kvota) -> NESMI si zadny strop vymyslet
//   C) 200 s usage -> musi precist prompt_tokens a spocitat znaku/token
// Bez tohohle testu by "karta poskytovatele" mohla byt jen dojem.
//
// Spousteni: node .forge/node/probe-provider.test.mjs

import { createServer } from 'node:http';
import { probeProvider, cislaZChyby } from './probe-provider.mjs';

let chyb = 0;
let kontroly = 0;
const test = (nazev, skutecne, ocekavane) => {
  kontroly++;
  const ok = JSON.stringify(skutecne) === JSON.stringify(ocekavane);
  if (!ok) { chyb++; console.log(`CHYBA  ${nazev}: ocekavano ${JSON.stringify(ocekavane)}, namereno ${JSON.stringify(skutecne)}`); }
  else console.log(`ok     ${nazev} = ${JSON.stringify(skutecne)}`);
};

const TOO_LARGE = 'Request too large for model `openai/gpt-oss-120b` in organization `org_x` '
  + 'service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 24 000, please reduce your message size.';
const KVOTA = 'Rate limit reached for requests. You exceeded your current quota, please check your plan and billing details.';

function server(mode) {
  return createServer((req, res) => {
    let telo = '';
    req.on('data', (c) => { telo += c; });
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'openai/gpt-oss-120b' }] }));
        return;
      }
      const body = telo ? JSON.parse(telo) : {};
      const delka = (body.messages?.[0]?.content || '').length;
      const hlavicky = { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '1234' };
      if (mode === 'kvota') {
        res.writeHead(429, { 'content-type': 'application/json', ...hlavicky });
        res.end(JSON.stringify({ error: { message: KVOTA } }));
        return;
      }
      if (delka > 50000) {
        res.writeHead(429, { 'content-type': 'application/json', ...hlavicky });
        res.end(JSON.stringify({ error: { message: TOO_LARGE } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', ...hlavicky });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: delka > 3000 ? 1000 : 3, completion_tokens: 1, total_tokens: delka > 3000 ? 1001 : 4 },
      }));
    });
  });
}

async function bez({ mode, model = 'openai/gpt-oss-120b' }) {
  const srv = server(mode);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const karta = await probeProvider({
    name: `mock-${mode}`, baseUrl: `http://127.0.0.1:${port}/v1`, key: 'test', model, velkyTest: true,
  });
  await new Promise((r) => srv.close(r));
  return karta;
}

console.log('=== A) poskytovatel vraci 429 s cisly (too large) ===');
const a = await bez({ mode: 'too-large' });
test('A: maly dotaz projde', a.kroky.ping.status, 200);
test('A: katalog vidi model', a.kroky.katalog.model_je_v_katalogu, true);
test('A: hlavicky s limity precteny', a.kroky.ping.headers['x-ratelimit-limit-tokens'], '8000');
test('A: strop vstupu z tela chyby', a.mereny_strop_vstupu, 8000);
test('A: requested z tela chyby (s mezerou v cisle)', a.kroky.velky_test.chyba_cisla.requested, 24000);
test('A: znaku na token spocitano', a.znaku_na_token, 4);
test('A: uctovani rozhodnuto', a.uctovani_zaver, 'rozhoduje vstup (max_tokens nezmenil prijeti)');

console.log('\n=== B) poskytovatel vraci 429 BEZ cisel (kvota) ===');
const b = await bez({ mode: 'kvota' });
test('B: ping vraci 429', b.kroky.ping.status, 429);
test('B: chyba bez cisel -> zadny strop', b.mereny_strop_vstupu, undefined);
test('B: cislaZChyby nic nevymysli', cislaZChyby('You exceeded your current quota.'), {});
test('B: text chyby je v karte', b.kroky.ping.ukazka.includes('quota'), true);

console.log('\n=== C) parse cisel z ruznych tvaru ===');
test('C: "Limit 8000, Requested 27557"', cislaZChyby('tokens per minute (TPM): Limit 8000, Requested 27557, please reduce'), { limit: 8000, requested: 27557, jednotka: 'TPM' });
test('C: "Limit 8,000"', cislaZChyby('Limit 8,000, Requested 1 500'), { limit: 8000, requested: 1500 });
test('C: prazdny text', cislaZChyby(''), {});

console.log(`\n=== VYSLEDEK: ${kontroly - chyb}/${kontroly} kontrol, ${chyb} chyb ===`);
process.exit(chyb ? 1 : 0);
