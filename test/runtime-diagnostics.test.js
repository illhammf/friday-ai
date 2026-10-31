import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRuntimeSummary,
  inspectRuntime,
} from '../src/config/runtime-diagnostics.js';

test('reports required runtime checks without exposing API key contents', async () => {
  const results = await inspectRuntime({
    env: { GEMINI_API_KEY: 'secret-key-value' },
    nodeVersion: 'v24.1.0',
    runCommand: async (_command, _args, label) => ({
      label,
      ok: true,
      required: false,
      detail: 'available',
      guidance: '',
    }),
  });

  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(results[1].detail, 'terkonfigurasi (nilai disembunyikan)');
  assert.doesNotMatch(JSON.stringify(results), /secret-key-value/);
  assert.equal(getRuntimeSummary(results).ok, true);
});

test('flags unsupported Node and missing optional media tools separately', async () => {
  const results = await inspectRuntime({
    env: {},
    nodeVersion: 'v18.19.1',
    runCommand: async (_command, _args, label, guidance) => ({
      label,
      ok: false,
      required: false,
      detail: 'tidak ditemukan di PATH',
      guidance,
    }),
  });
  const summary = getRuntimeSummary(results);

  assert.equal(summary.requiredFailed.length, 2);
  assert.equal(summary.failed.length, 4);
  assert.match(results[0].guidance, /Node\.js 24/);
  assert.match(results[2].guidance, /yt-dlp/);
  assert.match(results[3].guidance, /ffmpeg/);
});

test('does not make missing optional media tools block core readiness', () => {
  const summary = getRuntimeSummary([
    { label: 'Node.js', ok: true, required: true },
    { label: 'GEMINI_API_KEY', ok: true, required: true },
    { label: 'yt-dlp', ok: false, required: false },
    { label: 'ffmpeg', ok: false, required: false },
  ]);

  assert.equal(summary.ok, false);
  assert.equal(summary.requiredFailed.length, 0);
});

test('gives actionable guidance when yt-dlp exists but cannot execute', async () => {
  const results = await inspectRuntime({
    env: { GEMINI_API_KEY: 'configured' },
    nodeVersion: 'v24.1.0',
    runCommand: async (_command, _args, label, guidance) => ({
      label,
      ok: false,
      required: false,
      detail: 'file ditemukan tetapi bukan executable yt-dlp yang valid',
      guidance: label === 'yt-dlp'
        ? 'Unduh binary Linux resmi dari https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp lalu pastikan file dapat dijalankan.'
        : guidance,
    }),
  });
  const ytDlp = results.find((result) => result.label === 'yt-dlp');

  assert.equal(ytDlp.ok, false);
  assert.match(ytDlp.detail, /bukan executable/);
  assert.match(ytDlp.guidance, /releases\/latest\/download\/yt-dlp/);
});
