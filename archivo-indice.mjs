// Índice de ARCHIVO por mes (chat 212): para buscar kills y peleas de meses anteriores por nombre sin bajar días enteros.
//
// El índice diario (`albion-world-stats`, rama `index`) guarda solo 31 días: pasado eso la app ya no podía buscar a
// nadie por nombre, aunque los archivos del escáner siguen guardados para siempre en GitHub y la API oficial sigue
// dando cada kill completa por su id (medido el 15-nov con una del 25-jul). Esto cierra ese hueco con UN índice por
// mes, escrito una sola vez cuando el mes ya cerró (sus archivos no cambian más), en el repo de datos de ese mes:
//
//   ni/archivos.json        { v, r, m, k: { "2026-10-19": { u, b }, "2026-10-19.2": {...} }, b: {...} }
//   ni/k/<parte>.json       { v, t: "k", r, m, s, n: { nombre: { "2026-10-19": [d, l, d, l, ...] } } }
//   ni/b/<parte>.json       igual para peleas (nombre = gremio)
//
// `u` = dirección del archivo, `b` = bytes indexados. En cada lista, `l` es el largo de la línea y `d` la distancia
// desde el final de la anterior (la primera, desde 0): inicio = fin anterior + d. Con distancias en vez de
// posiciones el índice pesa menos de la mitad. Medido el 15-nov con Europa del 19-oct (77.137 kills,
// 27.838 nombres): ~2,1 MB por día sin comprimir, ~1,1 MB comprimido; un mes de Europa ~35 MB en git. Con 2048
// partes la app baja ~17 KB comprimidos para ver un mes entero de un jugador.
//
// Sin dependencias: corre igual en el workflow del escáner y en cualquier PC.
//   node archivo-indice.mjs --region europe --mes 2026-10 \
//     --kills <carpeta> --kills-url <url base> [--battles <carpeta> --battles-url <url base>] --out <carpeta ni>
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = 1;
export const PARTES = { k: 2048, b: 256 };

/** FNV-1a sobre el nombre en minúsculas: la MISMA de la app (`combat-stats.ts`) y de stats-builder. */
export function shardOf(name, shards) {
  let h = 0x811c9dc5;
  const s = String(name).toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shards;
}

export function killNames(k) {
  const out = new Set();
  if (typeof k?.killerName === 'string' && k.killerName) out.add(k.killerName);
  if (typeof k?.victimName === 'string' && k.victimName) out.add(k.victimName);
  return out;
}

export function battleGuildNames(b) {
  const out = new Set();
  for (const g of Array.isArray(b?.guilds) ? b.guilds : []) if (typeof g?.name === 'string' && g.name) out.add(g.name);
  return out;
}

/** `2026-10-19.ndjson` → `2026-10-19`; `2026-10-19.2.ndjson` → `2026-10-19.2`; otra cosa → null. */
export function fileKey(fileName, mes) {
  const m = /^(\d{4}-\d{2}-\d{2})(\.(\d+))?\.ndjson$/.exec(fileName);
  if (!m || m[1].slice(0, 7) !== mes) return null;
  return m[3] && m[3] !== '1' ? `${m[1]}.${m[3]}` : m[1];
}

/** Orden de los archivos: por día y, dentro del día, la parte 1 antes que la 2 (de lo viejo a lo nuevo). */
export function compareKeys(a, b) {
  const [da, pa = '1'] = a.split('.');
  const [db, pb = '1'] = b.split('.');
  return da < db ? -1 : da > db ? 1 : Number(pa) - Number(pb);
}

/**
 * Agrega al índice `into` (Map nombreMinúsculas → Map clave → [inicio, largo, ...]) las líneas del archivo `buf`.
 * Solo la primera línea de cada evento (el escáner repitió líneas en septiembre); las líneas rotas se saltan.
 */
export function indexFile(buf, key, namesOf, into, idOf) {
  const seen = new Set();
  let off = 0;
  let lines = 0;
  while (off < buf.length) {
    let end = buf.indexOf(10, off);
    if (end === -1) end = buf.length;
    if (end > off) {
      let rec = null;
      try {
        rec = JSON.parse(buf.toString('utf8', off, end));
      } catch {
        rec = null;
      }
      const id = rec ? idOf(rec) : undefined;
      if (rec && (id === undefined || !seen.has(id))) {
        if (id !== undefined) seen.add(id);
        lines++;
        for (const name of namesOf(rec)) {
          const k = name.toLowerCase();
          let byKey = into.get(k);
          if (!byKey) into.set(k, (byKey = new Map()));
          let refs = byKey.get(key);
          if (!refs) byKey.set(key, (refs = []));
          refs.push(off, end - off);
        }
      }
    }
    off = end + 1;
  }
  return lines;
}

/** [inicio, largo, ...] → [distancia, largo, ...]. Pura. */
export function toDeltas(refs) {
  const out = [];
  let prevEnd = 0;
  for (let i = 0; i < refs.length; i += 2) {
    out.push(refs[i] - prevEnd, refs[i + 1]);
    prevEnd = refs[i] + refs[i + 1];
  }
  return out;
}

/** Al revés que `toDeltas` (la app hace lo mismo). Pura. */
export function fromDeltas(deltas) {
  const out = [];
  let prevEnd = 0;
  for (let i = 0; i < deltas.length; i += 2) {
    const o = prevEnd + deltas[i];
    out.push(o, deltas[i + 1]);
    prevEnd = o + deltas[i + 1];
  }
  return out;
}

/** Arma las partes de un tipo: Array(s) de objetos sin prototipo { nombre: { clave: deltas } }. Pura. */
export function buildShards(index, shards) {
  const out = Array.from({ length: shards }, () => Object.create(null));
  for (const [name, byKey] of index) {
    const entry = Object.create(null);
    for (const key of [...byKey.keys()].sort(compareKeys)) entry[key] = toDeltas(byKey.get(key));
    out[shardOf(name, shards)][name] = entry;
  }
  return out;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

const idOfKill = (r) => (Number.isFinite(r?.eventId) ? r.eventId : undefined);
const idOfBattle = (r) => (Number.isFinite(r?.id) ? r.id : Number.isFinite(r?.battleId) ? r.battleId : undefined);

/** Indexa una carpeta: devuelve { files: { clave: { u, b } }, index, lines }. */
function indexDir(dir, urlBase, mes, namesOf, idOf) {
  const files = {};
  const index = new Map();
  let lines = 0;
  if (!dir || !fs.existsSync(dir)) return { files, index, lines };
  const names = fs.readdirSync(dir).filter((f) => fileKey(f, mes)).sort((x, y) => compareKeys(fileKey(x, mes), fileKey(y, mes)));
  for (const f of names) {
    const key = fileKey(f, mes);
    const buf = fs.readFileSync(path.join(dir, f));
    lines += indexFile(buf, key, namesOf, index, idOf);
    files[key] = { u: `${urlBase.replace(/\/$/, '')}/${f}`, b: buf.length };
    process.stdout.write(`  ${f}: ${buf.length} bytes\n`);
  }
  return { files, index, lines };
}

export function main(argv) {
  const a = parseArgs(argv);
  const { region, mes, out } = a;
  if (!/^(europe|americas|asia)$/.test(region ?? '') || !/^\d{4}-\d{2}$/.test(mes ?? '') || !out) {
    throw new Error('uso: --region europe|americas|asia --mes AAAA-MM --kills <dir> --kills-url <url> [--battles <dir> --battles-url <url>] --out <dir>');
  }
  const kills = indexDir(a.kills, a['kills-url'] ?? '', mes, killNames, idOfKill);
  const battles = indexDir(a.battles, a['battles-url'] ?? '', mes, battleGuildNames, idOfBattle);
  if (Object.keys(kills.files).length === 0) throw new Error(`sin archivos de kills de ${mes} en ${a.kills}`);
  fs.rmSync(out, { recursive: true, force: true });
  let bytes = 0;
  for (const [t, part] of [['k', kills], ['b', battles]]) {
    if (Object.keys(part.files).length === 0) continue;
    const shards = buildShards(part.index, PARTES[t]);
    fs.mkdirSync(path.join(out, t), { recursive: true });
    shards.forEach((n, i) => {
      const text = JSON.stringify({ v: VERSION, t, r: region, m: mes, s: PARTES[t], n });
      bytes += text.length;
      fs.writeFileSync(path.join(out, t, `${i}.json`), text);
    });
  }
  const archivos = { v: VERSION, r: region, m: mes, k: kills.files, b: battles.files, kills: kills.lines, battles: battles.lines, hecho: new Date().toISOString() };
  fs.writeFileSync(path.join(out, 'archivos.json'), JSON.stringify(archivos));
  console.log(`listo ${region} ${mes}: ${kills.lines} kills, ${battles.lines} peleas, ${kills.index.size} nombres, ${(bytes / 1e6).toFixed(1)} MB de índice`);
  return archivos;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main(process.argv.slice(2));
}
