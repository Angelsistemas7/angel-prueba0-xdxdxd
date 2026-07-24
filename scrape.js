import admin from 'firebase-admin';

const REGION_HOSTS = {
  europe: 'https://gameinfo.albiononline.com',
  americas: 'https://gameinfo-ams.albiononline.com',
  asia: 'https://gameinfo-sgp.albiononline.com',
};

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

async function main() {
  for (const region of Object.keys(REGION_HOSTS)) {
    try {
      await scrapeRegion(region);
    } catch (err) {
      // Una región caída no debe tumbar el resto — cada región es independiente.
      console.error(`[${region}] error:`, err.message);
    }
  }
}

main().then(() => process.exit(0));
