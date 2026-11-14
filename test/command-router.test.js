import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandRouter } from '../src/application/command-router.js';

function router() {
  return createCommandRouter({ botName: 'Friday', version: '1.2.3' });
}

test('/help, /ping, and /about return deterministic responses', () => {
  const commands = router();
  assert.match(commands.route('/help').response, /Perintah:/);
  assert.match(commands.route('/help').response, /tools.*belum tersedia/i);
  assert.equal(commands.route('/ping').response, 'Pong! Friday siap menerima pesan.');
  assert.match(commands.route('/about').response, /Friday — Asisten AI pribadi/);
  assert.match(commands.route('/about').response, /Versi aplikasi: 1\.2\.3/);
  assert.match(commands.route('/about').response, /masih dalam pengembangan/);
});

test('commands match case-insensitively and trim surrounding whitespace', () => {
  const commands = router();
  assert.equal(commands.route('  /PING  ').response, commands.route('/ping').response);
  assert.equal(commands.route('\n/ABOUT\t').response, commands.route('/about').response);
});

test('unknown, empty, malformed, and argument-bearing commands are handled safely', () => {
  const commands = router();
  assert.match(commands.route('/does-not-exist').response, /belum tersedia/);
  assert.match(commands.route('/').response, /Format perintah/);
  assert.match(commands.route('//ping').response, /Format perintah/);
  assert.match(commands.route('/ping ; process.exit()').response, /tidak menerima argumen/);
  assert.match(commands.route('/help $(whoami)').response, /tidak menerima argumen/);
});

test('ordinary and command-like prose is not parsed as a command', () => {
  const commands = router();
  assert.deepEqual(commands.route('tolong /help'), { handled: false });
  assert.deepEqual(commands.route(''), { handled: false });
  assert.deepEqual(commands.route(null), { handled: false });
});

test('router validates its application-owned configuration', () => {
  assert.throws(() => createCommandRouter({ botName: ' ' }), /bot name/);
  assert.throws(() => createCommandRouter({ version: '' }), /Version/);
  assert.throws(() => createCommandRouter({ description: '' }), /description/);
});
