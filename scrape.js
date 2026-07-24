import admin from 'firebase-admin';

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
 * actualizar acá también. Objetivo: guardar un snapshot de precios cada 5 min para que "Mejor
 * mercado/transporte" no pierdan una comparación válida solo porque una llamada puntual a AODP no
 * trajo todos los ítems (pasa, la API no siempre devuelve el pool completo pedido). */
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

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
  return res.json();
}

function expireAt() {
  return admin.firestore.Timestamp.fromMillis(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

async function scrapeRegion(region) {
  const base = REGION_HOSTS[region];
  const [events, battles] = await Promise.all([
    fetchJson(`${base}/api/gameinfo/events?limit=${EVENTS_LIMIT}&offset=0`),
    fetchJson(`${base}/api/gameinfo/battles?range=day&limit=${BATTLES_LIMIT}&offset=0&sort=recent`),
  ]);

  const batch = db.batch();
  const expire = expireAt();

  for (const event of events) {
    const ref = db.collection('kills').doc(`${region}_${event.EventId}`);
    batch.set(
      ref,
      {
        eventId: event.EventId,
        region,
        timestamp: event.TimeStamp,
        killerName: event.Killer?.Name ?? '',
        killerGuild: event.Killer?.GuildName ?? '',
        victimName: event.Victim?.Name ?? '',
        victimGuild: event.Victim?.GuildName ?? '',
        totalFame: event.TotalVictimKillFame ?? 0,
        participantsCount: event.numberOfParticipants ?? 1,
        expireAt: expire,
      },
      { merge: true },
    );
  }

  for (const battle of battles) {
    const ref = db.collection('battles').doc(`${region}_${battle.id}`);
    batch.set(
      ref,
      {
        battleId: battle.id,
        region,
        startTime: battle.startTime,
        totalKills: battle.totalKills ?? 0,
        totalFame: battle.totalFame ?? 0,
        guildNames: Object.values(battle.guilds ?? {}).map((g) => g.name),
        expireAt: expire,
      },
      { merge: true },
    );
  }

  await batch.commit();
  console.log(`[${region}] ${events.length} kills, ${battles.length} peleas guardadas.`);
}

async function scrapePrices(region) {
  const base = AODP_HOSTS[region];
  const ids = PRICE_WATCHLIST_IDS.join(',');
  const locations = CITIES.map(encodeURIComponent).join(',');
  const prices = await fetchJson(`${base}/api/v2/stats/prices/${ids}.json?locations=${locations}&qualities=1`);

  const batch = db.batch();
  const expire = expireAt();
  for (const p of prices) {
    // Doc id determinístico por item+ciudad+región: cada snapshot nuevo pisa al anterior (no
    // acumula un doc por corrida) — lo que importa es el ÚLTIMO precio bueno visto, no el historial
    // completo de cada 5 min (eso infla Firestore sin necesidad para este caso de uso).
    const ref = db.collection('prices').doc(`${region}_${p.item_id}_${p.city}`);
    batch.set(
      ref,
      {
        itemId: p.item_id,
        region,
        city: p.city,
        sellPriceMin: p.sell_price_min,
        sellPriceMinDate: p.sell_price_min_date,
        buyPriceMax: p.buy_price_max,
        buyPriceMaxDate: p.buy_price_max_date,
        updatedAt: admin.firestore.Timestamp.now(),
        expireAt: expire,
      },
      { merge: true },
    );
  }
  await batch.commit();
  console.log(`[${region}] ${prices.length} precios guardados.`);
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
}

main().then(() => process.exit(0));
