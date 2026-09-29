import { promises as fs } from 'fs';
import path from 'path';

/** 2026-09-29: hasta hoy "europe" apuntaba al host de América y "americas" al de Europa (confirmado
 * por IDs de evento —Europa abrió en 2024 y tiene los más bajos— y por horas pico). Europa es
 * `gameinfo-ams` (Ámsterdam) y América es `gameinfo`. Ver `carpetaDeRegion` para el historial. */
const REGION_HOSTS = {
  europe: 'https://gameinfo-ams.albiononline.com',
  americas: 'https://gameinfo.albiononline.com',
  asia: 'https://gameinfo-sgp.albiononline.com',
};

/** Los archivos del repo histórico anteriores al 01/10/2026 quedaron con Europa y América cruzados.
 * Para que cada día quede entero y coherente, hasta el 30/09 se sigue escribiendo en la carpeta de
 * siempre (la cruzada); desde el 01/10 cada región va a la suya. La app, las Functions y el proceso
 * de estadísticas leen con la misma regla. */
const PRIMER_DIA_REGIONES_CORRECTAS = '2026-10-01';
function carpetaDeRegion(region, fecha) {
  if (fecha >= PRIMER_DIA_REGIONES_CORRECTAS) return region;
  return region === 'europe' ? 'americas' : region === 'americas' ? 'europe' : region;
}

/** Mismos hosts que usa la app (`src/services/albion-data.ts`) para AODP (solo oro). */
const AODP_HOSTS = {
  americas: 'https://west.albion-online-data.com',
  asia: 'https://east.albion-online-data.com',
  europe: 'https://europe.albion-online-data.com',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EVENTS_LIMIT = 51;
const BATTLES_LIMIT = 20;
const DATA_DIR = 'data';

/** 2026-09-21: `limit` mayor a 51 lo rechaza el servidor con 400 (probado en vivo: 100/200/500
 * fallan, 51 pasa) y `offset` deja de aceptarse pasando 1000 (1020 devuelve 400). O sea que la
 * ventana MÁXIMA que la API pública expone son 1051 eventos — nada de "traer el torneo entero en
 * una sola llamada": acá el servidor no lo permite. Lo que sí se puede es paginar DENTRO de esa
 * ventana solo cuando hace falta.
 *
 * Por qué hace falta: medido en vivo el mismo día, la ventana completa de 1.051 eventos de Europa
 * abarcaba 624 segundos, o sea ~101 eventos por minuto, contra las 51 que traía una sola página.
 * Corriendo cada 60s con una sola página, más de la mitad de las kills de Europa se perdían sin
 * que nada lo avisara. (Américas ~20/min y Asia ~44/min sí entraban en una página, pero Asia
 * queda al borde.) Ahora se pagina hasta REENCONTRAR un evento ya guardado: en una región
 * tranquila sigue siendo 1 sola llamada, y en una región cargada gasta las que de verdad hagan
 * falta. Si se agota la ventana sin reencontrar nada, se avisa fuerte: eso significa que el
 * intervalo de 60s ya no alcanza ni con paginado y hay que bajarlo. */
const EVENTS_MAX_OFFSET = 1000;
const EVENTS_PAGE_PAUSE_MS = 120;

/** 2026-09-29: los PRECIOS salieron de este scraper. Los tiene el escáner de mercado
 * (`albion-world-radar`): todo el catálogo con encantamientos cada 30 min, 180 días de historial por
 * ítem desde la API y los resultados que usa la app. Acá solo quedan kills, peleas, equipo y oro.
 *
 * Nota vieja (se conserva por el contexto). Precios/oro NO van más en el ciclo de 60s. Dos razones medidas, no estimadas:
 * 1) El histórico solo registra cambios reales, y el propio catálogo de AODP se refresca por
 *    aportes de jugadores, no por segundo — revisar 3.694 items × 8 ciudades × 3 regiones cada
 *    minuto eran ~45 requests por minuto (≈1,9 millones al mes) contra una API pública gratis
 *    ajena, para capturar cambios que no ocurren a esa velocidad.
 * 2) Nada de la app lee `data/prices`, `data/price-history`, `data/gold` ni `data/guild-stats`:
 *    la app y las Functions solo leen `data/kills` y `data/battles`. Se mantiene la captura
 *    porque el dueño pidió explícitamente acumular histórico de precios para análisis futuro,
 *    pero a cadencia horaria, que es la que el dato realmente tiene. */
const SLOW_TASKS_INTERVAL_MS = 60 * 60 * 1000;
const STATE_PATH = path.join(DATA_DIR, 'state.json');

/** 2026-09-21: este repo llegó a 9,9 GB contra un límite blando de 5 GB de GitHub, y crecía ~84 MB
 * por día entre las tres regiones. Borrar archivos NO lo achica: el historial de git conserva cada
 * versión de cada blob (árbol de trabajo 4,2 GB, repo 9,9 GB). Así que no se migra nada — este
 * repo queda como archivo histórico de julio a septiembre y, del corte en adelante, kills y
 * battles de cada región se escriben en su propio repo mensual, que nace vacío.
 *
 * `DATA_REPOS_DIR` lo prepara el workflow: adentro hay un clon por región del repo de ESTE mes.
 * Si la variable no está (falta el token que permite escribir en otros repos), todo sigue
 * exactamente como antes, escribiendo acá. Esa es la invariante que hace que este cambio no pueda
 * romper nada: sin token, comportamiento idéntico al de siempre, y del lado de la app hay además
 * un respaldo que vuelve a pedirle a este repo si el mensual no tiene el archivo. */
const PRIMER_DIA_REPOS_MENSUALES = '2026-10-01';
const DATA_REPOS_DIR = process.env.DATA_REPOS_DIR || '';

/** Dónde guardar el NDJSON de un día: en el repo mensual de esa región si corresponde, o en la
 * ruta de siempre de este repo. */
function rutaDeDia(tipo, region, fecha) {
  if (DATA_REPOS_DIR && fecha >= PRIMER_DIA_REPOS_MENSUALES) {
    return path.join(DATA_REPOS_DIR, region, tipo, `${fecha}.ndjson`);
  }
  return path.join(DATA_DIR, tipo, carpetaDeRegion(region, fecha), `${fecha}.ndjson`);
}

/** 2026-07-25: se cayó Firestore (cuota gratis de 20.000 escrituras/día se agotaba a mitad de
 * día corriendo cada 60s, ver `docs/handoff.md` de la app). Reemplazado por archivos dentro de
 * este mismo repo git — commit/push periódico en `scrape.yml`, no acá. Kills/peleas se acumulan
 * deduplicados por id en NDJSON diario por región; precios/oro son snapshot + histórico de
 * cambios; el índice de gremios/jugadores se acumula incrementalmente, solo con peleas nuevas.
 *
 * CORRECCIÓN 2026-07-25 (mismo día, el usuario lo confirmó con albionbb.com/battles/...): daño
 * hecho y curación SÍ existen en la API pública — estaban en el lugar equivocado. `/battles` (el
 * endpoint agregado) NO los trae, pero cada kill individual de `/events` sí: `event.Participants[]`
 * trae `DamageDone`/`SupportHealingDone` por jugador, y `event.BattleId` asocia esa kill a su
 * pelea. Verificado con la API real antes de este cambio (`Participants` con `DamageDone`>0 y
 * `SupportHealingDone`>0 en el pool en vivo). No repetir la afirmación de que esto no existe. */

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
  return res.json();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function readNdjson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** 2026-09-21: el `git pull --rebase` del workflow dejó marcadores de conflicto (`<<<<<<< HEAD`)
 * DENTRO de los archivos de datos el 2026-07-28 y `git add data` los commiteó. Desde entonces
 * `JSON.parse` tiraba en cada corrida, la excepción se comía en el `try/catch` de `main()`, y
 * precios, oro y guild-stats quedaron MUERTOS durante ocho semanas sin que nada lo avisara —
 * mientras se seguían gastando las ~45 llamadas por minuto a AODP igual, porque el fetch pasa
 * antes de la lectura del archivo. Ahora un archivo corrupto no mata el paso: se avisa y se
 * arranca de cero, que es recuperable, en vez de quedar en un fallo silencioso permanente. */
function hasConflictMarkers(raw) {
  return /^(<{7} |={7}$|>{7} )/m.test(raw);
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (hasConflictMarkers(raw)) {
      console.error(`[corrupto] ${filePath} tiene marcadores de conflicto de git — se regenera desde cero.`);
      return fallback;
    }
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    console.error(`[corrupto] ${filePath} no se pudo leer (${err.message}) — se regenera desde cero.`);
    return fallback;
  }
}

/** Agrega solo las entradas cuyo `idKey` todavía no está en el archivo — evita duplicar la misma
 * kill/pelea/precio de oro si sigue apareciendo en el pool de la API en la siguiente corrida.
 * Devuelve las entradas realmente nuevas (no solo el conteo) para poder encadenar agregados. */
async function appendUniqueNdjson(filePath, newEntries, idKey) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readNdjson(filePath);
  const seen = new Set(existing.map((e) => e[idKey]));
  const toAppend = newEntries.filter((e) => !seen.has(e[idKey]));
  if (toAppend.length === 0) return [];
  const lines = toAppend.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.appendFile(filePath, lines, 'utf8');
  return toAppend;
}

function extractBattleEntry(battle) {
  const guilds = Object.values(battle.guilds ?? {}).map((g) => ({
    id: g.id,
    name: g.name,
    kills: g.kills ?? 0,
    deaths: g.deaths ?? 0,
    killFame: g.killFame ?? 0,
    alliance: g.alliance ?? '',
  }));
  const players = Object.values(battle.players ?? {}).map((p) => ({
    id: p.id,
    name: p.name,
    guildId: p.guildId ?? '',
    guildName: p.guildName ?? '',
    kills: p.kills ?? 0,
    deaths: p.deaths ?? 0,
    killFame: p.killFame ?? 0,
  }));
  return {
    battleId: battle.id,
    startTime: battle.startTime,
    totalKills: battle.totalKills ?? 0,
    totalFame: battle.totalFame ?? 0,
    guilds,
    players,
  };
}

/** 2026-09-29: `data/guild-stats/<region>.json` (5-10 MB por región) se reescribía ENTERO cada minuto
 * y se commiteaba cada 15 min: era la causa principal de que este repo pasara de 10 GB. Ya no se
 * actualiza acá: las estadísticas de gremio (24 h, 7 días, mes, total, rivales) las calcula una
 * Cloud Function de la app a partir de `kills` y `battles`, que ya se guardan. Los archivos viejos
 * quedan como archivo histórico. */

/** Pagina el feed de eventos hasta reencontrar un `EventId` que ya está guardado — ver la nota
 * de `EVENTS_MAX_OFFSET`. Devuelve los eventos nuevos y si se agotó la ventana de la API sin
 * llegar a terreno conocido (o sea: hubo pérdida real y hay que avisar). */
function offsetsDeEventos() {
  // `offset` avanza de a una página, pero el último salto se recorta a 1000 en vez de saltárselo:
  // con paso de 51 la secuencia natural es 0,51,…,969,1020, y 1020 el servidor lo rechaza con
  // 400. Sin este recorte se perdería justo la franja más vieja de la ventana (la que importa
  // cuando venimos atrasados), que es el único momento en que se pagina tan hondo.
  const offsets = [];
  for (let offset = 0; offset < EVENTS_MAX_OFFSET; offset += EVENTS_LIMIT) offsets.push(offset);
  offsets.push(EVENTS_MAX_OFFSET);
  return offsets;
}

async function fetchNewEvents(base, region, knownIds) {
  const nuevos = [];
  const offsets = offsetsDeEventos();
  for (let i = 0; i < offsets.length; i += 1) {
    const page = await fetchJson(`${base}/api/gameinfo/events?limit=${EVENTS_LIMIT}&offset=${offsets[i]}`);
    if (!Array.isArray(page) || page.length === 0) return { nuevos, agotada: false, paginas: i + 1 };
    let alcanzado = false;
    for (const event of page) {
      if (knownIds.has(event.EventId)) {
        alcanzado = true;
        break;
      }
      nuevos.push(event);
    }
    // Primera corrida del día (archivo vacío): no hay nada conocido con qué cortar, así que se
    // toma una sola página y el corte lo pone la corrida siguiente. Sin esto, cada arranque de
    // día bajaría las 21 páginas completas de las 3 regiones sin necesidad.
    if (alcanzado || knownIds.size === 0) return { nuevos, agotada: false, paginas: i + 1 };
    await sleep(EVENTS_PAGE_PAUSE_MS);
  }
  return { nuevos, agotada: true, paginas: offsets.length };
}

async function scrapeRegion(region) {
  const base = REGION_HOSTS[region];
  const date = todayStr();
  const killsPath = rutaDeDia('kills', region, date);
  const knownIds = new Set((await readNdjson(killsPath)).map((k) => k.eventId));
  // 2026-09-29: al empezar el día UTC el archivo de hoy está vacío y antes se tomaba UNA sola
  // página (51 eventos): en Europa (~100 kills/min) se perdían kills en cada cambio de día y las
  // que sí llegaban podían duplicar las últimas de ayer. Mientras hoy tenga menos de una ventana
  // completa, se suman los ids de ayer para cortar en el lugar exacto.
  if (knownIds.size < EVENTS_MAX_OFFSET + EVENTS_LIMIT) {
    const ayer = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    for (const k of await readNdjson(rutaDeDia("kills", region, ayer))) knownIds.add(k.eventId);
  }

  const [eventsResult, battles] = await Promise.all([
    fetchNewEvents(base, region, knownIds),
    fetchJson(`${base}/api/gameinfo/battles?range=day&limit=${BATTLES_LIMIT}&offset=0&sort=recent`),
  ]);
  const events = eventsResult.nuevos;
  if (eventsResult.agotada) {
    console.error(`[${region}] AVISO: se agotó la ventana de la API (~${EVENTS_MAX_OFFSET + EVENTS_LIMIT} eventos) sin reencontrar nada conocido — se PERDIERON kills. Bajar el intervalo del ciclo.`);
  }

  const kills = events.map((event) => ({
    eventId: event.EventId,
    battleId: event.BattleId ?? null,
    timestamp: event.TimeStamp,
    killerName: event.Killer?.Name ?? '',
    killerGuild: event.Killer?.GuildName ?? '',
    victimName: event.Victim?.Name ?? '',
    victimGuild: event.Victim?.GuildName ?? '',
    totalFame: event.TotalVictimKillFame ?? 0,
    participantsCount: event.numberOfParticipants ?? 1,
    // Daño/curación por jugador en ESTA kill puntual (no de la pelea completa) — sumando esto a
    // través de todas las kills con el mismo battleId se arma el total por pelea, igual que hace
    // albionbb.com.
    participants: (event.Participants ?? []).map((p) => ({
      id: p.Id,
      name: p.Name,
      guildId: p.GuildId ?? '',
      guildName: p.GuildName ?? '',
      damageDone: p.DamageDone ?? 0,
      healingDone: p.SupportHealingDone ?? 0,
    })),
  }));

  const battleEntries = battles.map(extractBattleEntry);

  const newKills = await appendUniqueNdjson(killsPath, kills, 'eventId');
  const newBattles = await appendUniqueNdjson(rutaDeDia('battles', region, date), battleEntries, 'battleId');
  // Equipo de asesino y víctima en un archivo APARTE (los teléfonos bajan `kills` al buscar un
  // jugador y no deben cargar esto): lo usa la Cloud Function de Meta Armory para estadísticas de
  // armas con TODO el historial en vez de una muestra.
  const nuevosIds = new Set(newKills.map((k) => k.eventId));
  const valores = await valoresDeMercado(region);
  const equipo = events.filter((e) => nuevosIds.has(e.EventId)).map((e) => extractEquipment(e, valores));
  const newEquipment = await appendUniqueNdjson(rutaDeDia('equipment', region, date), equipo, 'e');
  console.log(`[${region}] +${newKills.length} kills nuevas, +${newBattles.length} peleas nuevas, +${newEquipment.length} equipos (${eventsResult.paginas} página(s) de eventos).`);
  return { newKills: newKills.length, newBattles: newBattles.length, pages: eventsResult.paginas, lostWindow: eventsResult.agotada };
}

/** Orden fijo de ranuras: [arma, mano izquierda, cabeza, pecho, pies, capa, montura]. Sin calidad ni
 * consumibles a propósito: Europa pasa de 140.000 kills por día y cada byte por línea cuenta
 * (~290 B por kill así, contra ~400 B con todo). */
const SLOTS = ['MainHand', 'OffHand', 'Head', 'Armor', 'Shoes', 'Cape', 'Mount'];

/** 2026-09-29 (pedido del dueño): el ítem COMPLETO con tier y encantamiento (`T8_2H_CLAYMORE@3` =
 * 8.3), para "arma y build favorita" por jugador. La montura va solo con su base. Antes de este
 * cambio las líneas guardaban solo la base (`2H_CLAYMORE`): los lectores distinguen por /^T\d_/. */
function compactEquipment(eq) {
  return SLOTS.map((slot) => {
    const type = eq?.[slot]?.Type ?? '';
    return slot === 'Mount' ? type.replace(/^T\d_/, '').replace(/@\d$/, '') : type;
  });
}

/** Valor de mercado por ítem que publica el escáner del Radar (`values-<región>.json`: mediana entre
 * ciudades del promedio de 30 días). Se baja una vez por vuelta y región; si falla, el equipo se
 * guarda sin valor (esto nunca frena al scraper). */
const VALORES_URL = 'https://raw.githubusercontent.com/Johandiaz777/albion-world-radar/data';
const valoresCache = new Map();
async function valoresDeMercado(region) {
  if (valoresCache.has(region)) return valoresCache.get(region);
  let p = null;
  try {
    const res = await fetch(`${VALORES_URL}/values-${region}.json`);
    const json = res.ok ? await res.json() : null;
    if (json?.v === 1 && json.region === region && json.p && typeof json.p === 'object') p = json.p;
  } catch {
    /* sin valores esta vuelta */
  }
  valoresCache.set(region, p);
  return p;
}

/** Plata estimada de ítems de la API (`Type` + `Count`) con los valores de mercado. */
function valorDe(items, valores) {
  let total = 0;
  for (const it of items) {
    const v = it?.Type ? valores[it.Type] : 0;
    if (v > 0) total += v * Math.max(1, it.Count ?? 1);
  }
  return Math.round(total);
}

/** Una línea por kill, compacta: `e` evento, `k`/`v` equipo de asesino y víctima (ver SLOTS),
 * `kp`/`vp` poder de objeto promedio y, si hay valores de mercado, `ve`/`vi` plata estimada del
 * equipo y del inventario de la víctima (el botín posible y lo que perdió quien murió). */
function extractEquipment(event, valores) {
  const line = {
    e: event.EventId,
    k: compactEquipment(event.Killer?.Equipment),
    v: compactEquipment(event.Victim?.Equipment),
    kp: Math.round(event.Killer?.AverageItemPower ?? 0),
    vp: Math.round(event.Victim?.AverageItemPower ?? 0),
  };
  if (valores) {
    line.ve = valorDe(Object.values(event.Victim?.Equipment ?? {}), valores);
    line.vi = valorDe(event.Victim?.Inventory ?? [], valores);
  }
  return line;
}

/** Precio del oro (`/api/v2/stats/gold.json`, endpoint documentado de AODP nunca usado hasta
 * ahora — ver `plan-accion-2026-07-23.md` Bajo costo #16). Granularidad horaria propia de la API,
 * dedupe por timestamp evita repetir la misma hora en corridas sucesivas. */
async function scrapeGold(region) {
  const base = AODP_HOSTS[region];
  const entries = await fetchJson(`${base}/api/v2/stats/gold.json?count=24`);
  const filePath = path.join(DATA_DIR, 'gold', `${region}.ndjson`);
  const added = await appendUniqueNdjson(filePath, entries, 'timestamp');
  console.log(`[${region}] +${added.length} precios de oro nuevos.`);
  return added.length;
}

/** Salud del scraper para el panel de admin (`data/status.json`, ~1 KB): última vuelta buena y
 * último error de cada tarea y región. Se escribe cada vuelta; si una región falla, su entrada
 * conserva la última vuelta buena y agrega el error. */
async function writeStatus(results) {
  const statusPath = path.join(DATA_DIR, 'status.json');
  const previous = await readJson(statusPath, { regions: {} });
  const now = new Date().toISOString();
  const regions = { ...(previous.regions ?? {}) };
  for (const [region, tasks] of Object.entries(results)) {
    const prev = regions[region] ?? {};
    const next = { ...prev };
    for (const [task, result] of Object.entries(tasks)) {
      const before = prev[task] ?? {};
      next[task] = result.ok
        ? { ...before, ok: true, at: now, ...result.data, error: null, failures: 0 }
        : { ...before, ok: false, failedAt: now, error: result.error, failures: (before.failures ?? 0) + 1 };
    }
    regions[region] = next;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(statusPath, JSON.stringify({ updatedAt: now, regions }));
}

/** 2026-07-26: se sacó el borrado automático de 30 días (decisión explícita del usuario — quiere
 * todo el histórico posible para análisis/predicción de precios a futuro, no una ventana rotativa).
 * `pruneOldFiles`/`RETENTION_DAYS` existieron acá (reemplazaban el TTL de Firestore) — se
 * eliminaron en vez de dejarlos sin uso. Nada se borra ya: kills/battles/price-history crecen sin
 * límite en NDJSON diario, igual que gold (que nunca tuvo rotación) y el acumulado de guild-stats.
 * Si el repo se vuelve pesado con el tiempo, revisar entonces — no reintroducir esto sin que el
 * usuario lo pida. */

async function main() {
  const state = await readJson(STATE_PATH, {});
  const ahora = Date.now();
  const tocaLento = !state.lastSlowRun || ahora - Date.parse(state.lastSlowRun) >= SLOW_TASKS_INTERVAL_MS;

  const results = {};
  for (const region of Object.keys(REGION_HOSTS)) {
    results[region] = {};
    try {
      const r = await scrapeRegion(region);
      results[region].kills = { ok: true, data: r };
      // Siempre se escribe (también null): antes el aviso quedaba pegado en status.json aunque ya no pasara.
      results[region].kills.data.warning = r.lostWindow ? 'se agotó la ventana de la API: se perdieron kills' : null;
      if (r.lostWindow) results[region].kills.data.lastLostWindowAt = new Date().toISOString();
    } catch (err) {
      // Una región caída no debe tumbar el resto — cada región es independiente.
      console.error(`[${region}] error:`, err.message);
      results[region].kills = { ok: false, error: String(err.message).slice(0, 200) };
    }
    if (!tocaLento) continue;
    try {
      results[region].gold = { ok: true, data: { added: await scrapeGold(region) } };
    } catch (err) {
      console.error(`[${region}] oro error:`, err.message);
      results[region].gold = { ok: false, error: String(err.message).slice(0, 200) };
    }
  }
  try {
    await writeStatus(results);
  } catch (err) {
    console.error('status.json no se pudo escribir:', err.message);
  }

  if (tocaLento) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify({ ...state, lastSlowRun: new Date(ahora).toISOString() }));
  } else {
    console.log('Oro se saltea esta vuelta (cadencia horaria).');
  }
}

main().then(() => process.exit(0));
