// Parte 207: pruebas de las cuentas de rangos de ids (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contarIds,
  idsARangos,
  normalizarRangos,
  parteDeRangos,
  partirVentana,
  rangoDelHueco,
  rangosATexto,
  restarRangos,
  separarEnEspera,
  textoARangos,
  tomarMasViejos,
} from '../rangos.mjs';

test('normalizarRangos une los que se tocan y ordena del más nuevo al más viejo', () => {
  assert.deepEqual(normalizarRangos([[1, 5], [10, 12], [6, 8], [20, 20], [9, 9], [7, 3]]), [[20, 20], [1, 12]]);
});

test('restarRangos parte, recorta y quita', () => {
  assert.deepEqual(restarRangos([[1, 100]], [[10, 20], [50, 50], [90, 200]]), [[51, 89], [21, 49], [1, 9]]);
  assert.deepEqual(restarRangos([[1, 10]], [[1, 10]]), []);
  assert.deepEqual(restarRangos([[1, 10], [20, 30]], []), [[20, 30], [1, 10]]);
});

test('separarEnEspera retiene solo lo vigente y suelta lo vencido', () => {
  const rangos = [[1000, 2000], [100, 200]];
  const ahora = 1_000_000;
  const r = separarEnEspera(rangos, [[1500, 3000, ahora + 1], [100, 150, ahora - 1]], ahora);
  assert.deepEqual(r.retenidos, [[1500, 2000]]);
  assert.deepEqual(r.listos, [[1000, 1499], [100, 200]]);
  assert.deepEqual(r.esperas, [[1500, 3000, ahora + 1]]);
  assert.equal(contarIds(r.listos) + contarIds(r.retenidos), contarIds(rangos));
  const sin = separarEnEspera(rangos, undefined, ahora);
  assert.deepEqual(sin.retenidos, []);
  assert.deepEqual(sin.listos, rangos);
});

test('tomarMasViejos toma desde abajo y respeta el tope de pares', () => {
  assert.deepEqual(tomarMasViejos([[500, 600], [100, 199], [10, 19]], 50), [[100, 139], [10, 19]]);
  assert.deepEqual(tomarMasViejos([[500, 600], [100, 199], [10, 19]], 1000, 2), [[100, 199], [10, 19]]);
});

test('parteDeRangos reparte sin huecos ni solapes', () => {
  const rangos = [[1_474_248_394, 1_474_576_412], [1_478_000_000, 1_478_000_050], [1_473_735_177, 1_474_000_000]];
  for (const shards of [1, 5, 12]) {
    const partes = Array.from({ length: shards }, (_, i) => parteDeRangos(rangos, i, shards));
    const total = partes.reduce((n, p) => n + contarIds(p), 0);
    assert.equal(total, contarIds(rangos));
    assert.deepEqual(normalizarRangos(partes.flat()), normalizarRangos(rangos));
    for (let i = 0; i < shards; i++) for (let j = i + 1; j < shards; j++) assert.deepEqual(restarRangos(partes[i], partes[j]), partes[i]);
  }
});

test('texto de rangos ida y vuelta, y rechaza basura', () => {
  const r = [[30, 40], [1, 5]];
  assert.equal(rangosATexto(r), '30-40,1-5');
  assert.deepEqual(textoARangos('30-40,1-5'), r);
  assert.deepEqual(textoARangos('1-2;rm -rf /'), []);
  assert.deepEqual(textoARangos(''), []);
  assert.deepEqual(idsARangos([5, 3, 4, 9, 9]), [[9, 9], [3, 5]]);
});

test('partirVentana corta en tramos de como mucho maxMs', () => {
  const d = 86_400_000;
  assert.deepEqual(partirVentana(0, 20 * d, 9 * d), [[0, 9 * d], [9 * d, 18 * d], [18 * d, 20 * d]]);
  assert.deepEqual(partirVentana(0, 3 * d, 9 * d), [[0, 3 * d]]);
});

test('rangoDelHueco: igual que antes con el tope de siempre', () => {
  assert.equal(rangoDelHueco(0, 500, 100), null);
  assert.equal(rangoDelHueco(500, 501, 100), null);
  assert.deepEqual(rangoDelHueco(100, 150, 1000), { rango: [101, 149], total: 49, descartados: 0 });
  assert.deepEqual(rangoDelHueco(100, 1150, 1000), { rango: [150, 1149], total: 1049, descartados: 49 });
});
