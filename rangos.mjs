/**
 * Parte 207 (14-nov-2026): cuentas puras con rangos de ids `[lo, hi]` (inclusivos), compartidas por `scrape.js` y
 * `rescate.mjs` y probadas en `test/rangos.test.mjs`. Sin red ni archivos: solo listas de pares.
 */

/** Une los que se tocan y ordena del más nuevo al más viejo (como `gapRanges` en state.json). */
export function normalizarRangos(rangos) {
  const orden = (rangos ?? [])
    .filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] >= r[0])
    .map(([lo, hi]) => [lo, hi])
    .sort((a, b) => b[1] - a[1]);
  const unidos = [];
  for (const [lo, hi] of orden) {
    const ult = unidos[unidos.length - 1];
    if (ult && hi >= ult[0] - 1) ult[0] = Math.min(ult[0], lo);
    else unidos.push([lo, hi]);
  }
  return unidos;
}

export const contarIds = (rangos) => (rangos ?? []).reduce((n, [lo, hi]) => n + hi - lo + 1, 0);

/** `rangos` menos `quitar` (ambos listas de pares), del más nuevo al más viejo. */
export function restarRangos(rangos, quitar) {
  let out = normalizarRangos(rangos);
  for (const [qlo, qhi] of normalizarRangos(quitar)) {
    const sig = [];
    for (const [lo, hi] of out) {
      if (qhi < lo || qlo > hi) {
        sig.push([lo, hi]);
        continue;
      }
      if (hi > qhi) sig.push([qhi + 1, hi]);
      if (lo < qlo) sig.push([lo, qlo - 1]);
    }
    out = sig;
  }
  return normalizarRangos(out);
}

/** Separa lo que se puede barrer YA de lo que está «en espera» (hueco recién nacido al volver Albion: un 404 ahí puede
 * ser una kill que Albion todavía no publicó). `esperas` = [[lo, hi, hastaMs], …]; las vencidas se descartan. */
export function separarEnEspera(rangos, esperas, ahora = Date.now()) {
  const vigentes = (esperas ?? []).filter((e) => Array.isArray(e) && Number(e[2]) > ahora);
  const retenidosBrutos = [];
  for (const [elo, ehi] of vigentes) {
    for (const [lo, hi] of rangos ?? []) {
      const a = Math.max(lo, elo);
      const b = Math.min(hi, ehi);
      if (a <= b) retenidosBrutos.push([a, b]);
    }
  }
  const retenidos = normalizarRangos(retenidosBrutos);
  return { listos: restarRangos(rangos, retenidos), retenidos, esperas: vigentes };
}

/** Los `n` ids MÁS VIEJOS de `rangos` (los que el barrido del escáner, que va del más nuevo hacia atrás, no alcanza),
 * sin pasar de `maxRangos` pares. Devuelve pares del más nuevo al más viejo. */
export function tomarMasViejos(rangos, n, maxRangos = 300) {
  const asc = normalizarRangos(rangos).reverse();
  const out = [];
  let resta = n;
  for (const [lo, hi] of asc) {
    if (resta <= 0 || out.length >= maxRangos) break;
    const toma = Math.min(resta, hi - lo + 1);
    out.push([lo, lo + toma - 1]);
    resta -= toma;
  }
  return normalizarRangos(out);
}

/** La parte `shard` de `shards` de una lista de rangos, por cantidad de ids (pedazos contiguos, sin solaparse). */
export function parteDeRangos(rangos, shard, shards) {
  const asc = normalizarRangos(rangos).reverse();
  const total = contarIds(asc);
  const desde = Math.floor((total * shard) / shards);
  const hasta = Math.floor((total * (shard + 1)) / shards); // exclusivo
  const out = [];
  let base = 0;
  for (const [lo, hi] of asc) {
    const tam = hi - lo + 1;
    const a = Math.max(desde, base);
    const b = Math.min(hasta, base + tam);
    if (a < b) out.push([lo + (a - base), lo + (b - base) - 1]);
    base += tam;
  }
  return normalizarRangos(out);
}

/** Ids sueltos → rangos. */
export function idsARangos(ids) {
  return normalizarRangos([...new Set(ids)].map((id) => [id, id]));
}

/** "lo-hi,lo-hi" ↔ pares (para los inputs de `rescate.yml`). */
export const rangosATexto = (rangos) => normalizarRangos(rangos).map(([lo, hi]) => `${lo}-${hi}`).join(',');
export function textoARangos(texto) {
  if (!/^\d+-\d+(,\d+-\d+)*$/.test(String(texto ?? ''))) return [];
  return normalizarRangos(String(texto).split(',').map((p) => p.split('-').map(Number)));
}

/** Parte una ventana de tiempo en tramos de como mucho `maxMs` (rescate.yml rechaza ventanas de más de 10 días). */
export function partirVentana(desdeMs, hastaMs, maxMs) {
  const out = [];
  for (let a = desdeMs; a < hastaMs; a += maxMs) out.push([a, Math.min(hastaMs, a + maxMs)]);
  return out;
}

/** Nacimiento del hueco por id (ver `scrapeRegion`): [maxConocido+1 .. minLeido-1], topado a los `tope` más nuevos.
 * Devuelve `{ rango, descartados }` o null si no hay hueco. */
export function rangoDelHueco(maxConocido, minLeido, tope) {
  if (!(maxConocido > 0) || !(minLeido - 1 > maxConocido)) return null;
  const total = minLeido - 1 - maxConocido;
  return { rango: [Math.max(maxConocido + 1, minLeido - tope), minLeido - 1], total, descartados: Math.max(0, total - tope) };
}
