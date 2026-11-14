// Parte 207: modo ids de rescate.mjs contra un Albion de mentira (node:http), con las guardas antes de confirmar ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { contarIds, normalizarRangos } from '../rangos.mjs';

const RESCATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'rescate.mjs');
const evento = (id) => ({ EventId: id, TimeStamp: '2026-11-01T03:00:00.000Z', Killer: { Name: 'A', Id: 'a' }, Victim: { Name: 'B', Id: 'b' }, Participants: [], GroupMembers: [] });

/** Albion de mentira. `responder(id, vecesCanario)` → número de estado o un evento. */
async function servidor(responder, canario) {
  let vecesCanario = 0;
  const s = http.createServer((req, res) => {
    const m = /^\/api\/gameinfo\/events\/(\d+)$/.exec(req.url);
    if (!m) {
      res.writeHead(404).end(); // raw.githubusercontent de mentira: ningún archivo
      return;
    }
    const id = Number(m[1]);
    if (id === canario) vecesCanario++;
    const r = responder(id, vecesCanario);
    if (typeof r === 'number') res.writeHead(r).end();
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r));
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${s.address().port}`, cerrar: () => s.close() };
}

async function correr(responder, { rangos = '1000-1299', canario = 2000 } = {}) {
  const sv = await servidor(responder, canario);
  const dir = mkdtempSync(path.join(tmpdir(), 'rescate-p207-'));
  const out = path.join(dir, 'r.ndjson.gz');
  try {
    await new Promise((ok, mal) =>
      execFile(process.execPath, [RESCATE], {
        cwd: dir,
        timeout: 60_000,
        env: { ...process.env, REGION: 'americas', MODO: 'ids', RANGOS: rangos, CANARIO: String(canario), SHARD: '0', SHARDS: '1', OUT: out, SPACING_MS: '1', CANARIO_ESPERA_MS: '5', ALBION_BASE: sv.url, RAW_BASE: `${sv.url}/raw`, RESCATE_SIN_VALORES: '1', DATA_OWNER: 'nadie' },
      }, (err, stdout, stderr) => (err ? mal(new Error(`${err.message}\n${stderr}`)) : ok())),
    );
  } finally {
    sv.cerrar();
  }
  const lineas = gunzipSync(readFileSync(out)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const resumen = JSON.parse(readFileSync(out.replace(/\.ndjson\.gz$/, '.json'), 'utf8'));
  return { kills: lineas.filter((l) => l.k), barrido: lineas.find((l) => l.barrido)?.barrido ?? null, resumen };
}

// Normal: 1 de cada 6 es kill, el resto 404; el 1005 da 502 siempre.
const normal = (id) => (id === 2000 || id % 6 === 0 ? evento(id) : id === 1005 ? 502 : 404);

test('modo ids normal: confirma todo lo que tuvo respuesta clara, menos el id que siempre falló', async () => {
  const r = await correr(normal);
  assert.equal(r.kills.length, 50);
  assert.equal(contarIds(r.barrido), 299);
  assert.deepEqual(normalizarRangos(r.barrido), [[1006, 1299], [1000, 1004]]);
  assert.equal(r.resumen.confirma, true);
  assert.equal(r.resumen.perdidos, 1);
});

test('tasa de kills anormal (todo 404): se suben 0 kills y NO se confirma ningún id', async () => {
  const r = await correr((id) => (id === 2000 ? evento(id) : 404));
  assert.equal(r.barrido, null);
  assert.equal(r.resumen.confirma, false);
  assert.match(r.resumen.motivo, /tasa/);
});

test('el canario deja de dar 200 al terminar: las kills se suben, pero no se confirma nada', async () => {
  const r = await correr((id, veces) => (id === 2000 ? (veces > 1 ? 404 : evento(id)) : normal(id)));
  assert.equal(r.kills.length, 50);
  assert.equal(r.barrido, null);
  assert.equal(r.resumen.canarioFin, false);
});

test('el canario no responde al empezar: no se barre nada', async () => {
  const r = await correr((id) => (id === 2000 ? 404 : normal(id)));
  assert.equal(r.kills.length, 0);
  assert.equal(r.barrido, null);
  assert.equal(r.resumen.canarioInicio, false);
});

test('un 404 igual o más nuevo que la última kill publicada nunca se confirma', async () => {
  const r = await correr((id) => (id === 1200 || id % 6 === 0 ? evento(id) : id > 1200 ? 404 : normal(id)), { canario: 1200 });
  const confirmados = new Set();
  for (const [lo, hi] of r.barrido) for (let i = lo; i <= hi; i++) confirmados.add(i);
  for (let id = 1201; id <= 1299; id++) assert.equal(confirmados.has(id), id % 6 === 0, `id ${id}`);
  assert.ok(confirmados.has(1199));
});
