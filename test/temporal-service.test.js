import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeClock } from '../src/application/runtime-clock.js';
import { createTemporalService, runtimeTemporalInstruction } from '../src/application/temporal-service.js';

function serviceAt(iso, timezone = 'Asia/Jakarta') {
  const clock = createRuntimeClock({ now: () => new Date(iso), timezone });
  return { clock, service: createTemporalService({ clock }) };
}

test('uses the injected local clock for weekday, date, month, and time', () => {
  const { service } = serviceAt('2026-11-26T06:37:00.000Z');
  assert.equal(service.answer('Friday hari apa ini'), 'Hari ini hari Kamis, 26 November 2026.');
  assert.equal(service.answer('sekarang bulan apa'), 'Sekarang bulan November 2026.');
  assert.match(service.answer('jam berapa sekarang'), /13:37:00 \(Asia\/Jakarta\)/);
});

test('calculates relative dates across a month boundary', () => {
  const { service } = serviceAt('2026-03-01T01:00:00.000Z');
  assert.match(service.answer('kemarin hari apa'), /Sabtu, 28 Februari 2026/);
  assert.match(service.answer('besok hari apa'), /Senin, 2 Maret 2026/);
  assert.match(service.answer('lusa tanggal berapa'), /3 Maret 2026/);
});

test('does not classify unrelated sentences containing date words', () => {
  const { service } = serviceAt('2026-11-26T06:37:00.000Z');
  assert.equal(service.answer('Hari ini aku belajar Python'), null);
  assert.equal(service.answer('Tanggal berapa film ini dibuat?'), null);
});

test('invalid timezone falls back deterministically and context is recalculated', () => {
  let current = new Date('2026-11-26T06:37:00.000Z');
  const clock = createRuntimeClock({ now: () => current, timezone: 'invalid/timezone' });
  assert.equal(clock.timezone, 'Asia/Jakarta');
  assert.match(runtimeTemporalInstruction(clock), /LOCAL_DATE: 2026-11-26/);
  current = new Date('2026-11-27T06:37:00.000Z');
  assert.match(runtimeTemporalInstruction(clock), /LOCAL_DATE: 2026-11-27/);
});
