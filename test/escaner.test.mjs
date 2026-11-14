// Parte 207: el escáner no debe tirar ids de Américas al volver Albion, y Europa/Asia siguen igual (node --test).
// Todo corre el código REAL de scrape.js (importarlo ya no arranca el escáner).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { contarIds, normalizarRangos, rangoDelHueco } from '../rangos.mjs';

// Los pedidos de rescate y los archivos de kills se escriben en el directorio actual: las pruebas corren en uno temporal.
process.chdir(mkdtempSync(path.join(tmpdir(), 'escaner-p207-')));
delete process.env.GITHUB_REPOSITORY;
delete process.env.DATA_REPOS_DIR;
const esc = await import('../scrape.js');

/** topearRangos tal como estaba antes de la parte 207 (referencia copiada de 866cb0887). */
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

// Cola de Américas parecida a la del 14-nov 19:05 UTC: muchos huecos chicos y el hueco del 1-3 nov abajo.
const ULTIMA_KILL = 1_478_965_210; // 12-nov 09:44 UTC
const IDS_POR_HORA = 16_300;
function colaAmericas() {
  const chicos = [];
  for (let i = 0; i < 1100; i++) chicos.push([1_478_744_763 - i * 4000 - 800, 1_478_744_763 - i * 4000]);
  return [...chicos, [1_473_735_177, 1_474_576_412]];
}
const regreso = (tope) => rangoDelHueco(ULTIMA_KILL, ULTIMA_KILL + (3 * 24 + 14) * IDS_POR_HORA, tope); // 16-nov ~00:00

test('Américas (código real, tope nuevo): al volver Albion el hueco nuevo entra entero y no se descarta nada', () => {
  const hueco = regreso(esc.topeDeRegion('americas', esc.GAP_RANGE_MAX_IDS));
  assert.equal(hueco.descartados, 0);
  assert.equal(hueco.rango[0], ULTIMA_KILL + 1);
  const antes = esc.topearRangos('americas', colaAmericas());
  const despues = esc.topearRangos('americas', [hueco.rango, ...antes]);
  assert.equal(contarIds(despues), contarIds(antes) + hueco.total);
  assert.equal(despues.at(-1)[0], 1_473_735_177);
});

test('Antes (código real con el tope de 1,3 M, el que hoy sigue en Europa): el mismo regreso tiraba TODO lo viejo', () => {
  const hueco = regreso(esc.topeDeRegion('europe', esc.GAP_RANGE_MAX_IDS));
  assert.ok(hueco.descartados > 0);
  const despues = esc.topearRangos('europe', [hueco.rango, ...colaAmericas()]);
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

test('Américas: el tope nuevo corta recién pasados los 8 M (≈ 20 días de ids)', () => {
  assert.deepEqual(esc.topearRangos('americas', [[1, 9_000_000]]), [[1_000_001, 9_000_000]]);
});

/** barrerIds de mentira: confirma los `n` ids más nuevos y devuelve `saltados`. */
function barrerFalso(llamadas, n, saltados = []) {
  return async (region, rangos, fallos) => {
    llamadas.push({ region, rangos: rangos.map((r) => [...r]), fallos });
    let resto = n;
    const quedan = rangos.map((r) => [...r]);
    while (resto > 0 && quedan.length > 0) {
      const tam = quedan[0][1] - quedan[0][0] + 1;
      if (resto >= tam) { quedan.shift(); resto -= tam; } else { quedan[0][1] -= resto; resto = 0; }
    }
    return { rangos: quedan, recuperadas: 2, fallos: 0, limitado: false, saltados };
  };
}

test('pasoBarrido en Europa: mismo camino que antes (la cola entera, sin esperas, saltados no vuelven)', async () => {
  const cola = [[500, 600], [100, 199]];
  const gapRanges = { europe: cola };
  const gapEspera = {};
  const gapFails = { europe: { id: 600, n: 3 } };
  const llamadas = [];
  const r = await esc.pasoBarrido({ region: 'europe', gapRanges, gapEspera, gapFails, hastaMs: Date.now() + 10_000, barrer: barrerFalso(llamadas, 10, [590]) });
  assert.deepEqual(llamadas, [{ region: 'europe', rangos: cola, fallos: 3 }]);
  assert.deepEqual(gapRanges.europe, [[500, 590], [100, 199]]);
  assert.deepEqual(gapEspera, {});
  assert.deepEqual(gapFails.europe, { id: 590, n: 0 });
  assert.deepEqual(r, { recuperadas: 2, limitado: false });
  // Sin cola no se llama a barrer.
  const otra = [];
  await esc.pasoBarrido({ region: 'asia', gapRanges: {}, gapEspera: {}, gapFails: {}, hastaMs: Date.now() + 10_000, barrer: barrerFalso(otra, 1) });
  assert.equal(otra.length, 0);
});

test('pasoBarrido en Américas: el hueco en espera no se barre y los saltados vuelven en espera', async () => {
  const ahora = Date.now();
  const gapRanges = { americas: [[1000, 1999], [100, 199]] };
  const gapEspera = { americas: [[1500, 1999, ahora + 3_600_000], [100, 110, ahora - 1]] };
  const gapFails = {};
  const llamadas = [];
  await esc.pasoBarrido({ region: 'americas', gapRanges, gapEspera, gapFails, hastaMs: ahora + 10_000, ahora, barrer: barrerFalso(llamadas, 100, [1450]) });
  assert.deepEqual(llamadas[0].rangos, [[1000, 1499], [100, 199]]); // lo de 1500-1999 espera; la espera vencida no
  assert.deepEqual(normalizarRangos(gapRanges.americas), [[1500, 1999], [1450, 1450], [1000, 1399], [100, 199]]);
  assert.deepEqual(gapEspera.americas.map((e) => e.slice(0, 2)), [[1500, 1999], [1450, 1450]]);
});

test('pedirBarrido: 4 máquinas, tanda acotada, nada por encima de la última kill, y no pisa a los rescates', async () => {
  const cola = esc.topearRangos('americas', [...colaAmericas(), [1_478_965_000, 1_478_999_999]]);
  const base = () => ({ lastEventIds: { americas: ULTIMA_KILL } });
  assert.equal(await esc.pedirBarrido(base(), 'europe', [[1, 5_000_000]]), false);
  assert.equal(await esc.pedirBarrido(base(), 'americas', [[1, 50_000]]), false);
  assert.equal(await esc.pedirBarrido({}, 'americas', cola), false); // sin canario no se pide

  const state = base();
  assert.equal(await esc.pedirBarrido(state, 'americas', cola), true);
  const p = state.rescatesPedidos.at(-1);
  assert.equal(p.modo, 'ids');
  assert.equal(p.maquinas, String(esc.BARRIDO_MAQUINAS));
  assert.equal(p.maquinas, '4');
  assert.equal(p.canario, String(ULTIMA_KILL));
  const tanda = p.rangos.split(',').map((x) => x.split('-').map(Number));
  assert.ok(contarIds(tanda) <= esc.BARRIDO_TANDA_IDS && contarIds(tanda) >= 10_000);
  assert.ok(tanda.length <= 2000);
  assert.ok(tanda.every(([, hi]) => hi < ULTIMA_KILL));
  assert.equal(tanda.at(-1)[0], 1_473_735_177); // empieza por lo más viejo
  assert.equal(await esc.pedirBarrido(state, 'americas', cola), false); // una tanda cada 6 h

  const conRescate = { ...base(), rescatesPedidos: [{ region: 'europe', desde: 'a', hasta: 'b', maquinas: '8', at: new Date().toISOString() }] };
  assert.equal(await esc.pedirBarrido(conRescate, 'americas', cola), false);
  const conRepaso = { ...base(), rescatesRepaso: [{ region: 'americas', desde: 'a', hasta: 'b', cuando: new Date(Date.now() + 3_600_000).toISOString() }] };
  assert.equal(await esc.pedirBarrido(conRepaso, 'americas', cola), false);
  // Solo ids sueltos: no vale una tanda.
  const sueltos = Array.from({ length: 3000 }, (_, i) => [1_400_000_000 + i * 10, 1_400_000_000 + i * 10]);
  assert.equal(await esc.pedirBarrido(base(), 'americas', [...sueltos, [1_470_000_000, 1_470_100_000]]), true);
});

test('pedirRescate: tramos y repaso en Américas, Europa igual, y el total de máquinas nunca pasa el tope', async () => {
  const state = {};
  assert.equal(await esc.pedirRescate(state, 'americas', '2026-11-12T09:44:09.291Z', '2026-11-24T10:00:00.000Z'), true);
  const pedidos = readFileSync('rescate-pedidos.ndjson', 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.region === 'americas' && x.modo !== 'ids');
  assert.equal(pedidos.length, 2);
  for (const p of pedidos) assert.ok(Date.parse(p.hasta) - Date.parse(p.desde) <= 10 * 86_400_000);
  assert.ok(esc.maquinasOcupadas(state) <= esc.MAQUINAS_TOPE + 2);
  assert.equal(state.rescatesRepaso.length, 1);
  assert.equal(await esc.pedirRescate(state, 'americas', '2026-11-12T09:44:09.291Z', '2026-11-15T10:00:00.000Z'), false); // ya pedido
  assert.equal(await esc.pedirRescate(state, 'americas', '2026-11-12T09:44:09.291Z', '2026-11-15T10:00:00.000Z', { repaso: true }), true);
  assert.equal(state.rescatesRepaso.length, 1);

  const eu = {};
  assert.equal(await esc.pedirRescate(eu, 'europe', '2026-11-12T09:44:09.291Z', '2026-11-24T10:00:00.000Z'), true);
  assert.deepEqual(eu.rescatesPedidos.map((p) => p.maquinas), ['8']); // una ventana y 8 máquinas, como siempre
  assert.equal(eu.rescatesRepaso, undefined);

  // Con un barrido (4) y un rescate (8) corriendo, un segundo rescate se achica a 2.
  const lleno = { rescatesPedidos: [{ region: 'americas', modo: 'ids', maquinas: '4', at: new Date().toISOString() }] };
  await esc.pedirRescate(lleno, 'americas', '2026-11-12T09:44:09.291Z', '2026-11-13T10:00:00.000Z');
  await esc.pedirRescate(lleno, 'europe', '2026-11-12T09:44:09.291Z', '2026-11-13T10:00:00.000Z');
  assert.deepEqual(lleno.rescatesPedidos.map((p) => p.maquinas), ['4', '8', '2']);
});

test('pedirRepasos: pide el vencido, guarda el futuro y deja el de hace más de 3 días', async () => {
  const ahora = Date.now();
  const state = {
    rescatesRepaso: [
      { region: 'americas', desde: '2026-11-12T09:44:09.291Z', hasta: '2026-11-13T09:44:09.291Z', cuando: new Date(ahora - 60_000).toISOString() },
      { region: 'americas', desde: '2026-11-12T09:44:09.291Z', hasta: '2026-11-13T09:44:09.291Z', cuando: new Date(ahora + 3_600_000).toISOString() },
      { region: 'americas', desde: 'roto', hasta: 'roto', cuando: new Date(ahora - 4 * 86_400_000).toISOString() },
    ],
  };
  await esc.pedirRepasos(state);
  assert.equal(state.rescatesRepaso.length, 1);
  assert.ok(Date.parse(state.rescatesRepaso[0].cuando) > ahora);
  assert.equal(state.rescatesPedidos.filter((p) => p.repaso).length, 1);
});

test('cargarRescates: escribe las kills y devuelve los ids de la línea `barrido` solo al terminar el archivo', async () => {
  const id = `rescate-americas-ids-prueba-${process.pid}-${Date.now()}/rescate-americas-parte0.ndjson.gz`;
  const kill = { EventId: 1_473_735_300, TimeStamp: '2026-11-01T03:00:00.000Z', Killer: { Name: 'A' }, Victim: { Name: 'B', Id: 'v' } };
  const lineas = [
    { d: '2026-11-01', k: { eventId: kill.EventId, timestamp: kill.TimeStamp, killerName: 'A', victimName: 'B', participants: [] }, q: null },
    { barrido: [[1_473_735_177, 1_473_735_400]] },
  ];
  writeFileSync(path.join(tmpdir(), `rescate-${id.replace(/[^\w.-]/g, '_')}`), gzipSync(lineas.map((l) => JSON.stringify(l)).join('\n') + '\n'));
  const state = { rescatesLista: { at: new Date().toISOString(), items: [{ id, region: 'americas', url: 'http://127.0.0.1:9/nada' }] } };
  const barridos = {};
  const avance = await esc.cargarRescates(state, barridos);
  assert.deepEqual(barridos, { americas: [[1_473_735_177, 1_473_735_400]] });
  assert.ok(state.rescates[id].hecho);
  assert.equal(avance.americas.rescateNuevas, 1);
  assert.equal(avance.europe.rescatesPendientes, 0);
  const escrito = readFileSync(path.join('data', 'kills', 'americas', '2026-11-01.ndjson'), 'utf8');
  assert.match(escrito, /1473735300/);
});
