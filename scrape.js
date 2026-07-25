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
 * deduplicados por id en NDJSON diario por región; precios son un snapshot único por región que
 * se pisa (no hace falta historial, es solo el último precio bueno visto como fallback). */

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

/** Agrega solo las entradas cuyo `idKey` todavía no está en el archivo — evita duplicar la misma
 * kill/pelea si sigue apareciendo en el pool de la API en la siguiente corrida. */
async function appendUniqueNdjson(filePath, newEntries, idKey) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readNdjson(filePath);
  const seen = new Set(existing.map((e) => e[idKey]));
  const toAppend = newEntries.filter((e) => !seen.has(e[idKey]));
  if (toAppend.length === 0) return 0;
  const lines = toAppend.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.appendFile(filePath, lines, 'utf8');
  return toAppend.length;
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

  const battleEntries = battles.map((battle) => ({
    battleId: battle.id,
    startTime: battle.startTime,
    totalKills: battle.totalKills ?? 0,
    totalFame: battle.totalFame ?? 0,
    guildNames: Object.values(battle.guilds ?? {}).map((g) => g.name),
  }));

  const killsAdded = await appendUniqueNdjson(path.join(DATA_DIR, 'kills', region, `${date}.ndjson`), kills, 'eventId');
  const battlesAdded = await appendUniqueNdjson(path.join(DATA_DIR, 'battles', region, `${date}.ndjson`), battleEntries, 'battleId');
  console.log(`[${region}] +${killsAdded} kills nuevas, +${battlesAdded} peleas nuevas (vistas: ${events.length}/${battles.length}).`);
}

async function scrapePrices(region) {
  const base = AODP_HOSTS[region];
  const ids = PRICE_WATCHLIST_IDS.join(',');
  const locations = CITIES.map(encodeURIComponent).join(',');
  const prices = await fetchJson(`${base}/api/v2/stats/prices/${ids}.json?locations=${locations}&qualities=1`);

  const filePath = path.join(DATA_DIR, 'prices', `${region}.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let snapshot = {};
  try {
    snapshot = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  for (const p of prices) {
    const key = `${p.item_id}_${p.city}`;
    snapshot[key] = {
      itemId: p.item_id,
      city: p.city,
      sellPriceMin: p.sell_price_min,
      sellPriceMinDate: p.sell_price_min_date,
      buyPriceMax: p.buy_price_max,
      buyPriceMaxDate: p.buy_price_max_date,
      updatedAt: new Date().toISOString(),
    };
  }

  await fs.writeFile(filePath, JSON.stringify(snapshot));
  console.log(`[${region}] ${prices.length} precios actualizados en el snapshot.`);
}

/** Reemplaza el TTL de Firestore (`expireAt`) — borra archivos NDJSON de días fuera de la
 * ventana de retención. Los snapshots de precio no tienen fecha en el nombre, no aplica. */
async function pruneOldFiles() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const kind of ['kills', 'battles']) {
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
  }
  await pruneOldFiles();
}

main().then(() => process.exit(0));
