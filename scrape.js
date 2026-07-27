import { promises as fs } from 'fs';
import path from 'path';
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

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
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

async function scrapeRegion(region) {
  const base = REGION_HOSTS[region];
  const [events, battles] = await Promise.all([
    fetchJson(`${base}/api/gameinfo/events?limit=${EVENTS_LIMIT}&offset=0`),
    fetchJson(`${base}/api/gameinfo/battles?range=day&limit=${BATTLES_LIMIT}&offset=0&sort=recent`),
  ]);

  const date = todayStr();

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

  const newKills = await appendUniqueNdjson(path.join(DATA_DIR, 'kills', region, `${date}.ndjson`), kills, 'eventId');
  const newBattles = await appendUniqueNdjson(path.join(DATA_DIR, 'battles', region, `${date}.ndjson`), battleEntries, 'battleId');
  await updateGuildStats(region, { newBattles, newKills });
  console.log(`[${region}] +${newKills.length} kills nuevas, +${newBattles.length} peleas nuevas (vistas: ${events.length}/${battles.length}).`);
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

  const snapshotPath = path.join(DATA_DIR, 'prices', `${region}.json`);
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  const snapshot = await readJson(snapshotPath, {});

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
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot));

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
  for (const region of Object.keys(REGION_HOSTS)) {
    try {
      await scrapeRegion(region);
    } catch (err) {
      // Una región caída no debe tumbar el resto — cada región es independiente.
      console.error(`[${region}] error:`, err.message);
    }
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
}

main().then(() => process.exit(0));
