// Parte 207: el escáner no debe tirar ids de Américas al volver Albion, y Europa/Asia siguen igual (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contarIds, rangoDelHueco } from '../rangos.mjs';

// Los pedidos de rescate se escriben en el directorio actual: las pruebas corren en uno temporal.
process.chdir(mkdtempSync(path.join(tmpdir(), 'escaner-p207-')));
const esc = await import('../scrape.js');

/** topearRangos tal como estaba antes de la parte 207 (copiado), para comparar Europa/Asia. */
function topearRangosViejo(rangos, tope = 1_300_000) {
  const orden = rangos
    .filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] >= r[0])
    .map(([lo, hi]) => [lo, hi])
    .sort((a, b) => b[1] - a[1]);
  const unidos = [];
  for (const [lo, hi] of orden) {
    const ult = unidos[unidos.length - 1];
    if (ult && hi >= ult[0] - 1) ult[0] = Math.min(ult[0], lo);
    else unidos.push([lo, hi]);
  }
  const out = [];
  let total = 0;
  for (const [lo, hi] of unidos) {
    const cabe = Math.min(hi - lo + 1, tope - total);
    if (cabe <= 0) break;
    out.push([hi - cabe + 1, hi]);
    total += cabe;
  }
  return out;
}

// Cola real de Américas del 14-nov 19:05 UTC (resumida): 1.270.757 ids, el piso del hueco del 1-3 nov y muchos chicos.
const ULTIMA_KILL = 1_478_965_210; // 12-nov 09:44 UTC
const IDS_POR_HORA = 16_300;
function colaAmericas() {
  const chicos = [];
  for (let i = 0; i < 1100; i++) chicos.push([1_478_744_763 - i * 4000 - 800, 1_478_744_763 - i * 4000]);
  return [...chicos, [1_473_735_177, 1_474_576_412]]; // con el tramo re-encolado por la p207
}

test('Américas: al volver Albion el 16-nov el hueco nuevo entra entero y no se descarta nada de lo viejo', () => {
  const horas = 3 * 24 + 14; // 12-nov 09:44 → 16-nov ~00:00
  const minLeido = ULTIMA_KILL + horas * IDS_POR_HORA;
  const hueco = rangoDelHueco(ULTIMA_KILL, minLeido, esc.topeDeRegion('americas', esc.GAP_RANGE_MAX_IDS));
  assert.equal(hueco.descartados, 0);
  assert.equal(hueco.rango[0], ULTIMA_KILL + 1);
  const antes = esc.topearRangos('americas', colaAmericas());
  const despues = esc.topearRangos('americas', [hueco.rango, ...antes]);
  assert.equal(contarIds(despues), contarIds(antes) + hueco.total);
  assert.equal(despues.at(-1)[0], 1_473_735_177); // el piso viejo sigue
});

test('Américas antes de la p207 (tope 1,3 M): el mismo regreso tiraba TODO lo viejo y parte del hueco nuevo', () => {
  const minLeido = ULTIMA_KILL + (3 * 24 + 14) * IDS_POR_HORA;
  const hueco = rangoDelHueco(ULTIMA_KILL, minLeido, 1_300_000);
  assert.ok(hueco.descartados > 0);
  const despues = topearRangosViejo([hueco.rango, ...colaAmericas()]);
  assert.ok(despues.at(-1)[0] > ULTIMA_KILL); // no queda nada de antes de la caída
});

test('Europa y Asia: topearRangos da exactamente lo mismo que antes', () => {
  let semilla = 7;
  const azar = (n) => {
    semilla = (semilla * 1_103_515_245 + 12_345) % 2 ** 31;
    return semilla % n;
  };
  for (let caso = 0; caso < 300; caso++) {
    const rangos = [];
    for (let i = 0; i < 1 + azar(40); i++) {
      const lo = 460_000_000 + azar(3_000_000);
      rangos.push([lo, lo + azar(caso % 3 === 0 ? 900_000 : 5_000)]);
    }
    for (const region of ['europe', 'asia']) assert.deepEqual(esc.topearRangos(region, rangos), topearRangosViejo(rangos));
  }
  assert.equal(esc.topeDeRegion('europe', esc.GAP_RANGE_MAX_IDS), 1_300_000);
  assert.equal(esc.topeDeRegion('asia', esc.GAP_PENDING_MAX_IDS), 1_300_000);
});

test('Américas: el tope nuevo sí corta, pero recién pasados los 8 M (≈ 20 días de ids)', () => {
  const r = esc.topearRangos('americas', [[1, 9_000_000]]);
  assert.equal(contarIds(r), 8_000_000);
  assert.deepEqual(r, [[1_000_001, 9_000_000]]);
});

test('pedirRescate: Américas parte una caída de 12 días en tramos y programa el repaso; Europa no cambia', async () => {
  const state = {};
  assert.equal(await esc.pedirRescate(state, 'americas', '2026-11-12T09:44:09.291Z', '2026-11-24T10:00:00.000Z'), true);
  const pedidos = readFileSync('rescate-pedidos.ndjson', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(pedidos.length, 2);
  for (const p of pedidos) assert.ok(Date.parse(p.hasta) - Date.parse(p.desde) <= 10 * 86_400_000);
  assert.equal(state.rescatesRepaso.length, 1);
  assert.ok(Date.parse(state.rescatesRepaso[0].cuando) > Date.now() + 11 * 3_600_000);
  // El repaso pide la misma ventana aunque «ya se pidió».
  assert.equal(await esc.pedirRescate(state, 'americas', '2026-11-12T09:44:09.291Z', '2026-11-15T10:00:00.000Z'), false);
  assert.equal(await esc.pedirRescate(state, 'americas', '2026-11-12T09:44:09.291Z', '2026-11-15T10:00:00.000Z', { repaso: true }), true);
  assert.equal(state.rescatesRepaso.length, 1); // el repaso no programa otro

  const eu = {};
  assert.equal(await esc.pedirRescate(eu, 'europe', '2026-11-12T09:44:09.291Z', '2026-11-24T10:00:00.000Z'), true);
  assert.equal(eu.rescatesPedidos.length, 1); // una sola ventana, como siempre
  assert.equal(eu.rescatesRepaso, undefined);
});

test('pedirBarrido: solo Américas, solo con cola grande, los ids más viejos y una tanda cada 6 h', async () => {
  const state = {};
  assert.equal(await esc.pedirBarrido(state, 'europe', [[1, 5_000_000]]), false);
  assert.equal(await esc.pedirBarrido(state, 'americas', [[1, 50_000]]), false);
  const cola = colaAmericas();
  assert.equal(await esc.pedirBarrido(state, 'americas', cola), true);
  const p = state.rescatesPedidos.at(-1);
  assert.equal(p.modo, 'ids');
  assert.equal(p.maquinas, '12');
  assert.match(p.rangos, /^\d+-\d+(,\d+-\d+)*$/);
  const [lo, hi] = p.rangos.split(',').at(-1).split('-').map(Number);
  assert.equal(lo, 1_473_735_177); // empieza por lo más viejo
  assert.ok(hi - lo + 1 <= 180_000);
  assert.equal(await esc.pedirBarrido(state, 'americas', cola), false); // hay una tanda de menos de 6 h
  assert.ok(existsSync('rescate-pedidos.ndjson'));
});
