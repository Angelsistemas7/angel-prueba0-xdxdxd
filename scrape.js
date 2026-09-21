import { promises as fs } from 'fs';
import path from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const REGION_HOSTS = {
  europe: 'https://gameinfo.albiononline.com',
  americas: 'https://gameinfo-ams.albiononline.com',
  asia: 'https://gameinfo-sgp.albiononline.com',
};

/** Mismos hosts que usa la app (`src/services/albion-data.ts`) para AODP. */
const AODP_HOSTS = {
  americas: 'https://west.albion-online-data.com',
  asia: 'https://east.albion-online-data.com',
  europe: 'https://europe.albion-online-data.com',
};

const CITIES = ['Caerleon', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien', 'Black Market'];

/** 2026-07-27: reemplaza el watchlist chico de 14 items (decisión explícita del usuario — quiere
 * histórico de precios de TODO el catálogo, no solo lo que usa el Dashboard de Radar en vivo).
 * `price-item-ids.json` (este mismo repo, raíz) son los 3.694 item id base de
 * `src/data/items.json` de la app (mismo catálogo que usa el buscador de Mercado), copiados a
 * mano una vez — mismo criterio de "repo separado, sin build compartido" que ya se aplicaba al
 * watchlist chico. Ya NO está atado a `MARKET_WATCHLIST_IDS`/`radar-dashboard.ts` — ese watchlist
 * chico sigue existiendo en la app para las tarjetas de "mejor oportunidad" en vivo, es un
 * propósito distinto (rapidez/relevancia en la UI, no archivo histórico completo). */
const PRICE_ITEM_IDS = require('./price-item-ids.json');

/** Probado en vivo contra AODP antes de este cambio, con un lote FIJO de 250 ids esto rompía con
 * 414 (URI Too Long) — no por cantidad de ids, sino porque `T*_ARTEFACT_*` (los ids de artefactos
 * del catálogo) son mucho más largos que el resto (~35-40 caracteres vs ~15-20) y quedan
 * agrupados en el archivo fuente, así que algunos lotes de 250 pasaban ~8.2KB de URL y otros
 * ~4.6KB según qué ids les tocaran — confirmado reproduciendo el 414 real con curl contra el lote
 * exacto que falló. Fix: trocear por PRESUPUESTO DE CARACTERES de la URL, no por cantidad fija de
 * ids, para que ningún lote pueda pasarse sin importar qué ids le toquen. 6.000 caracteres para
 * los ids deja margen real bajo el límite típico de ~8KB de línea de request de este tipo de
 * servidor (confirmado con la falla real a ~8.2KB). */
const PRICE_CHUNK_MAX_CHARS = 6000;

function chunkByLength(ids, maxChars) {
  const out = [];
  let current = [];
  let currentLength = 0;
  for (const id of ids) {
    // +1 por la coma separadora, salvo el primer id del lote.
    const extra = current.length === 0 ? id.length : id.length + 1;
    if (current.length > 0 && currentLength + extra > maxChars) {
      out.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(id);
    currentLength += current.length === 1 ? id.length : id.length + 1;
  }
  if (current.length > 0) out.push(current);
  return out;
}

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

/** Precios/oro NO van más en el ciclo de 60s. Dos razones medidas, no estimadas:
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
async function readJsonGz(filePath, fallback) {
  try {
    return JSON.parse(gunzipSync(await fs.readFile(filePath)).toString('utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    console.error(`[corrupto] ${filePath} no se pudo leer (${err.message}) — se regenera desde cero.`);
    return fallback;
  }
}

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

function emptyGuildEntry(name) {
  return { name, battles: 0, wins: 0, losses: 0, kills: 0, deaths: 0, fameGained: 0, players: {} };
}

function emptyPlayerEntry(name) {
  return { name, participations: 0, kills: 0, deaths: 0, fame: 0, damageDone: 0, healingDone: 0 };
}

/** Índice acumulado por gremio: victorias/derrotas/fama/participación vienen de `/battles` (dato
 * agregado por el propio servidor del juego, más completo que lo que alcanzamos a capturar del
 * pool de 51 kills), daño/curación vienen de `/events` (único lugar donde existen, ver nota de
 * arriba). Ambos se actualizan SOLO con entradas recién agregadas (nunca se reprocesa una kill o
 * pelea ya vista), así el conteo no se duplica si sigue apareciendo en el pool de la API.
 * "Victoria/derrota" es una heurística honesta (kills > deaths del gremio EN ESA pelea puntual),
 * no un resultado oficial del juego — mismo criterio "observado" ya usado para el ranking de
 * gremios en el resto del proyecto. */
async function updateGuildStats(region, { newBattles, newKills }) {
  if (newBattles.length === 0 && newKills.length === 0) return;
  const filePath = path.join(DATA_DIR, 'guild-stats', `${region}.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const stats = await readJson(filePath, {});

  for (const battle of newBattles) {
    for (const g of battle.guilds) {
      if (!g.id) continue;
      const entry = stats[g.id] ?? emptyGuildEntry(g.name);
      entry.name = g.name || entry.name;
      entry.battles += 1;
      if (g.kills > g.deaths) entry.wins += 1;
      else if (g.kills < g.deaths) entry.losses += 1;
      entry.kills += g.kills;
      entry.deaths += g.deaths;
      entry.fameGained += g.killFame;
      stats[g.id] = entry;
    }
    for (const p of battle.players) {
      if (!p.guildId) continue;
      const guildEntry = stats[p.guildId] ?? emptyGuildEntry(p.guildName);
      const playerEntry = guildEntry.players[p.id] ?? emptyPlayerEntry(p.name);
      playerEntry.name = p.name || playerEntry.name;
      playerEntry.participations += 1;
      playerEntry.kills += p.kills;
      playerEntry.deaths += p.deaths;
      playerEntry.fame += p.killFame;
      guildEntry.players[p.id] = playerEntry;
      stats[p.guildId] = guildEntry;
    }
  }

  for (const kill of newKills) {
    for (const p of kill.participants) {
      if (!p.guildId) continue;
      const guildEntry = stats[p.guildId] ?? emptyGuildEntry(p.guildName);
      const playerEntry = guildEntry.players[p.id] ?? emptyPlayerEntry(p.name);
      playerEntry.name = p.name || playerEntry.name;
      playerEntry.damageDone += p.damageDone;
      playerEntry.healingDone += p.healingDone;
      guildEntry.players[p.id] = playerEntry;
      stats[p.guildId] = guildEntry;
    }
  }

  await fs.writeFile(filePath, JSON.stringify(stats));
}

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
  const killsPath = path.join(DATA_DIR, 'kills', region, `${date}.ndjson`);
  const knownIds = new Set((await readNdjson(killsPath)).map((k) => k.eventId));

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
  const newBattles = await appendUniqueNdjson(path.join(DATA_DIR, 'battles', region, `${date}.ndjson`), battleEntries, 'battleId');
  await updateGuildStats(region, { newBattles, newKills });
  console.log(`[${region}] +${newKills.length} kills nuevas, +${newBattles.length} peleas nuevas (${eventsResult.paginas} página(s) de eventos).`);
}

async function scrapePrices(region) {
  const base = AODP_HOSTS[region];
  const locations = CITIES.map(encodeURIComponent).join(',');
  const idChunks = chunkByLength(PRICE_ITEM_IDS, PRICE_CHUNK_MAX_CHARS);

  const prices = [];
  for (const idsChunk of idChunks) {
    const ids = idsChunk.join(',');
    try {
      const chunkPrices = await fetchJson(`${base}/api/v2/stats/prices/${ids}.json?locations=${locations}&qualities=1`);
      prices.push(...chunkPrices);
    } catch (err) {
      // Un lote caído no debe tumbar el resto del catálogo — se reintenta solo en la próxima corrida.
      console.error(`[${region}] precios, lote de ${idsChunk.length} ids falló:`, err.message);
    }
    await sleep(200); // no golpear la API pública gratuita con 15 requests seguidos sin pausa.
  }

  // El snapshot es SOLO la línea base contra la que se diffea el histórico — no lo lee nadie más
  // (la app y las Functions solo leen `data/kills` y `data/battles`). Son 7,3 MB por región en
  // JSON plano y se commitea cada vez que cambia, o sea 22 MB de objetos git nuevos por hora en
  // un repo que ya pesa 10,4 GB. Comprimido baja a ~1 MB sin perder nada, porque nadie necesita
  // leerlo a mano.
  const snapshotPath = path.join(DATA_DIR, 'prices', `${region}.json.gz`);
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  const snapshot = await readJsonGz(snapshotPath, {});

  // Histórico de precios: solo se agrega una línea cuando el precio REALMENTE cambió respecto al
  // último snapshot guardado — a diferencia de kills/peleas (donde casi todo es nuevo cada
  // corrida), la mayoría de los precios no cambian minuto a minuto, así que registrar cada
  // corrida sin filtrar infla el archivo sin aportar nada para el análisis de tendencia futuro.
  const changed = [];
  for (const p of prices) {
    const key = `${p.item_id}_${p.city}`;
    const prev = snapshot[key];
    const updated = {
      itemId: p.item_id,
      city: p.city,
      sellPriceMin: p.sell_price_min,
      sellPriceMinDate: p.sell_price_min_date,
      buyPriceMax: p.buy_price_max,
      buyPriceMaxDate: p.buy_price_max_date,
      updatedAt: new Date().toISOString(),
    };
    if (!prev || prev.sellPriceMin !== updated.sellPriceMin || prev.buyPriceMax !== updated.buyPriceMax) {
      changed.push(updated);
    }
    snapshot[key] = updated;
  }
  await fs.writeFile(snapshotPath, gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8')));

  if (changed.length > 0) {
    const historyPath = path.join(DATA_DIR, 'price-history', region, `${todayStr()}.ndjson`);
    await fs.mkdir(path.dirname(historyPath), { recursive: true });
    const lines = changed.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.appendFile(historyPath, lines, 'utf8');
  }
  console.log(`[${region}] ${prices.length} precios revisados, ${changed.length} cambios registrados en histórico.`);
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

  for (const region of Object.keys(REGION_HOSTS)) {
    try {
      await scrapeRegion(region);
    } catch (err) {
      // Una región caída no debe tumbar el resto — cada región es independiente.
      console.error(`[${region}] error:`, err.message);
    }
    if (!tocaLento) continue;
    try {
      await scrapePrices(region);
    } catch (err) {
      console.error(`[${region}] precios error:`, err.message);
    }
    try {
      await scrapeGold(region);
    } catch (err) {
      console.error(`[${region}] oro error:`, err.message);
    }
  }

  if (tocaLento) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify({ ...state, lastSlowRun: new Date(ahora).toISOString() }));
  } else {
    console.log('Precios/oro se saltean esta vuelta (cadencia horaria).');
  }
}

main().then(() => process.exit(0));
