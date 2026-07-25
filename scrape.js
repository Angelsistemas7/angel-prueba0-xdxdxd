import { promises as fs } from 'fs';
import path from 'path';

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

/** Copiado de `MARKET_WATCHLIST_IDS` en `src/utils/radar-dashboard.ts` (repo de la app) — repo
 * separado, sin build compartido, así que se mantiene a mano. Si el watchlist de la app cambia,
 * actualizar acá también. */
const PRICE_WATCHLIST_IDS = [
  'T4_BAG',
  'T5_BAG',
  'T4_MAIN_SWORD',
  'T4_2H_BOW',
  'T4_2H_WARBOW',
  'T4_OFF_SHIELD',
  'T4_ARMOR_LEATHER_SET1',
  'T4_HEAD_PLATE_SET1',
  'T4_SHOES_CLOTH_SET1',
  'T4_POTION_HEAL',
  'T4_MOUNT_HORSE',
  'T4_2H_CLERICSTAFF',
  'T4_MAIN_AXE',
  'T4_ARMOR_PLATE_SET1',
];

const EVENTS_LIMIT = 51;
const BATTLES_LIMIT = 20;
const RETENTION_DAYS = 30;
const DATA_DIR = 'data';

/** 2026-07-25: se cayó Firestore (cuota gratis de 20.000 escrituras/día se agotaba a mitad de
 * día corriendo cada 60s, ver `docs/handoff.md` de la app). Reemplazado por archivos dentro de
 * este mismo repo git — commit/push periódico en `scrape.yml`, no acá. Kills/peleas se acumulan
 * deduplicados por id en NDJSON diario por región; precios/oro son snapshot + histórico de
 * cambios; el índice de gremios/jugadores se acumula incrementalmente, solo con peleas nuevas.
 *
 * Límite real confirmado (no un dato que falte agregar): la API de GameInfo NO expone daño hecho
 * ni curación por jugador en ninguna parte (`battle.players`/`battle.guilds` solo traen
 * kills/deaths/killFame) — eso solo existe vía sniffing del protocolo del cliente del juego
 * (packet capture en la misma PC donde se juega), arquitectónicamente incompatible con una app de
 * teléfono. No reabrir esto sin una fuente de datos nueva y real. */

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

/** Índice acumulado por gremio (victorias/derrotas/fama/participación de jugadores), actualizado
 * SOLO con peleas recién agregadas (nunca se reprocesa una pelea ya vista, así no se duplica el
 * conteo si sigue apareciendo en el pool de /battles). "Victoria/derrota" es una heurística
 * honesta (kills > deaths del gremio EN ESA pelea puntual), no un resultado oficial del juego —
 * mismo criterio "observado" ya usado para el ranking de gremios en el resto del proyecto. */
async function updateGuildStats(region, newBattles) {
  if (newBattles.length === 0) return;
  const filePath = path.join(DATA_DIR, 'guild-stats', `${region}.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const stats = await readJson(filePath, {});

  for (const battle of newBattles) {
    for (const g of battle.guilds) {
      if (!g.id) continue;
      const entry = stats[g.id] ?? {
        name: g.name,
        battles: 0,
        wins: 0,
        losses: 0,
        kills: 0,
        deaths: 0,
        fameGained: 0,
        players: {},
      };
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
      const guildEntry = stats[p.guildId];
      if (!guildEntry) continue;
      const playerEntry = guildEntry.players[p.id] ?? { name: p.name, participations: 0, kills: 0, deaths: 0, fame: 0 };
      playerEntry.name = p.name || playerEntry.name;
      playerEntry.participations += 1;
      playerEntry.kills += p.kills;
      playerEntry.deaths += p.deaths;
      playerEntry.fame += p.killFame;
      guildEntry.players[p.id] = playerEntry;
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
    timestamp: event.TimeStamp,
    killerName: event.Killer?.Name ?? '',
    killerGuild: event.Killer?.GuildName ?? '',
    victimName: event.Victim?.Name ?? '',
    victimGuild: event.Victim?.GuildName ?? '',
    totalFame: event.TotalVictimKillFame ?? 0,
    participantsCount: event.numberOfParticipants ?? 1,
  }));

  const battleEntries = battles.map(extractBattleEntry);

  const newKills = await appendUniqueNdjson(path.join(DATA_DIR, 'kills', region, `${date}.ndjson`), kills, 'eventId');
  const newBattles = await appendUniqueNdjson(path.join(DATA_DIR, 'battles', region, `${date}.ndjson`), battleEntries, 'battleId');
  await updateGuildStats(region, newBattles);
  console.log(`[${region}] +${newKills.length} kills nuevas, +${newBattles.length} peleas nuevas (vistas: ${events.length}/${battles.length}).`);
}

async function scrapePrices(region) {
  const base = AODP_HOSTS[region];
  const ids = PRICE_WATCHLIST_IDS.join(',');
  const locations = CITIES.map(encodeURIComponent).join(',');
  const prices = await fetchJson(`${base}/api/v2/stats/prices/${ids}.json?locations=${locations}&qualities=1`);

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

/** Reemplaza el TTL de Firestore (`expireAt`) — borra archivos de días fuera de la ventana de
 * retención. Los snapshots/índices que se pisan en el lugar (precios, guild-stats) y el archivo
 * de oro (chico, ~24 líneas/día, se deja crecer) no tienen fecha en el nombre, no aplica. */
async function pruneOldFiles() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const kind of ['kills', 'battles', 'price-history']) {
    const kindDir = path.join(DATA_DIR, kind);
    let regions = [];
    try {
      regions = await fs.readdir(kindDir);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const region of regions) {
      const regionDir = path.join(kindDir, region);
      const files = await fs.readdir(regionDir).catch(() => []);
      for (const file of files) {
        const dateStr = file.replace('.ndjson', '');
        const fileDate = new Date(`${dateStr}T00:00:00Z`).getTime();
        if (!Number.isNaN(fileDate) && fileDate < cutoff) {
          await fs.unlink(path.join(regionDir, file));
        }
      }
    }
  }
}

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
  await pruneOldFiles();
}

main().then(() => process.exit(0));
