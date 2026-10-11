import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileP = promisify(execFile);

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

/** Tiempo máximo por pedido: sin esto, un pedido colgado frenaba la vuelta hasta 5 min (el límite de
 * undici) y con ella las tres regiones. */
const FETCH_TIMEOUT_MS = 60_000;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
  return res.json();
}

/** 2026-10-03: la caché de Albion declara `max-age=60` (eventos) y `max-age=300` (peleas), pero a
 * veces se TRABA en una dirección exacta y la sigue sirviendo horas. Medido ese día a las 03:08 UTC:
 * `events?limit=51&offset=0` de Europa con `Age: 1955` (kill más nueva 01:56, mientras el origen
 * traía las de hace 10 min) y `battles?...limit=51` con `Age: 63329` (17,6 h). Con esa página vieja
 * este scraper encontraba solo kills conocidas, cortaba en la página 1 y dejaba de guardar Europa SIN
 * avisar (el archivo del día quedó en 01:56:02 más de una hora).
 *
 * Dos reglas, las dos con el encabezado `Age` (cuántos segundos tiene la copia):
 * 1) Si la copia tiene más de 3 veces su vida declarada, está trabada: se pide al origen.
 * 2) Al paginar, cada página tiene que ser IGUAL O MÁS NUEVA que la anterior (`minSnapshot`). Si
 *    la página 2 es una copia más vieja que la 1, la lista "se corrió" menos y las kills que
 *    llegaron entre ambas copias caen justo en el hueco entre la página 1 y la 2: se saltaban sin
 *    aviso (y el corte por id conocido lo tapaba). Una página más nueva solo repite kills, y esas
 *    se descartan por `eventId`.
 * El origen se pide con un parámetro único (salta la caché, ~1-15 s). Si el origen falla, se usa la
 * copia de la caché igual: la próxima vuelta reintenta. Devuelve el JSON y el momento de la copia. */
const CACHE_STALE_FACTOR = 3;
const SNAPSHOT_TOLERANCE_MS = 1500;
let cacheRefetches = 0;
async function fetchFromOrigin(url) {
  const desdeOrigen = Date.now();
  const fresh = await fetch(`${url}&_=${desdeOrigen}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!fresh.ok) throw new Error(`${url} (origen) respondió ${fresh.status}`);
  const data = await fresh.json();
  cacheRefetches += 1;
  return { data, snapshot: desdeOrigen, fromOrigin: true };
}

async function fetchFreshJson(url, maxAgeSec, minSnapshot = 0) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
  const age = Number(res.headers.get('age')) || 0;
  const snapshot = Date.now() - age * 1000;
  const trabada = age > maxAgeSec * CACHE_STALE_FACTOR;
  const atrasada = minSnapshot > 0 && snapshot < minSnapshot - SNAPSHOT_TOLERANCE_MS;
  if (!trabada && !atrasada) return { data: await res.json(), snapshot, fromOrigin: false };
  try {
    const fresh = await fetchFromOrigin(url);
    if (trabada) console.warn(`caché de Albion trabada (Age ${age} s): ${url} se pidió al origen`);
    return fresh;
  } catch {
    /* el origen no respondió: se usa la copia de la caché */
  }
  return { data: await res.json(), snapshot, fromOrigin: false };
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/** 2026-10-03 (auditoría p60): una línea dañada (escritura cortada, marcador de conflicto) ya no deja
 * muerta la captura de la región en cada vuelta: se salta con aviso y se sigue. Los lectores (stats y
 * app) ya saltaban líneas malas. */
async function readNdjson(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  let malas = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      malas += 1;
    }
  }
  if (malas > 0) console.error(`[corrupto] ${filePath}: ${malas} línea(s) que no se pudieron leer, se saltan`);
  return out;
}

/** ¿El archivo termina en salto de línea? (vacío o inexistente cuenta como sí). */
async function terminaEnSalto(filePath) {
  try {
    const fh = await fs.open(filePath, 'r');
    try {
      const { size } = await fh.stat();
      if (size === 0) return true;
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, size - 1);
      return buf[0] === 0x0a;
    } finally {
      await fh.close();
    }
  } catch {
    return true;
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
  // 2026-10-03 (parte 59): también sin repetidos DENTRO del lote. Al paginar la lista de Albion mientras
  // llegan kills nuevas, una misma kill cae al final de una página y al principio de la siguiente: desde
  // el 22/09 eso dejó entre 2,5 % y 12 % de líneas repetidas (los lectores ya las descartan por id).
  const toAppend = [];
  for (const e of newEntries) {
    if (seen.has(e[idKey])) continue;
    seen.add(e[idKey]);
    toAppend.push(e);
  }
  if (toAppend.length === 0) return [];
  // Si una escritura anterior quedó cortada (sin salto final), la línea nueva no se pega a la rota.
  const prefijo = (await terminaEnSalto(filePath)) ? '' : '\n';
  const lines = prefijo + toAppend.map((e) => JSON.stringify(e)).join('\n') + '\n';
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

async function fetchNewEvents(base, region, knownIds, lastEventId) {
  const nuevos = [];
  const offsets = offsetsDeEventos();
  // Sin ids conocidos (región nueva, o el día 1 del mes: el archivo de ayer quedó en el repo del mes
  // anterior) se corta por el último `EventId` guardado en `state.json` (los ids crecen siempre).
  const sinArchivo = knownIds.size === 0;
  const conocido = (event) => knownIds.has(event.EventId) || (sinArchivo && lastEventId > 0 && event.EventId <= lastEventId);
  let minSnapshot = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    const url = `${base}/api/gameinfo/events?limit=${EVENTS_LIMIT}&offset=${offsets[i]}`;
    let { data: page, snapshot, fromOrigin } = await fetchFreshJson(url, 60, minSnapshot);
    // 2026-10-03: el `Age` no alcanza para saber si la copia está trabada. Cada servidor de caché
    // tiene la suya y una copia vieja puede llegar con `Age` bajo (la corrida de GitHub recibió la
    // página de Europa de las 01:56 sin nada raro en el encabezado, mientras el origen ya tenía hasta
    // las 02:59). Si la primera página no trae NADA nuevo, se confirma una vez con el origen: cuesta
    // un pedido por región y minuto solo cuando no hubo kills nuevas.
    if (i === 0 && !fromOrigin && Array.isArray(page) && page.length > 0 && conocido(page[0])) {
      try {
        ({ data: page, snapshot, fromOrigin } = await fetchFromOrigin(url));
      } catch {
        /* el origen no respondió: vale lo de la caché */
      }
    }
    minSnapshot = Math.max(minSnapshot, snapshot);
    if (!Array.isArray(page) || page.length === 0) return { nuevos, agotada: false, paginas: i + 1 };
    let alcanzado = false;
    for (const event of page) {
      if (conocido(event)) {
        alcanzado = true;
        break;
      }
      nuevos.push(event);
    }
    // Sin nada con qué cortar (ni archivo ni último id): una sola página y el corte lo pone la
    // corrida siguiente. Sin esto, cada arranque bajaría las 21 páginas de las 3 regiones.
    if (alcanzado || (sinArchivo && !(lastEventId > 0))) return { nuevos, agotada: false, paginas: i + 1 };
    await sleep(EVENTS_PAGE_PAUSE_MS);
  }
  return { nuevos, agotada: true, paginas: offsets.length };
}

async function scrapeRegion(region, lastEventId) {
  const base = REGION_HOSTS[region];
  const date = todayStr();
  const killsPath = rutaDeDia('kills', region, date);
  const todays = await readNdjson(killsPath);
  const knownIds = new Set(todays.map((k) => k.eventId));
  let ayerKills = [];
  // 2026-09-29: al empezar el día UTC el archivo de hoy está vacío y antes se tomaba UNA sola
  // página (51 eventos): en Europa (~100 kills/min) se perdían kills en cada cambio de día y las
  // que sí llegaban podían duplicar las últimas de ayer. Mientras hoy tenga menos de una ventana
  // completa, se suman los ids de ayer para cortar en el lugar exacto.
  if (knownIds.size < EVENTS_MAX_OFFSET + EVENTS_LIMIT) {
    const ayer = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    ayerKills = await readNdjson(rutaDeDia("kills", region, ayer));
    for (const k of ayerKills) knownIds.add(k.eventId);
  }

  const [eventsResult, battles] = await Promise.all([
    fetchNewEvents(base, region, knownIds, lastEventId),
    fetchFreshJson(`${base}/api/gameinfo/battles?range=day&limit=${BATTLES_LIMIT}&offset=0&sort=recent`, 300).then((r) => r.data),
  ]);
  const events = eventsResult.nuevos;
  if (eventsResult.agotada) {
    console.error(`[${region}] AVISO: se agotó la ventana de la API (~${EVENTS_MAX_OFFSET + EVENTS_LIMIT} eventos) sin reencontrar nada conocido — se PERDIERON kills. Bajar el intervalo del ciclo.`);
  }

  const kills = events.map(toKillLine);

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
  const maxEventId = events.reduce((max, e) => Math.max(max, e.EventId ?? 0), lastEventId || 0);

  // Ventana agotada: las kills entre la última guardada y la más vieja que se alcanzó a leer se
  // perdieron. Las peleas de ese rato van a la cola de relleno (state.json) y se procesan de a poco.
  let gapWindow = null;
  let gapRange = null;
  if (eventsResult.agotada && events.length > 0) {
    // Rango exacto de ids perdidos: después de la kill guardada más nueva y antes de la más vieja leída.
    // Recorrido simple: Math.max(...ids) revienta con las ~140.000 kills diarias de Europa.
    let maxConocido = lastEventId || 0;
    for (const id of knownIds) if (Number.isFinite(id) && id > maxConocido) maxConocido = id;
    const minLeido = events.reduce((min, e) => Math.min(min, e.EventId), Infinity);
    if (maxConocido > 0 && minLeido - 1 > maxConocido) {
      // 2026-10-04 (auditoría p64 H3): un hueco más grande que el tope (escáner caído ~4,5 h en hora pico
      // de Europa, o estado viejo) antes se abandonaba ENTERO y sin aviso. Ahora se barren los
      // GAP_RANGE_MAX_IDS ids más nuevos (lo más valioso y lo que alcanza a rellenarse) y se avisa del resto.
      const total = minLeido - 1 - maxConocido;
      gapRange = [Math.max(maxConocido + 1, minLeido - GAP_RANGE_MAX_IDS), minLeido - 1];
      if (total > GAP_RANGE_MAX_IDS) {
        console.error(`[${region}] hueco por id de ${total} ids: se barren los ${GAP_RANGE_MAX_IDS} más nuevos; ${total - GAP_RANGE_MAX_IDS} más viejos quedan sin barrer`);
      }
      console.error(`[${region}] hueco por id: ${gapRange[0]}…${gapRange[1]} (${gapRange[1] - gapRange[0] + 1} ids a revisar)`);
    }
    const desde = ultimaKillGuardada(todays, ayerKills);
    const hasta = events.reduce((min, e) => (e.TimeStamp < min ? e.TimeStamp : min), events[0].TimeStamp);
    if (desde && desde < hasta) {
      gapWindow = [desde, hasta];
      console.error(`[${region}] hueco ${desde} → ${hasta}: sus peleas se listan en el relleno`);
    }
  }
  return { newKills: newKills.length, newBattles: newBattles.length, pages: eventsResult.paginas, lostWindow: eventsResult.agotada, maxEventId, gapWindow, gapRange };
}

/** Línea de kill del NDJSON a partir de un evento de la API. */
function toKillLine(event) {
  return {
    eventId: event.EventId,
    battleId: event.BattleId ?? null,
    timestamp: event.TimeStamp,
    killerName: event.Killer?.Name ?? '',
    killerGuild: event.Killer?.GuildName ?? '',
    victimName: event.Victim?.Name ?? '',
    // 2026-10-03: el id de la víctima (el del asesino ya viene en `participants`): el índice de
    // estadísticas lo usa para que la app abra perfiles por id, sin la búsqueda por nombre de Albion.
    victimId: event.Victim?.Id ?? '',
    victimGuild: event.Victim?.GuildName ?? '',
    totalFame: event.TotalVictimKillFame ?? 0,
    participantsCount: event.numberOfParticipants ?? 1,
    // 2026-10-05 (parte 74): la API corta numberOfParticipants y Participants en 4 (medido: ninguna kill con
    // más de 4, desde siempre), así que los filtros "6+" y "10+ ayudas" nunca tenían nada. El grupo del
    // atacante (GroupMembers) sí pasa de 4: las functions toman el mayor de los dos.
    groupSize: Array.isArray(event.GroupMembers) ? event.GroupMembers.length : 0,
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
  };
}


/** 2026-10-03 (parte 59, "nada se puede perder"): si en un minuto llegan más de 1.051 kills (lo
 * máximo que deja leer Albion: limit 51 × offset 1000), las más viejas de esa ráfaga no se alcanzan.
 * Pasó en América a las 00:40 UTC del 03/10, cuando el origen de Albion se puso al día de golpe
 * después de ~2 h de atraso. El hueco se rellena en dos pasos, siempre DESPUÉS de la captura normal:
 * 1) peleas: `/battles` lista las de 3 o más kills (medido: ninguna de 1-2) y `/events/battle/{id}`
 *    da sus kills; barato, recupera enseguida las grupales;
 * 2) barrido por id: se conoce el rango exacto de ids perdidos (entre la kill guardada más nueva y la
 *    más vieja leída) y se pide cada uno a `/events/{id}`; recupera también las sueltas (55 % de las
 *    kills). Medido: en un tramo de ids solo el 13 % son kills (el resto da 404, a veces tras 27-50 s
 *    en el origen de Albion). Probado de punta a punta: 46 de 46 kills de un hueco recuperadas,
 *    idénticas a las de la captura normal, 41 de ellas sueltas.
 * El límite de Albion es por IP y para TODA la API (tras ~70 pedidos rápidos también la lista de kills
 * dio 429; se levanta en ~1 s): el relleno va a ritmo constante y se corta en el primer 429. Un hueco
 * de 1.000 kills (~7.700 ids) tarda horas en completarse, pero se completa. Todo se agrega sin
 * duplicar (por `eventId`) en el archivo del día de cada kill. */
const GAP_BATTLES_PER_RUN = 6;
/** Tiempo para LANZAR pedidos de relleno por vuelta; cada pedido puede esperar su respuesta hasta
 * FETCH_TIMEOUT_MS (60 s): un 404 en el origen de Albion tarda hasta 27-50 s (medido). Peor caso la
 * vuelta dura ~1,5 min; el workflow apunta a 1 por minuto y la ventana de 1.051 kills alcanza ~7 min de
 * Europa en hora pico, así que la captura normal no pierde nada. */
const GAP_RUN_BUDGET_MS = 30_000;
/** Si la captura normal ya tardó esto, la vuelta no rellena; y ninguna vuelta pasa de GAP_RUN_MAX_MS. */
const GAP_SKIP_IF_CAPTURE_MS = 30_000;
const GAP_RUN_MAX_MS = 95_000;
/** Un pedido cada 333 ms (3 por segundo: medido sin 429) y hasta 8 esperando respuesta: un id que
 * Albion calcula en su origen tarda 20-50 s (medido) y no debe frenar a los demás. */
const GAP_PROBE_SPACING_MS = 333;
const GAP_PROBE_MAX_IN_FLIGHT = 8;
/** Tope de ids de UN hueco: si es más grande, solo se barren los más nuevos (ver scrapeRegion). */
const GAP_RANGE_MAX_IDS = 200_000;
class LimitadoPorAlbion extends Error {}
/** Se acabó el tiempo de la vuelta para el relleno: no es un fallo de Albion, se sigue la próxima. */
class SinTiempo extends Error {}

/** Hora límite de TODO el relleno de esta vuelta (la fija `main`; auditoría p60: antes el tope solo
 * valía para el barrido por id, y la lista de peleas o una pelea lenta podían alargar la vuelta). */
let limiteRellenoMs = Infinity;

/** GET con detección del límite de Albion, sin pasar nunca de `limiteRellenoMs`. */
async function fetchRelleno(url, timeoutMs = FETCH_TIMEOUT_MS, cancelar = null) {
  const queda = limiteRellenoMs - Date.now();
  if (queda < 1000) throw new SinTiempo('sin tiempo');
  const tiempo = AbortSignal.timeout(Math.max(1000, Math.min(FETCH_TIMEOUT_MS, timeoutMs, queda)));
  let res;
  try {
    res = await fetch(url, { signal: cancelar ? AbortSignal.any([tiempo, cancelar]) : tiempo });
  } catch (err) {
    // Cortado por el tope de la vuelta o por un 429 de otro pedido: no cuenta como fallo.
    if (cancelar?.aborted || limiteRellenoMs - Date.now() < 1500) throw new SinTiempo('cortado');
    throw err;
  }
  if (res.status === 429) throw new LimitadoPorAlbion('429');
  return res;
}

/** Tope de ids pendientes por región (auditoría p60: la lista crecía sin cota en sobrecarga). A ~90 ids
 * por vuelta son ~2 días de barrido; más viejo que eso no se llega a rellenar a tiempo. */
const GAP_PENDING_MAX_IDS = 300_000;

/** Une rangos que se tocan, ordena del más nuevo al más viejo y descarta (con aviso) lo que pase del tope. */
function topearRangos(region, rangos) {
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
    const cabe = Math.min(hi - lo + 1, GAP_PENDING_MAX_IDS - total);
    if (cabe <= 0) break;
    out.push([hi - cabe + 1, hi]); // se queda con la parte más nueva del rango
    total += cabe;
  }
  const todos = unidos.reduce((n, [lo, hi]) => n + hi - lo + 1, 0);
  if (todos > total) console.error(`[${region}] relleno: más de ${GAP_PENDING_MAX_IDS} ids pendientes; se descartan ${todos - total} de los más viejos`);
  return out;
}

/** Un tramo que falla (no 404) se reintenta; después de tantas vueltas seguidas se salta y se avisa. */
const GAP_PROBE_MAX_FAILS = 10;
const GAP_QUEUE_MAX = 400;
const GAP_LIST_MAX_OFFSET = 1000;

/** Hora de la kill guardada más nueva (hoy o, si hoy está vacío, ayer). */
function ultimaKillGuardada(todays, ayerKills) {
  let max = '';
  for (const k of todays.length > 0 ? todays : ayerKills) if (k.timestamp > max) max = k.timestamp;
  return max || null;
}

/** Ids de las peleas que se cruzan con [desde, hasta] (ISO), de la más nueva a la más vieja. */
async function peleasDelHueco(base, desde, hasta) {
  const ids = [];
  for (let offset = 0; offset <= GAP_LIST_MAX_OFFSET; offset += 51) {
    // Al origen (parámetro único): una copia trabada de la caché escondería las peleas del hueco.
    const res = await fetchRelleno(`${base}/api/gameinfo/battles?range=day&limit=51&offset=${offset}&sort=recent&_=${Date.now()}`);
    if (!res.ok) throw new Error(`battles respondió ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    for (const b of data) {
      const fin = b.endTime ?? b.startTime;
      if (b.startTime <= hasta && fin >= desde) ids.push(b.id);
    }
    // La lista va de la más reciente hacia atrás: pasado el comienzo del hueco, no hay más.
    if (data[data.length - 1].startTime < desde) break;
    await sleep(EVENTS_PAGE_PAUSE_MS);
  }
  return ids;
}

/** Kills de una pelea (todas sus páginas). */
async function killsDePelea(base, battleId) {
  const out = [];
  for (let offset = 0; offset <= EVENTS_MAX_OFFSET; offset += 51) {
    const res = await fetchRelleno(`${base}/api/gameinfo/events/battle/${battleId}?offset=${offset}&limit=51`);
    if (!res.ok) throw new Error(`events/battle/${battleId} respondió ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 51) break;
    await sleep(EVENTS_PAGE_PAUSE_MS);
  }
  return out;
}

/** 2026-10-03 (auditoría p60, probado con git 2.53 en Linux): el checkout de los repos mensuales solo
 * trae hoy y ayer. Un archivo de anteayer escrito "desde cero" queda FUERA del checkout: `git add -A`
 * lo ignora y esas kills nunca se suben (y el commit vacío fallaba). Por eso:
 * - día más viejo del MISMO mes → se habilita en el checkout (`sparse-checkout add`, trae el archivo
 *   completo) y se agrega ahí;
 * - día de OTRO mes (relleno del 31 hecho el 1.º) → ese repo no está en el disco: va al archivo de hoy
 *   (cuenta en hoy, pero no se pierde);
 * - si habilitarlo falla, también va a hoy. */
async function fechaDeGuardado(region, fecha) {
  if (!DATA_REPOS_DIR) return fecha;
  const hoy = todayStr();
  const ayer = new Date(Date.parse(hoy) - 86_400_000).toISOString().slice(0, 10);
  if (fecha > hoy) return hoy;
  // Antes de los repos mensuales (ruta vieja de este repo, tampoco está en su checkout) u otro mes.
  if (fecha < PRIMER_DIA_REPOS_MENSUALES || fecha.slice(0, 7) !== hoy.slice(0, 7)) {
    console.warn(`[${region}] kills recuperadas del ${fecha} (otro mes): se guardan en el archivo de hoy`);
    return hoy;
  }
  if (fecha === hoy || fecha === ayer) return fecha;
  const repo = path.join(DATA_REPOS_DIR, region);
  try {
    await fs.access(path.join(repo, 'kills', `${fecha}.ndjson`));
    return fecha; // ya habilitado en esta corrida
  } catch {
    /* hay que habilitarlo */
  }
  try {
    await execFileP('git', ['-C', repo, 'sparse-checkout', 'add', `/kills/${fecha}.ndjson`, `/equipment/${fecha}.ndjson`], { timeout: 60_000 });
    console.log(`[${region}] ${fecha} habilitado en el checkout para guardar kills recuperadas`);
    return fecha;
  } catch (err) {
    console.error(`[${region}] no se pudo habilitar ${fecha} (${String(err.message).slice(0, 120)}): se guardan en el archivo de hoy`);
    return hoy;
  }
}

/** Escribe eventos recuperados en el archivo del día de cada uno (kills y equipo), sin duplicar: un
 * solo `appendUniqueNdjson` por día y tipo. Devuelve cuántas kills eran nuevas. */
async function guardarRecuperadas(region, events) {
  const valores = await valoresDeMercado(region);
  const porDia = new Map();
  for (const e of events) {
    const dia = String(e?.TimeStamp ?? '').slice(0, 10);
    if (!Number.isFinite(e?.EventId) || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) continue;
    const fecha = await fechaDeGuardado(region, dia);
    if (!porDia.has(fecha)) porDia.set(fecha, new Map());
    porDia.get(fecha).set(e.EventId, e);
  }
  let nuevasTotal = 0;
  for (const [fecha, mapa] of porDia) {
    const evs = [...mapa.values()];
    const nuevas = await appendUniqueNdjson(rutaDeDia('kills', region, fecha), evs.map(toKillLine), 'eventId');
    if (nuevas.length === 0) continue;
    nuevasTotal += nuevas.length;
    const ids = new Set(nuevas.map((k) => k.eventId));
    await appendUniqueNdjson(rutaDeDia('equipment', region, fecha), evs.filter((e) => ids.has(e.EventId)).map((e) => extractEquipment(e, valores)), 'e');
  }
  return nuevasTotal;
}

/** Un evento por id: el evento, `null` si no existe (404: ese id no es una kill), o lanza si falla
 * (`LimitadoPorAlbion` si respondió 429). */
async function eventoPorId(base, id, timeoutMs, cancelar = null) {
  const res = await fetchRelleno(`${base}/api/gameinfo/events/${id}`, timeoutMs, cancelar);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`events/${id} respondió ${res.status}`);
  return res.json();
}

/** Barre los rangos de ids pendientes de la región, del más nuevo hacia atrás, con presupuesto de
 * tiempo hasta `hastaMs`. El rango avanza solo hasta el primer id sin respuesta clara (kill o 404):
 * lo que tardó, falló o recibió 429 se repite la vuelta siguiente, así no se salta nada por un fallo
 * de red. Devuelve los rangos que quedan, las kills recuperadas, el estado de fallos y si hubo 429. */
async function barrerIds(region, rangos, fallos = 0, hastaMs = Date.now() + GAP_RUN_BUDGET_MS, limiteRespuestaMs = hastaMs + FETCH_TIMEOUT_MS) {
  const base = REGION_HOSTS[region];
  const pendientes = rangos.map((r) => [...r]).filter(([lo, hi]) => hi >= lo);
  // Ids en orden (del más nuevo hacia atrás, rango por rango), generados a medida que se piden.
  const orden = [];
  let ri = 0;
  let cursor = pendientes[0]?.[1];
  const siguienteId = () => {
    while (ri < pendientes.length) {
      if (cursor >= pendientes[ri][0]) return cursor--;
      ri += 1;
      cursor = pendientes[ri]?.[1];
    }
    return null;
  };
  const resultado = new Map(); // id → 'kill' | 'no' | 'limite' | 'error'
  const halladas = [];
  const enVuelo = new Set();
  // Al primer 429 se cortan los que esperaban (auditoría p60): seguir esperándolos solo alargaba la
  // vuelta; quedan sin confirmar y se repiten la próxima.
  const cancelar = new AbortController();
  let limitado = false;
  while (!limitado && Date.now() < hastaMs - 1000) {
    if (enVuelo.size >= GAP_PROBE_MAX_IN_FLIGHT) {
      await Promise.race(enVuelo);
      continue;
    }
    const id = siguienteId();
    if (id === null) break;
    orden.push(id);
    const p = eventoPorId(base, id, Math.max(10_000, limiteRespuestaMs - Date.now()), cancelar.signal)
      .then((ev) => {
        resultado.set(id, ev ? 'kill' : 'no');
        if (ev) halladas.push(ev);
      })
      .catch((err) => {
        if (err instanceof LimitadoPorAlbion) {
          resultado.set(id, 'limite');
          limitado = true;
          cancelar.abort();
        } else if (err instanceof SinTiempo) resultado.set(id, 'limite');
        else resultado.set(id, 'error');
      })
      .finally(() => enVuelo.delete(p));
    enVuelo.add(p);
    await sleep(GAP_PROBE_SPACING_MS);
  }
  await Promise.allSettled([...enVuelo]);

  // Avance: hasta el primer id sin respuesta clara (kill o 404). Un error repetido GAP_PROBE_MAX_FAILS
  // vueltas seguidas en el mismo id hace saltar SOLO ese id (con aviso); un 429 no cuenta como fallo.
  let avanzados = 0;
  let paroPorError = false;
  for (const id of orden) {
    const r = resultado.get(id);
    if (r === 'kill' || r === 'no') {
      avanzados += 1;
      continue;
    }
    if (r === 'error') {
      paroPorError = true;
      fallos += 1;
      if (fallos >= GAP_PROBE_MAX_FAILS) {
        console.error(`[${region}] barrido: el id ${id} falló ${fallos} vueltas seguidas; se salta`);
        fallos = 0;
        paroPorError = false;
        avanzados += 1;
        continue;
      }
    }
    break;
  }
  if (!paroPorError && avanzados > 0) fallos = 0;
  // Recortar los rangos según los `avanzados` primeros ids de `orden`.
  let resto = avanzados;
  while (resto > 0 && pendientes.length > 0) {
    const [lo, hi] = pendientes[0];
    const tam = hi - lo + 1;
    if (resto >= tam) {
      pendientes.shift();
      resto -= tam;
    } else {
      pendientes[0][1] = hi - resto;
      resto = 0;
    }
  }
  const recuperadas = halladas.length > 0 ? await guardarRecuperadas(region, halladas) : 0;
  const quedan = pendientes.reduce((n, [lo, hi]) => n + hi - lo + 1, 0);
  if (orden.length > 0) console.log(`[${region}] barrido por id: ${orden.length} pedidos, ${avanzados} confirmados, ${halladas.length} kills encontradas, +${recuperadas} nuevas (quedan ${quedan} ids)${limitado ? ' · Albion pidió esperar (429)' : ''}`);
  return { rangos: pendientes, recuperadas, fallos, limitado };
}

/** Procesa hasta GAP_BATTLES_PER_RUN peleas de la cola: agrega las kills que falten (y su equipo) al
 * archivo del día de cada kill. Devuelve la cola que queda y cuántas kills se recuperaron. Una pelea
 * que falla vuelve al final de la cola una sola vez más (`reintento`). */
async function rellenarHueco(region, cola, hastaMs = Date.now() + GAP_RUN_BUDGET_MS) {
  const base = REGION_HOSTS[region];
  const pendientes = [...cola];
  const tomadas = [];
  const juntas = [];
  let limitado = false;
  while (pendientes.length > 0 && tomadas.length < GAP_BATTLES_PER_RUN && Date.now() < hastaMs) {
    const item = pendientes.shift();
    tomadas.push(item);
    const battleId = typeof item === 'object' ? item.id : item;
    try {
      juntas.push(...(await killsDePelea(base, battleId)));
    } catch (err) {
      if (err instanceof LimitadoPorAlbion || err instanceof SinTiempo) {
        pendientes.unshift(item); // misma pelea, la próxima vuelta (sin contarla como fallida)
        limitado = err instanceof LimitadoPorAlbion;
        break;
      }
      console.error(`[${region}] relleno: la pelea ${battleId} falló (${err.message})`);
      if (typeof item !== 'object') pendientes.push({ id: battleId, reintento: true });
    }
  }
  const recuperadas = juntas.length > 0 ? await guardarRecuperadas(region, juntas) : 0;
  if (tomadas.length > 0) console.log(`[${region}] relleno del hueco: +${recuperadas} kills recuperadas de ${tomadas.length} peleas (quedan ${pendientes.length})`);
  return { cola: pendientes, recuperadas, limitado };
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
    // Con tope (auditoría p60): sin él, un GitHub colgado frenaba la vuelta entera.
    const res = await fetch(`${VALORES_URL}/values-${region}.json`, { signal: AbortSignal.timeout(10_000) });
    const json = res.ok ? await res.json() : null;
    if (json?.v === 1 && json.region === region && json.p && typeof json.p === 'object') p = json.p;
  } catch {
    /* sin valores esta vuelta */
  }
  valoresCache.set(region, p);
  return p;
}

/** Tope de un valor de mercado por unidad (auditoría p92 H8): un dato roto o gigante del Radar no infla
 * el botín de los perfiles. Lo más caro del juego no llega a 10.000 millones. */
const VALOR_MAX = 1e10;

/** Plata estimada de ítems de la API (`Type` + `Count`) con los valores de mercado. */
function valorDe(items, valores) {
  let total = 0;
  for (const it of items) {
    const v = it?.Type ? Number(valores[it.Type]) : 0;
    if (!(v > 0 && v < VALOR_MAX)) continue;
    // Count raro (texto, negativo): cuenta 1; una pila del juego no pasa de 999.
    const count = Math.min(999, Math.max(1, Math.floor(Number(it.Count)) || 1));
    total += v * count;
  }
  return Number.isFinite(total) ? Math.round(total) : 0;
}

/** Poder de objeto como número (auditoría p92 H8): un valor no numérico de la API daba NaN y se publicaba null. */
function poderDe(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Una línea por kill, compacta: `e` evento, `k`/`v` equipo de asesino y víctima (ver SLOTS),
 * `kp`/`vp` poder de objeto promedio y, si hay valores de mercado, `ve`/`vi` plata estimada del
 * equipo y del inventario de la víctima (el botín posible y lo que perdió quien murió). */
function extractEquipment(event, valores) {
  const line = {
    e: event.EventId,
    k: compactEquipment(event.Killer?.Equipment),
    v: compactEquipment(event.Victim?.Equipment),
    kp: poderDe(event.Killer?.AverageItemPower),
    vp: poderDe(event.Victim?.AverageItemPower),
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
  await writeFileAtomic(statusPath, JSON.stringify({ updatedAt: now, regions }));
}

/** Escribe a un temporal y lo renombra (auditoría p92 H5, misma receta que `store.mjs` del Radar y de las
 * estadísticas): si el runner muere a mitad (tope de 345 min, disco lleno), queda el archivo anterior entero
 * en vez de uno cortado que se lee como corrupto y pierde de golpe la cola de relleno de huecos. */
async function writeFileAtomic(file, data) {
  // El temporal va FUERA de data/ (en la carpeta de arriba): el workflow sube `git add data` cada ~15 min mientras
  // el scraper corre y no debe llevarse un .tmp a medio escribir. Mismo disco: el rename sigue siendo atómico.
  const tmp = path.join(path.dirname(file), '..', `.${path.basename(file)}.tmp`);
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

/** 2026-07-26: se sacó el borrado automático de 30 días (decisión explícita del usuario — quiere
 * todo el histórico posible para análisis/predicción de precios a futuro, no una ventana rotativa).
 * `pruneOldFiles`/`RETENTION_DAYS` existieron acá (reemplazaban el TTL de Firestore) — se
 * eliminaron en vez de dejarlos sin uso. Nada se borra ya: kills/battles/price-history crecen sin
 * límite en NDJSON diario, igual que gold (que nunca tuvo rotación) y el acumulado de guild-stats.
 * Si el repo se vuelve pesado con el tiempo, revisar entonces — no reintroducir esto sin que el
 * usuario lo pida. */

async function main() {
  const inicioVuelta = Date.now();
  const state = await readJson(STATE_PATH, {});
  const ahora = Date.now();
  const tocaLento = !state.lastSlowRun || ahora - Date.parse(state.lastSlowRun) >= SLOW_TASKS_INTERVAL_MS;

  const results = {};
  const lastEventIds = { ...(state.lastEventIds ?? {}) };
  const gapQueue = { ...(state.gapQueue ?? {}) };
  const gapRanges = { ...(state.gapRanges ?? {}) };
  const gapFails = { ...(state.gapFails ?? {}) };
  const gapWindows = { ...(state.gapWindows ?? {}) };
  for (const region of Object.keys(REGION_HOSTS)) {
    results[region] = {};
    try {
      const antes = cacheRefetches;
      const r = await scrapeRegion(region, Number(state.lastEventIds?.[region]) || 0);
      if (r.maxEventId > 0) lastEventIds[region] = r.maxEventId;
      delete r.maxEventId;
      // Solo se anotan los huecos: el relleno corre al final, después de las 3 regiones.
      if (r.gapWindow) {
        const ventanas = [...(gapWindows[region] ?? []), r.gapWindow];
        if (ventanas.length > 20) console.error(`[${region}] relleno: más de 20 ventanas pendientes, se descartan las ${ventanas.length - 20} más viejas (el barrido por id las cubre)`);
        gapWindows[region] = ventanas.slice(-20);
      }
      if (r.gapRange) gapRanges[region] = topearRangos(region, [r.gapRange, ...(gapRanges[region] ?? [])]); // el más nuevo primero
      delete r.gapWindow;
      delete r.gapRange;
      r.originRefetches = cacheRefetches - antes;
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
  // Relleno de huecos, con lo que sobra de la vuelta (presupuesto total, se corta en el primer 429).
  const hastaMs = Date.now() + GAP_RUN_BUDGET_MS;
  // Tope absoluto de TODO pedido del relleno (peleas, lista de peleas, ids): la vuelta nunca pasa de ~95 s.
  const limiteRespuestaMs = inicioVuelta + GAP_RUN_MAX_MS;
  limiteRellenoMs = limiteRespuestaMs;
  let limitado = false;
  const capturaLenta = Date.now() - inicioVuelta > GAP_SKIP_IF_CAPTURE_MS;
  if (capturaLenta) console.warn(`relleno: la captura normal tardó ${Math.round((Date.now() - inicioVuelta) / 1000)} s; esta vuelta no se rellena`);
  // Orden rotado por minuto (auditoría p60): con orden fijo, si Europa gastaba el tiempo, Asia nunca rellenaba.
  const regiones = Object.keys(REGION_HOSTS);
  const giro = Math.floor(Date.now() / 60_000) % regiones.length;
  for (const region of [...regiones.slice(giro), ...regiones.slice(0, giro)]) {
    if (capturaLenta || limitado || Date.now() >= hastaMs) break;
    const base = REGION_HOSTS[region];
    let recuperadas = 0;
    try {
      // a) Ventanas de tiempo → peleas a la cola.
      while ((gapWindows[region] ?? []).length > 0 && Date.now() < hastaMs) {
        const [desde, hasta] = gapWindows[region][0];
        const ids = await peleasDelHueco(base, desde, hasta);
        const enCola = new Set((gapQueue[region] ?? []).map((x) => (typeof x === 'object' ? x.id : x)));
        const cola = [...(gapQueue[region] ?? []), ...ids.filter((id) => !enCola.has(id))];
        if (cola.length > GAP_QUEUE_MAX) console.error(`[${region}] relleno: la cola de peleas pasó de ${GAP_QUEUE_MAX}; se descartan ${cola.length - GAP_QUEUE_MAX} (el barrido por id las cubre)`);
        gapQueue[region] = cola.slice(-GAP_QUEUE_MAX);
        gapWindows[region] = gapWindows[region].slice(1);
        console.log(`[${region}] hueco ${desde} → ${hasta}: ${ids.length} peleas a la cola`);
      }
      // b) Peleas (barato: recupera enseguida las kills grupales).
      if ((gapQueue[region] ?? []).length > 0) {
        const rel = await rellenarHueco(region, gapQueue[region], hastaMs);
        gapQueue[region] = rel.cola;
        recuperadas += rel.recuperadas;
        limitado = rel.limitado;
      }
      // c) Barrido por id (completa las sueltas).
      if (!limitado && (gapRanges[region] ?? []).length > 0 && Date.now() < hastaMs) {
        // Los fallos seguidos cuentan para el MISMO id de la cabeza (auditoría p60: antes era un número
        // por región y, si llegaba un rango nuevo adelante, sumaba fallos de ids distintos).
        const cabeza = gapRanges[region][0]?.[1] ?? null;
        const previo = gapFails[region];
        const fallosPrevios = previo && typeof previo === 'object' && previo.id === cabeza ? Number(previo.n) || 0 : 0;
        const bar = await barrerIds(region, gapRanges[region], fallosPrevios, hastaMs, limiteRespuestaMs);
        gapRanges[region] = bar.rangos;
        gapFails[region] = { id: bar.rangos[0]?.[1] ?? null, n: bar.fallos };
        recuperadas += bar.recuperadas;
        limitado = bar.limitado;
      }
    } catch (err) {
      if (err instanceof LimitadoPorAlbion) limitado = true;
      else if (err instanceof SinTiempo) console.log(`[${region}] relleno: se acabó el tiempo de la vuelta; sigue la próxima`);
      else console.error(`[${region}] relleno error: ${err.message}`);
    }
    if (results[region]?.kills?.ok) {
      Object.assign(results[region].kills.data, {
        gapRecovered: recuperadas,
        gapQueue: (gapQueue[region] ?? []).length,
        gapIdsPending: (gapRanges[region] ?? []).reduce((n, [lo, hi]) => n + hi - lo + 1, 0),
      });
    }
  }
  if (limitado) {
    // El límite de Albion es por IP para toda la API y dura ~1 s (medido): una pausa corta antes de
    // salir para que la captura normal de la vuelta siguiente nunca arranque castigada.
    console.warn('relleno: Albion pidió esperar (429); sigue la próxima vuelta');
    await sleep(5000);
  }

  try {
    await writeStatus(results);
  } catch (err) {
    console.error('status.json no se pudo escribir:', err.message);
  }

  // `lastEventIds` se guarda en cada vuelta (corte de respaldo de `fetchNewEvents`); `lastSlowRun`
  // solo cuando corrió el oro.
  await fs.mkdir(DATA_DIR, { recursive: true });
  await writeFileAtomic(STATE_PATH, JSON.stringify({ ...state, lastEventIds, gapQueue, gapRanges, gapFails, gapWindows, ...(tocaLento ? { lastSlowRun: new Date(ahora).toISOString() } : {}) }));
  if (!tocaLento) {
    console.log('Oro se saltea esta vuelta (cadencia horaria).');
  }
}

if (process.argv[2] === '--probar-ids') {
  const [, , , region, lo, hi] = process.argv;
  (async () => {
    let rangos = [[Number(lo), Number(hi)]];
    let fallos = 0;
    while (rangos.length > 0) {
      ({ rangos, fallos } = await barrerIds(region, rangos, fallos));
      if (rangos.length > 0) await sleep(5000); // la vuelta real es cada 60 s
    }
    process.exit(0);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (process.argv[2] === '--probar-hueco') {
  // Prueba manual del relleno (no toca state.json): node scrape.js --probar-hueco americas <desde> <hasta>
  const [, , , region, desde, hasta] = process.argv;
  peleasDelHueco(REGION_HOSTS[region], desde, hasta)
    .then(async (ids) => {
      console.log(`peleas en el hueco: ${ids.length}`);
      let cola = ids;
      while (cola.length > 0) cola = (await rellenarHueco(region, cola)).cola;
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  main().then(() => process.exit(0));
}
