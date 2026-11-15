// Pruebas del índice de archivo por mes (chat 212). `npm test` del escáner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildShards, compareKeys, fileKey, fromDeltas, indexFile, killNames, main, shardOf, toDeltas } from '../archivo-indice.mjs';

const kill = (eventId, killerName, victimName) => JSON.stringify({ eventId, killerName, victimName, timestamp: '2026-10-19T10:00:00Z' });

test('shardOf es la misma FNV-1a de la app (minúsculas)', () => {
  assert.equal(shardOf('BalkanWarlord', 2048), shardOf('balkanwarlord', 2048));
  assert.equal(shardOf('BalkanWarlord', 2048), 1687); // medido con el índice real del 19-oct
});

test('fileKey: días y partes del mes, nada más', () => {
  assert.equal(fileKey('2026-10-19.ndjson', '2026-10'), '2026-10-19');
  assert.equal(fileKey('2026-10-19.2.ndjson', '2026-10'), '2026-10-19.2');
  assert.equal(fileKey('2026-10-19.1.ndjson', '2026-10'), '2026-10-19');
  assert.equal(fileKey('2026-11-01.ndjson', '2026-10'), null);
  assert.equal(fileKey('README.md', '2026-10'), null);
  assert.deepEqual(['2026-10-19.2', '2026-10-20', '2026-10-19'].sort(compareKeys), ['2026-10-19', '2026-10-19.2', '2026-10-20']);
});

test('distancias: ida y vuelta exacta', () => {
  const refs = [0, 10, 11, 5, 100, 7];
  assert.deepEqual(toDeltas(refs), [0, 10, 1, 5, 84, 7]);
  assert.deepEqual(fromDeltas(toDeltas(refs)), refs);
});

test('indexFile: cada posición es la línea entera del nombre; repetidas y rotas se saltan', () => {
  const lines = [kill(1, 'Ana', 'Beto'), '{roto', kill(2, 'Beto', 'Carla'), kill(1, 'Ana', 'Beto'), kill(3, 'Constructor', 'ana')];
  const buf = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const index = new Map();
  const n = indexFile(buf, '2026-10-19', killNames, index, (r) => r.eventId);
  assert.equal(n, 3);
  const ana = index.get('ana').get('2026-10-19');
  assert.equal(ana.length, 4); // eventos 1 y 3, no el repetido
  for (let i = 0; i < ana.length; i += 2) {
    const rec = JSON.parse(buf.toString('utf8', ana[i], ana[i] + ana[i + 1]));
    assert.ok([rec.killerName, rec.victimName].map((x) => x.toLowerCase()).includes('ana'));
  }
  // Sin prototipo: «constructor» es un nombre como cualquier otro (chat 184).
  const shards = buildShards(index, 8);
  assert.ok(shards[shardOf('constructor', 8)].constructor);
});

test('main: escribe archivos.json y las partes con las direcciones de cada archivo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivo-'));
  const kdir = path.join(dir, 'kills');
  fs.mkdirSync(kdir);
  fs.writeFileSync(path.join(kdir, '2026-10-19.ndjson'), `${kill(1, 'Ana', 'Beto')}\n`);
  fs.writeFileSync(path.join(kdir, '2026-10-19.2.ndjson'), `${kill(2, 'Ana', 'Carla')}\n`);
  fs.writeFileSync(path.join(kdir, '2026-11-01.ndjson'), `${kill(3, 'Ana', 'Dani')}\n`);
  const out = path.join(dir, 'ni');
  const res = main(['--region', 'europe', '--mes', '2026-10', '--kills', kdir, '--kills-url', 'https://x/kills/', '--out', out]);
  assert.deepEqual(Object.keys(res.k), ['2026-10-19', '2026-10-19.2']);
  assert.equal(res.k['2026-10-19.2'].u, 'https://x/kills/2026-10-19.2.ndjson');
  const shard = JSON.parse(fs.readFileSync(path.join(out, 'k', `${shardOf('ana', 2048)}.json`), 'utf8'));
  assert.equal(shard.v, 1);
  assert.equal(shard.m, '2026-10');
  assert.deepEqual(Object.keys(shard.n.ana), ['2026-10-19', '2026-10-19.2']);
  assert.equal(fs.existsSync(path.join(out, 'b')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
