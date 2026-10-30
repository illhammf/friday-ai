import test from 'node:test';
import assert from 'node:assert/strict';
import {
  downloadSocialVideo,
  getSocialVideoUrls,
} from '../src/video/download-social-video.js';

test('accepts TikTok and Instagram video links', () => {
  assert.deepEqual(
    getSocialVideoUrls(
      'TikTok https://www.tiktok.com/@user/video/123 and https://www.instagram.com/reel/abc/',
    ),
    [
      'https://www.tiktok.com/@user/video/123',
      'https://www.instagram.com/reel/abc/',
    ],
  );
});

test('accepts short TikTok links and strips trailing punctuation', () => {
  assert.deepEqual(
    getSocialVideoUrls('https://vm.tiktok.com/abc123.'),
    ['https://vm.tiktok.com/abc123'],
  );
});

test('rejects unrelated hosts and URLs with credentials', () => {
  assert.deepEqual(
    getSocialVideoUrls(
      'https://example.com/video https://user:pass@www.instagram.com/reel/abc',
    ),
    [],
  );
});

test('does not accept lookalike domains or custom ports', () => {
  assert.deepEqual(
    getSocialVideoUrls(
      'https://instagram.com.example.org/reel/abc https://tiktok.com:8080/@user/video/123',
    ),
    [],
  );
});

test('does not invoke the downloader for unsupported URLs', async () => {
  await assert.rejects(
    downloadSocialVideo('https://example.com/video'),
    /Tautan video TikTok atau Instagram tidak valid/,
  );
});
