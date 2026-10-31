import test from 'node:test';
import assert from 'node:assert/strict';
import { getVideoDownloadFailureMessage } from '../src/video/video-download-failure.js';

test('explains platform throttling without blaming the link', () => {
  const message = getVideoDownloadFailureMessage({
    code: 'TIKTOK_REQUEST_BLOCKED',
    cause: {
      stderr: 'HTTP Error 429: Too Many Requests',
    },
  });

  assert.match(message, /sedang membatasi permintaan/);
  assert.match(message, /[Cc]oba lagi beberapa saat/);
  assert.doesNotMatch(message, /token|cookie|stack/i);
});

test('explains login and access restrictions without exposing internal errors', () => {
  const message = getVideoDownloadFailureMessage({
    code: 1,
    stderr: 'ERROR: Login required. This video is private.',
  });

  assert.match(message, /memerlukan login/);
  assert.match(message, /tidak memerlukan akun/);
  assert.doesNotMatch(message, /Login required|This video is private/);
});

test('provides actionable explanations for unavailable, oversized, and network failures', () => {
  assert.match(
    getVideoDownloadFailureMessage({ stderr: 'HTTP Error 404: Not Found' }),
    /tidak ditemukan atau sudah dihapus/,
  );
  assert.match(
    getVideoDownloadFailureMessage({ message: 'File exceeds 64 MB maximum file size' }),
    /batas ukuran.*64 MB/,
  );
  assert.match(
    getVideoDownloadFailureMessage({ code: 'ECONNRESET' }),
    /Koneksi Friday ke platform video sedang bermasalah/,
  );
});

test('distinguishes sending and conversion failures from download failures', () => {
  assert.match(
    getVideoDownloadFailureMessage(new Error('send failed'), 'send'),
    /berhasil diunduh, tetapi WhatsApp gagal mengirimnya/,
  );
  assert.match(
    getVideoDownloadFailureMessage({ code: 'VIDEO_TRANSCODE_FAILED' }),
    /formatnya belum bisa disiapkan/,
  );
});

test('keeps internal stacks and provider diagnostics out of generic WhatsApp replies', () => {
  const error = new Error('private stack detail');
  error.stderr = 'internal endpoint returned an unexpected response';

  const message = getVideoDownloadFailureMessage(error);

  assert.match(message, /Penyebabnya bisa berupa pembatasan sementara/);
  assert.doesNotMatch(message, /private stack detail|internal endpoint|unexpected response/);
});
