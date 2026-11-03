/**
 * Rescate rápido de un hueco de kills (chat 156 de la app, 3-nov-2026). Lo corre `.github/workflows/rescate.yml`
 * repartido en varias máquinas (cada una con su IP y su propio cupo de Albion) y también se puede correr a mano.
 *
 * Por qué existe: cuando la API pública de Albion se cae (Américas, 1-nov 02:33 → 3-nov 11:10 UTC) el juego sigue
 * guardando cada kill y, al volver, se pueden leer. El barrido por id de `scrape.js` las encuentra todas, pero lento:
 * solo 1 de cada ~6 ids es una kill y un id viejo tarda 20-50 s (~41 ids/min → ~18 días para ese hueco). Medido:
 * - `/events?guildId=G&limit=51&offset=0..1000` trae las kills cuyo ASESINO es de G (153/153), 51 por pedido en <1 s,
 *   y su ventana de 1.051 llega días atrás salvo en gremios gigantes. Cada kill sale una sola vez.
 * - `/events?playerId=` NO filtra (devuelve la lista global).
 * - `/players/{id}/kills`: las últimas 10 kills de un jugador, tenga o no gremio. Cubre a los asesinos SIN gremio
 *   (14 % de las kills de Américas; casi todos con ≤10 kills por día, así que sus 10 últimas alcanzan el hueco).
 * - El límite de Albion es por IP y por minuto para toda la API (~55-60 pedidos/min sostenidos sin 429).
 *
 * Pasos (cada máquina toma su parte, `SHARD` de `SHARDS`, repartida por orden de actividad):
 * 1. Listas desde los archivos de kills de los días del hueco ±1 (repos mensuales): gremios atacantes y asesinos sin
 *    gremio. Esos mismos archivos dan los ids ya guardados.
 * 2. Gremios, de más a menos activo (su ventana es la más corta): páginas hasta pasar `DESDE`.
 * 3. Gremios descubiertos en lo rescatado (asesinos, víctimas, participantes, grupo) que no estaban en la lista.
 * 4. `/players/{id}/kills` de los asesinos sin gremio y después de las víctimas sin gremio del hueco.
 * 5. Arma las líneas con las MISMAS funciones de `scrape.js` (`toKillLine`, `extractEquipment`, valores del Radar) y
 *    quita los ids que ya estén guardados en CUALQUIER día (stats-builder solo quita repetidos dentro de un día; una
 *    kill en dos días contaría doble). `scrape.js` carga el archivo al día de cada kill sin duplicar.
 * Lo que ninguna vía alcanza lo sigue completando el barrido por id: este rescate no lo reemplaza.
 *
 * Variables: REGION, DESDE, HASTA (ISO), SHARD, SHARDS, OUT (archivo .ndjson.gz), SPACING_MS, PRESUPUESTO_MIN,
 * DATA_OWNER (dueño de los repos mensuales; por defecto el de este repo).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HOSTS = {
  europe: 'https://gameinfo-ams.albiononline.com',
  americas: 'https://gameinfo.albiononline.com',
  asia: 'https://gameinfo-sgp.albiononline.com',
};
const REGION = process.env.REGION;
const DESDE = Date.parse(process.env.DESDE ?? '');
const HASTA = Date.parse(process.env.HASTA ?? '');
const SHARD = Number(process.env.SHARD ?? 0);
const SHARDS = Math.max(1, Number(process.env.SHARDS ?? 1));
const OUT = process.env.OUT ?? `rescate-${REGION}-${SHARD}.ndjson.gz`;
const SPACING_MS = Number(process.env.SPACING_MS ?? 1100);
const PRESUPUESTO_MS = Number(process.env.PRESUPUESTO_MIN ?? 320) * 60_000;
const DATA_OWNER = process.env.DATA_OWNER ?? (process.env.GITHUB_REPOSITORY ?? 'Angelsistemas7/x').split('/')[0];
const PRIMER_DIA_REPOS_MENSUALES = '2026-10-01';
const BASE = `${HOSTS[REGION]}/api/gameinfo`;
if (!HOSTS[REGION] || !Number.isFinite(DESDE) || !Number.isFinite(HASTA) || HASTA <= DESDE || SHARD < 0 || SHARD >= SHARDS) {
  console.error('uso: REGION=americas DESDE=<iso> HASTA=<iso> [SHARD=0 SHARDS=1] node rescate.mjs');
  process.exit(2);
}
const inicio = Date.now();
const sinTiempo = () => Date.now() - inicio > PRESUPUESTO_MS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dia = (ms) => new Date(ms).toISOString().slice(0, 10);
const hoy = dia(Date.now());

// Reparto estable por texto (para lo descubierto en el camino, que no tiene un orden común entre máquinas).
const mia = (texto) => {
  let h = 0;
  for (let i = 0; i < texto.length; i++) h = (h * 31 + texto.charCodeAt(i)) >>> 0;
  return h % SHARDS === SHARD;
};

const cuenta = { pedidos: 0, r429: 0, errores: 0, perdidos: 0 };
let ultimo = 0;
/** GET con ritmo fijo; 429 → espera 65 s (el castigo de Albion es por IP). null si no respondió tras 6 intentos. */
async function pedir(url) {
  for (let intento = 0; intento < 6; intento++) {
    const espera = ultimo + SPACING_MS - Date.now();
    if (espera > 0) await sleep(espera);
    ultimo = Date.now();
    cuenta.pedidos++;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (res.status === 429) {
        cuenta.r429++;
        await sleep(65_000);
        continue;
      }
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`http ${res.status}`);
      return await res.json();
    } catch {
      cuenta.errores++;
      await sleep(3_000 * (intento + 1));
    }
  }
  cuenta.perdidos++;
  return null;
}

async function texto(url) {
  for (let intento = 0; intento < 4; intento++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (res.status === 404) return null;
      if (res.ok) return await res.text();
    } catch {
      /* reintento */
    }
    await sleep(5_000 * (intento + 1));
  }
  throw new Error(`no se pudo bajar ${url}`);
}

// ---- 1. Listas e ids ya guardados ----
const yaGuardados = new Set();
const gremios = new Map(); // id → kills como atacante
const sinGremio = new Map(); // id de asesino sin gremio → kills
const diasLista = [];
for (let d = DESDE - 86_400_000; dia(d) <= dia(HASTA + 86_400_000) && dia(d) <= hoy; d += 86_400_000) diasLista.push(dia(d));
for (const d of diasLista) {
  if (d < PRIMER_DIA_REPOS_MENSUALES) continue;
  const repo = `https://raw.githubusercontent.com/${DATA_OWNER}/albion-data-${REGION}-${d.slice(0, 7)}/main/kills`;
  for (let parte = 1; ; parte++) {
    const t = await texto(`${repo}/${d}${parte > 1 ? `.${parte}` : ''}.ndjson`);
    if (t === null) break;
    for (const l of t.split('\n')) {
      if (!l) continue;
      let k;
      try { k = JSON.parse(l); } catch { continue; }
      yaGuardados.add(k.eventId);
      for (const p of k.participants ?? []) {
        if (p?.guildId) gremios.set(p.guildId, (gremios.get(p.guildId) ?? 0) + 1);
        else if (p?.id && p.name === k.killerName) sinGremio.set(p.id, (sinGremio.get(p.id) ?? 0) + 1);
      }
    }
  }
}
const porActividad = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([id]) => id);
const misGremios = porActividad(gremios).filter((_, i) => i % SHARDS === SHARD);
const misJugadores = porActividad(sinGremio).filter((_, i) => i % SHARDS === SHARD);
console.log(`[${REGION} ${SHARD + 1}/${SHARDS}] días ${diasLista.join(',')} · ya guardados ${yaGuardados.size} · gremios ${misGremios.length}/${gremios.size} · sin gremio ${misJugadores.length}/${sinGremio.size}`);

// ---- 2-4. Rescate ----
const rescatados = new Map(); // EventId → evento recortado
const enHueco = (e) => {
  const t = Date.parse(e?.TimeStamp ?? '');
  return Number.isFinite(e?.EventId) && t >= DESDE && t <= HASTA;
};
/** Solo lo que usan `toKillLine` y `extractEquipment` (el evento entero pesa ~16 KB). */
const items = (eq) => Object.fromEntries(Object.entries(eq ?? {}).filter(([, v]) => v?.Type).map(([k, v]) => [k, { Type: v.Type, Count: v.Count }]));
const recortar = (e) => ({
  EventId: e.EventId,
  BattleId: e.BattleId ?? null,
  TimeStamp: e.TimeStamp,
  TotalVictimKillFame: e.TotalVictimKillFame,
  numberOfParticipants: e.numberOfParticipants,
  GroupMembers: (e.GroupMembers ?? []).map((g) => ({ Id: g?.Id ?? '', GuildId: g?.GuildId ?? '' })),
  Killer: { Name: e.Killer?.Name, Id: e.Killer?.Id, GuildName: e.Killer?.GuildName, GuildId: e.Killer?.GuildId, AverageItemPower: e.Killer?.AverageItemPower, Equipment: items(e.Killer?.Equipment) },
  Victim: { Name: e.Victim?.Name, Id: e.Victim?.Id, GuildName: e.Victim?.GuildName, GuildId: e.Victim?.GuildId, AverageItemPower: e.Victim?.AverageItemPower, Equipment: items(e.Victim?.Equipment), Inventory: (e.Victim?.Inventory ?? []).filter((x) => x?.Type).map((x) => ({ Type: x.Type, Count: x.Count })) },
  Participants: (e.Participants ?? []).map((p) => ({ Id: p.Id, Name: p.Name, GuildId: p.GuildId, GuildName: p.GuildName, DamageDone: p.DamageDone, SupportHealingDone: p.SupportHealingDone })),
});
const vistosGremios = new Set(gremios.keys());
const vistosJugadores = new Set(sinGremio.keys());
const descubiertosGremios = [];
const victimasSinGremio = [];
function guardar(evs) {
  let n = 0;
  for (const e of evs ?? []) {
    if (!enHueco(e) || rescatados.has(e.EventId)) continue;
    rescatados.set(e.EventId, recortar(e));
    n++;
    for (const g of [e.Killer?.GuildId, e.Victim?.GuildId, ...(e.Participants ?? []).map((p) => p?.GuildId), ...(e.GroupMembers ?? []).map((p) => p?.GuildId)]) {
      if (g && !vistosGremios.has(g)) {
        vistosGremios.add(g);
        if (mia(g)) descubiertosGremios.push(g);
      }
    }
    const v = e.Victim;
    if (v?.Id && !v.GuildId && !vistosJugadores.has(v.Id)) {
      vistosJugadores.add(v.Id);
      if (mia(v.Id)) victimasSinGremio.push(v.Id);
    }
  }
  return n;
}

const resumen = { gremios: 0, gremiosVentanaCorta: 0, descubiertos: 0, jugadores: 0, victimas: 0, cortadoPorTiempo: false };
async function barrerGremio(g) {
  for (let offset = 0; offset <= 1000; offset += 51) {
    const evs = await pedir(`${BASE}/events?guildId=${encodeURIComponent(g)}&limit=51&offset=${offset}`);
    if (!Array.isArray(evs)) return;
    guardar(evs);
    if (evs.length < 51) return; // se acabó su historia
    if (Date.parse(evs.at(-1).TimeStamp) < DESDE) return; // ya pasó el comienzo del hueco
    if (Date.parse(evs[0].TimeStamp) < DESDE) return;
  }
  resumen.gremiosVentanaCorta++; // la ventana de 1.051 no llegó al comienzo: el resto queda para el barrido por id
}
const avance = (etapa) => console.log(`${new Date().toISOString()} ${etapa} · rescatadas ${rescatados.size} · pedidos ${cuenta.pedidos} · 429 ${cuenta.r429} · ${((Date.now() - inicio) / 60000).toFixed(1)} min`);

for (const g of misGremios) {
  if (sinTiempo()) { resumen.cortadoPorTiempo = true; break; }
  await barrerGremio(g);
  if (++resumen.gremios % 50 === 0) avance(`gremios ${resumen.gremios}/${misGremios.length}`);
}
// Los descubiertos se agregan mientras se recorren (un gremio nuevo puede llevar a otro).
for (let i = 0; i < descubiertosGremios.length && !sinTiempo(); i++) {
  await barrerGremio(descubiertosGremios[i]);
  if (++resumen.descubiertos % 50 === 0) avance(`descubiertos ${resumen.descubiertos}/${descubiertosGremios.length}`);
}
for (const [lista, campo] of [[misJugadores, 'jugadores'], [victimasSinGremio, 'victimas']]) {
  for (let i = 0; i < lista.length; i++) {
    if (sinTiempo()) { resumen.cortadoPorTiempo = true; break; }
    guardar(await pedir(`${BASE}/players/${encodeURIComponent(lista[i])}/kills`));
    if (++resumen[campo] % 100 === 0) avance(`${campo} ${resumen[campo]}/${lista.length}`);
  }
}
avance('fin del barrido');

// ---- 5. Líneas con las funciones de scrape.js ----
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'scrape.js'), 'utf8');
const tomar = (desde, hasta) => {
  const a = src.indexOf(desde);
  const b = src.indexOf(hasta, a);
  if (a < 0 || b < 0) throw new Error(`scrape.js cambió: no está «${desde}»`);
  return src.slice(a, b + hasta.length);
};
const { toKillLine, extractEquipment } = new Function([
  tomar('function toKillLine(event) {', '\n}\n'),
  tomar('const SLOTS = [', ';\n'),
  tomar('function compactEquipment(eq) {', '\n}\n'),
  tomar('const VALOR_MAX =', ';\n'),
  tomar('function valorDe(items, valores) {', '\n}\n'),
  tomar('function poderDe(value) {', '\n}\n'),
  tomar('function extractEquipment(event, valores) {', '\n}\n'),
  'return { toKillLine, extractEquipment };',
].join('\n'))();
let valores = null;
try {
  const url = tomar("const VALORES_URL = '", "';").match(/'([^']+)'/)[1];
  const j = JSON.parse(await texto(`${url}/values-${REGION}.json`));
  if (j?.v === 1 && j.region === REGION && j.p) valores = j.p;
} catch {
  /* sin valores: el equipo va sin plata, igual que en scrape.js */
}

const gz = zlib.createGzip();
const fin = new Promise((r) => gz.pipe(fs.createWriteStream(OUT)).on('finish', r));
const porDia = {};
let yaEstaban = 0;
for (const e of [...rescatados.values()].sort((a, b) => a.EventId - b.EventId)) {
  // PRUEBA_INCLUIR_GUARDADAS=1 solo para comparar con las líneas que ya escribió scrape.js (nunca en el workflow).
  if (yaGuardados.has(e.EventId) && process.env.PRUEBA_INCLUIR_GUARDADAS !== '1') { yaEstaban++; continue; }
  const d = dia(Date.parse(e.TimeStamp));
  porDia[d] = (porDia[d] ?? 0) + 1;
  gz.write(JSON.stringify({ d, k: toKillLine(e), q: extractEquipment(e, valores) }) + '\n');
}
gz.end();
await fin;
const final = { region: REGION, shard: SHARD, shards: SHARDS, desde: new Date(DESDE).toISOString(), hasta: new Date(HASTA).toISOString(), rescatadas: rescatados.size, yaEstaban, nuevas: rescatados.size - yaEstaban, porDia, valores: Boolean(valores), ...resumen, ...cuenta, minutos: Math.round((Date.now() - inicio) / 60000) };
fs.writeFileSync(OUT.replace(/\.ndjson\.gz$/, '.json'), JSON.stringify(final, null, 1));
console.log('RESUMEN', JSON.stringify(final));
