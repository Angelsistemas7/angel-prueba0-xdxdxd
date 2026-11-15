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

// ---- Parte 210: estado del barrido por id para el panel de admin (status.json) ----
// Resúmenes con los números reales de la corrida 43636128519 (14-nov, 4 máquinas, 56.000 ids); la parte 3 cambiada
// para probar un canario que falla al terminar.
const RESUMENES_REALES = [
  { shard: 0, shards: 4, ids: 14000, kills: 1192, conRespuesta: 6056, confirmados: 6056, rescatadas: 1192, yaEstaban: 1078, nuevas: 114, porDia: { '2026-11-01': 114 }, r429: 0, errores: 8710, pedidos: 14768, perdidos: 35, minutos: 321, cortadoPorTiempo: true, canarioInicio: true, canarioFin: true, confirma: true, motivo: null },
  { shard: 1, shards: 4, ids: 14000, kills: 1102, conRespuesta: 6200, confirmados: 6200, rescatadas: 1102, yaEstaban: 990, nuevas: 112, porDia: { '2026-11-01': 112 }, r429: 0, errores: 8500, pedidos: 14770, perdidos: 30, minutos: 321, cortadoPorTiempo: true, canarioInicio: true, canarioFin: true, confirma: true, motivo: null },
  { shard: 2, shards: 4, ids: 14000, kills: 950, conRespuesta: 6100, confirmados: 6100, rescatadas: 950, yaEstaban: 840, nuevas: 110, porDia: { '2026-11-01': 100, '2026-11-02': 10 }, r429: 0, errores: 8600, pedidos: 14760, perdidos: 40, minutos: 321, cortadoPorTiempo: true, canarioInicio: true, canarioFin: true, confirma: true, motivo: null },
  { shard: 3, shards: 4, ids: 14000, kills: 921, conRespuesta: 6044, confirmados: 0, rescatadas: 921, yaEstaban: 800, nuevas: 121, porDia: { '2026-11-01': 121 }, r429: 2, errores: 8800, pedidos: 14750, perdidos: 33, minutos: 320, cortadoPorTiempo: true, canarioInicio: true, canarioFin: false, confirma: false, motivo: 'el canario no dio 200 al terminar', tramo: [1473735177, 1473749176] },
];
const TAG_REAL = 'rescate-americas-ids-1473735177-1473791176-43636128519';
const TAG_PRUEBA = 'rescate-americas-ids-1474300100-1474300160-43635292011';
function estadoConBarrido(ahora) {
  const url = (n) => `https://github.com/x/y/releases/download/${TAG_REAL}/rescate-americas-parte${n}.json`;
  return {
    lastEventIds: { americas: ULTIMA_KILL },
    rescatesPedidos: [{ region: 'americas', modo: 'ids', rangos: '1473735177-1473791176', canario: String(ULTIMA_KILL), maquinas: '4', at: new Date(ahora - 5.5 * 3_600_000).toISOString() }],
    rescatesLista: {
      at: new Date(ahora).toISOString(),
      items: [],
      barridos: [
        { tag: TAG_REAL, region: 'americas', primero: [1473735177, 1473791176], runId: '43636128519', at: new Date(ahora - 5.4 * 3_600_000).toISOString(), resumenes: [0, 1, 2, 3].map((n) => ({ name: `rescate-americas-parte${n}.json`, url: url(n), at: new Date(ahora - 60_000).toISOString() })) },
        { tag: TAG_PRUEBA, region: 'americas', primero: [1474300100, 1474300160], runId: '43635292011', at: new Date(ahora - 5.6 * 3_600_000).toISOString(), resumenes: [] },
        { tag: 'rescate-europe-ids-1-2-3', region: 'europe', primero: [1, 2], runId: '3', at: new Date(ahora).toISOString(), resumenes: [] },
      ],
    },
    rescates: { [`${TAG_REAL}/rescate-americas-parte0.ndjson.gz`]: { n: 1, total: 1, hecho: 'x' }, [`${TAG_REAL}/rescate-americas-parte1.ndjson.gz`]: { n: 1, total: 9 } },
    barridoResumenes: { 'rescate-viejo-que-ya-no-esta': { 'a.json': {} } },
  };
}
const bajarReal = (bajados) => async (u) => {
  bajados.push(u);
  return RESUMENES_REALES[Number(/parte(\d)/.exec(u)[1])];
};

test('estadoBarrido: suma las 4 máquinas, guarda el tramo y no vuelve a bajar los resúmenes', async () => {
  const ahora = Date.parse('2026-11-15T01:40:00Z');
  const state = estadoConBarrido(ahora);
  const bajados = [];
  const bajar = bajarReal(bajados);
  const cola = [[1_473_791_177, 1_475_500_000]];
  const e = await esc.estadoBarrido(state, 'americas', { listos: cola, enEspera: 3, cola: contarIds(cola) + 3, canario: ULTIMA_KILL, ahora, bajar });
  assert.equal(bajados.length, 4);
  assert.equal(e.corridas.length, 2); // solo Américas, la más nueva primero
  const c = e.corridas[0];
  assert.equal(c.tag, TAG_REAL);
  assert.equal(c.maquinas, 4);
  assert.equal(c.partes, 4);
  assert.equal(c.enCurso, false);
  assert.deepEqual(c.tramo, [1473735177, 1473791176]);
  assert.equal(c.tramoParcial, false);
  assert.equal(c.idsPedidos, 56000);
  assert.equal(c.ids, 56000);
  assert.equal(c.kills, 1192 + 1102 + 950 + 921);
  assert.equal(c.nuevas, 457);
  assert.deepEqual(c.porDia, { '2026-11-01': 447, '2026-11-02': 10 });
  assert.equal(c.r429, 2);
  assert.equal(c.errores, 8710 + 8500 + 8600 + 8800);
  assert.equal(c.pedidos, 14768 + 14770 + 14760 + 14750);
  assert.equal(c.cortadas, 4);
  assert.equal(c.canarioInicio, 4);
  assert.equal(c.canarioFin, 3);
  assert.equal(c.confirman, 3);
  assert.deepEqual(c.motivos, ['el canario no dio 200 al terminar']);
  assert.equal(c.cargadas, 1); // solo la parte 0 terminó de cargarse
  assert.equal(c.fin, new Date(ahora - 60_000).toISOString());
  // La de prueba sin resúmenes, de hace 5,6 h: sigue «en curso» hasta 6 h 30 min.
  assert.equal(e.corridas[1].enCurso, true);
  assert.equal(e.corridas[1].tramoParcial, true);
  // Cola y próximo barrido: el último pedido fue hace 5,5 h → toca en 30 min.
  assert.equal(e.listos, contarIds(cola));
  assert.equal(e.enEspera, 3);
  assert.equal(e.proximoAt, new Date(ahora + 0.5 * 3_600_000).toISOString());
  assert.equal(e.proximoMotivo, 'una tanda cada 6 h');
  assert.equal(e.pedidoAt, state.rescatesPedidos[0].at);
  // El tramo y los resúmenes quedan en el estado; lo de releases que ya no están se poda.
  assert.deepEqual(Object.keys(state.barridoResumenes).sort(), [TAG_REAL, TAG_PRUEBA].sort());
  assert.equal(state.barridoTramos[TAG_REAL].ids, 56000);
  // Al día siguiente el pedido ya se podó: el tramo y los números siguen iguales sin bajar nada de nuevo.
  state.rescatesPedidos = [];
  const e2 = await esc.estadoBarrido(state, 'americas', { listos: cola, canario: ULTIMA_KILL, ahora: ahora + 86_400_000, bajar });
  assert.equal(bajados.length, 4);
  assert.deepEqual(e2.corridas[0].tramo, [1473735177, 1473791176]);
  assert.equal(e2.corridas[0].kills, c.kills);
  assert.equal(e2.corridas[1].enCurso, false); // pasó el tiempo de una corrida: ya no está «en curso»
  assert.equal(e2.proximoAt, new Date(ahora + 86_400_000).toISOString()); // nada frena: toca en la próxima vuelta
  assert.equal(e2.proximoMotivo, null);
  // Lo que suma a status.json se mantiene chico.
  assert.ok(JSON.stringify(e2).length < 3000, `pesa ${JSON.stringify(e2).length}`);
});

test('estadoBarrido: un resumen que no se puede bajar se reintenta y a los 5 fallos se deja', async () => {
  const ahora = Date.parse('2026-11-15T01:40:00Z');
  const state = estadoConBarrido(ahora);
  let intentos = 0;
  const bajar = async (u) => {
    if (/parte2/.test(u)) {
      intentos += 1;
      throw new Error('502');
    }
    return RESUMENES_REALES[Number(/parte(\d)/.exec(u)[1])];
  };
  for (let i = 0; i < 7; i++) await esc.estadoBarrido(state, 'americas', { ahora, bajar });
  assert.equal(intentos, 5);
  const e = await esc.estadoBarrido(state, 'americas', { ahora, bajar });
  assert.equal(e.corridas[0].partes, 3);
  assert.equal(e.corridas[0].enCurso, true); // falta una parte y no pasó el tiempo de la corrida
});

test('cuandoBarrido: mismas reglas que pedirBarrido, con la hora en que cada una deja de frenar', () => {
  const ahora = Date.parse('2026-11-15T01:40:00Z');
  const cola = [[1, 500_000]];
  const base = { lastEventIds: { americas: ULTIMA_KILL } };
  assert.deepEqual(esc.cuandoBarrido(base, 'americas', cola, ULTIMA_KILL, ahora), { bloqueado: false, at: ahora, motivo: null });
  assert.equal(esc.cuandoBarrido(base, 'europe', cola, ULTIMA_KILL, ahora).bloqueado, true);
  assert.equal(esc.cuandoBarrido(base, 'americas', [[1, 50_000]], ULTIMA_KILL, ahora).at, null);
  assert.equal(esc.cuandoBarrido(base, 'americas', cola, 0, ahora).motivo, 'sin kill de referencia (canario)');
  const conRescate = { ...base, rescatesPedidos: [{ region: 'europe', desde: 'a', hasta: 'b', maquinas: '8', at: new Date(ahora - 3_600_000).toISOString() }] };
  assert.deepEqual(esc.cuandoBarrido(conRescate, 'americas', cola, ULTIMA_KILL, ahora), { bloqueado: true, at: ahora + 5 * 3_600_000, motivo: 'hay un rescate por gremio corriendo' });
  const conRepaso = { ...base, rescatesRepaso: [{ region: 'americas', desde: 'a', hasta: 'b', cuando: new Date(ahora + 3_600_000).toISOString() }] };
  assert.deepEqual(esc.cuandoBarrido(conRepaso, 'americas', cola, ULTIMA_KILL, ahora), { bloqueado: true, at: ahora + 7 * 3_600_000, motivo: 'hay un repaso de rescate en menos de 6 h' });
  // Un repaso vencido que no pudo salir: frena, pero no se sabe hasta cuándo.
  const repasoVencido = { ...base, rescatesRepaso: [{ region: 'americas', desde: 'a', hasta: 'b', cuando: new Date(ahora - 7 * 3_600_000).toISOString() }] };
  assert.deepEqual(esc.cuandoBarrido(repasoVencido, 'americas', cola, ULTIMA_KILL, ahora), { bloqueado: true, at: null, motivo: 'hay un repaso de rescate en menos de 6 h' });
  // Rescates de 8 y 2 máquinas hace 2 h y 1 h (más un barrido viejo, ya libre): el rescate frena hasta dentro de 5 h.
  const lleno = { ...base, rescatesPedidos: [
    { region: 'americas', modo: 'ids', maquinas: '4', at: new Date(ahora - 7 * 3_600_000).toISOString() },
    { region: 'americas', desde: 'a', hasta: 'b', maquinas: '8', at: new Date(ahora - 2 * 3_600_000).toISOString() },
    { region: 'europe', desde: 'a', hasta: 'b', maquinas: '2', at: new Date(ahora - 1 * 3_600_000).toISOString() },
  ] };
  const r = esc.cuandoBarrido(lleno, 'americas', cola, ULTIMA_KILL, ahora);
  assert.equal(r.bloqueado, true);
  assert.equal(r.at, ahora + 5 * 3_600_000);
});

test('rescatesPublicados (vía cargarRescates): anota las releases del barrido con sus resúmenes', async () => {
  const fetchViejo = globalThis.fetch;
  process.env.GITHUB_REPOSITORY = 'x/y';
  globalThis.fetch = async () => new Response(JSON.stringify([
    { tag_name: TAG_REAL, published_at: '2026-11-14T20:11:14Z', created_at: '2026-11-14T20:10:06Z', assets: [
      { name: 'rescate-americas-parte0.json', state: 'uploaded', browser_download_url: 'https://h/p0.json', updated_at: '2026-11-15T01:32:01Z' },
      { name: 'rescate-americas-parte0.ndjson.gz', state: 'uploaded', browser_download_url: 'https://h/p0.gz', updated_at: '2026-11-15T01:32:01Z' },
      { name: 'rescate-americas-parte1.json', state: 'starter', browser_download_url: 'https://h/p1.json' },
    ] },
    { tag_name: 'rescate-americas-20261104T0251-41809357004', created_at: '2026-11-04T09:41:52Z', assets: [] },
  ]), { status: 200 });
  try {
    const state = { rescates: { [`${TAG_REAL}/rescate-americas-parte0.ndjson.gz`]: { n: 1, total: 1, hecho: 'x' } } };
    await esc.cargarRescates(state, {});
    assert.deepEqual(state.rescatesLista.barridos, [{
      tag: TAG_REAL, region: 'americas', primero: [1473735177, 1473791176], runId: '43636128519', at: '2026-11-14T20:11:14Z',
      resumenes: [{ name: 'rescate-americas-parte0.json', url: 'https://h/p0.json', at: '2026-11-15T01:32:01Z' }],
    }]);
    assert.equal(state.rescatesLista.items.length, 1);
  } finally {
    globalThis.fetch = fetchViejo;
    delete process.env.GITHUB_REPOSITORY;
  }
});
