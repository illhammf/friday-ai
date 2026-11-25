import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalPresenter } from '../src/application/terminal-presenter.js';

function sink({ tty = false } = {}) {
  let value = '';
  return {
    isTTY: tty,
    write(chunk) { value += chunk; },
    text() { return value; },
  };
}

test('renders readable human output without ANSI when color is disabled', () => {
  const stream = sink({ tty: true });
  const presenter = createTerminalPresenter({
    stream,
    errorStream: stream,
    color: false,
    now: () => new Date('2026-11-19T01:54:21.000Z'),
    timezone: 'Asia/Jakarta',
    previews: true,
  });
  presenter.startup({ name: 'FRIDAY AI', version: '1.0.0', model: 'gemini-test' });
  presenter.incoming({ conversationType: 'private', messageType: 'chat', preview: 'Halo\n\u001b[31mrahasia\u001b[0m' });
  assert.match(stream.text(), /FRIDAY AI/);
  assert.match(stream.text(), /PRIVATE MESSAGE/);
  assert.doesNotMatch(stream.text(), /\u001b\[/);
  assert.match(stream.text(), /rahasia/);
});

test('falls back safely for invalid timezone and supports NO_COLOR-like non-TTY output', () => {
  const stream = sink();
  const presenter = createTerminalPresenter({
    stream,
    errorStream: stream,
    color: true,
    now: () => new Date('2026-11-19T01:54:21.000Z'),
    timezone: 'not/a-real-zone',
  });
  presenter.status('WAITING', 'yellow');
  assert.match(stream.text(), /\[08:54:21\]/);
  assert.doesNotMatch(stream.text(), /\u001b\[/);
});

test('json mode keeps safe operational fields and does not include previews', () => {
  const stream = sink();
  const presenter = createTerminalPresenter({ mode: 'json', stream, errorStream: stream });
  presenter.incoming({ conversationType: 'group', messageType: 'chat', preview: 'private content' });
  const event = JSON.parse(stream.text());
  assert.equal(event.conversationType, 'group');
  assert.equal(event.hasPreview, true);
  assert.equal('preview' in event, false);
  assert.doesNotMatch(stream.text(), /private content/);
});

test('json startup is machine-readable and quiet mode still reports critical failures', () => {
  const jsonStream = sink();
  const jsonPresenter = createTerminalPresenter({ mode: 'json', stream: jsonStream, errorStream: jsonStream });
  jsonPresenter.startup({ name: 'FRIDAY AI', version: '1.0.0', model: 'gemini-test' });
  const startup = JSON.parse(jsonStream.text());
  assert.equal(startup.event, 'startup');
  assert.equal(startup.status, 'starting');

  const quietStream = sink();
  const quietPresenter = createTerminalPresenter({ mode: 'quiet', stream: quietStream, errorStream: quietStream });
  quietPresenter.stage('ai_provider_response', { outcome: 'completed' });
  quietPresenter.stage('reply_submission', { outcome: 'uncertain', category: 'transport_uncertain' });
  quietPresenter.event('error', 'RUNTIME ERROR', 'safe diagnostic');
  assert.match(quietStream.text(), /DELIVERY UNCERTAIN/);
  assert.match(quietStream.text(), /RUNTIME ERROR/);
  assert.doesNotMatch(quietStream.text(), /GENERATING RESPONSE/);
});

test('terminal write failures are isolated from the caller', () => {
  const stream = { isTTY: false, write() { throw new Error('closed'); } };
  const presenter = createTerminalPresenter({ stream, errorStream: stream });
  assert.doesNotThrow(() => presenter.stage('application_error', { outcome: 'failed' }));
});
