import test from 'node:test';
import assert from 'node:assert/strict';
import { access, truncate, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  downloadSocialVideo,
  getSocialVideoUrls,
} from '../src/video/download-social-video.js';
import { isSocialVideoDownloadRequest } from '../src/video/video-download-request.js';

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

test('requires an explicit download command for a supported video link', () => {
  for (const text of [
    'Tolong download video ini https://www.tiktok.com/@user/video/123',
    'Unduh reels https://www.instagram.com/reel/abc/',
    'Simpan video dari https://vm.tiktok.com/abc123',
    'Downloadin video ini: https://www.instagram.com/reel/abc/',
    'Tolong download link ini https://www.tiktok.com/@user/video/123',
  ]) {
    assert.equal(isSocialVideoDownloadRequest(text), true, text);
  }

  for (const text of [
    'Apa isi video ini https://www.tiktok.com/@user/video/123',
    'Jangan download video ini https://www.tiktok.com/@user/video/123',
    'https://www.instagram.com/reel/abc/',
    'Download gambar ini https://example.com/photo.jpg',
  ]) {
    assert.equal(isSocialVideoDownloadRequest(text), false, text);
  }
});

test('downloads one MP4 and cleans up its temporary directory', async () => {
  let outputPath;

  const result = await downloadSocialVideo(
    'https://www.tiktok.com/@user/video/123',
    async (_command, args) => {
      const userAgentIndex = args.indexOf('--user-agent');
      assert.notEqual(userAgentIndex, -1);
      assert.match(args[userAgentIndex + 1], /Mozilla\/5\.0.*Chrome/);
      const outputIndex = args.indexOf('--output');
      const outputTemplate = args[outputIndex + 1];
      outputPath = outputTemplate.replace('%(id)s.%(ext)s', '123.mp4');
      await (await import('node:fs/promises')).writeFile(outputPath, 'video');
    },
  );

  assert.equal(result.path, outputPath);
  assert.equal((await (await import('node:fs/promises')).stat(result.path)).size, 5);
  await result.cleanup();
  await assert.rejects(
    (await import('node:fs/promises')).access(outputPath),
  );
});

test('reports a missing yt-dlp executable and removes its temporary directory', async () => {
  let temporaryDirectory;
  const missingExecutable = Object.assign(new Error('not found'), {
    code: 'ENOENT',
  });

  await assert.rejects(
    downloadSocialVideo(
      'https://www.tiktok.com/@user/video/123',
      async (_command, args) => {
        temporaryDirectory = dirname(args[args.indexOf('--output') + 1]);
        throw missingExecutable;
      },
    ),
    (error) => error.code === 'YT_DLP_NOT_INSTALLED',
  );

  await assert.rejects(access(temporaryDirectory));
});

test('reports missing ffmpeg separately from other download failures', async () => {
  await assert.rejects(
    downloadSocialVideo(
      'https://www.instagram.com/reel/abc/',
      async () => {
        throw new Error('ERROR: ffmpeg not found');
      },
    ),
    (error) => error.code === 'FFMPEG_NOT_INSTALLED',
  );
});

test('passes a configured ffmpeg executable path to yt-dlp', async () => {
  const previousFfmpegPath = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = '/custom/bin/ffmpeg';

  try {
    await assert.rejects(
      downloadSocialVideo(
        'https://www.instagram.com/reel/abc/',
        async (_command, args) => {
          assert.ok(args.includes('--ffmpeg-location'));
          assert.ok(args.includes('/custom/bin/ffmpeg'));
          throw new Error('stop after checking arguments');
        },
      ),
      /stop after checking arguments/,
    );
  } finally {
    if (previousFfmpegPath === undefined) {
      delete process.env.FFMPEG_PATH;
    } else {
      process.env.FFMPEG_PATH = previousFfmpegPath;
    }
  }
});

test('rejects oversized downloads and removes the temporary file', async () => {
  let outputPath;

  await assert.rejects(
    downloadSocialVideo(
      'https://www.tiktok.com/@user/video/123',
      async (_command, args) => {
        const outputTemplate = args[args.indexOf('--output') + 1];
        outputPath = outputTemplate.replace('%(id)s.%(ext)s', '123.mp4');
        await writeFile(outputPath, '');
        await truncate(outputPath, 64 * 1024 * 1024 + 1);
      },
    ),
    /Ukuran video melebihi batas pengiriman 64 MB/,
  );

  await assert.rejects(access(dirname(outputPath)));
});

test('reports TikTok webpage challenge failures with a stable error code', async () => {
  const commandError = Object.assign(
    new Error('Command failed: yt-dlp'),
    {
      code: 1,
      stderr: 'ERROR: [TikTok] Unexpected response from webpage request',
    },
  );

  await assert.rejects(
    downloadSocialVideo(
      'https://www.tiktok.com/@user/video/123',
      async () => {
        throw commandError;
      },
    ),
    (error) => (
      error.code === 'TIKTOK_REQUEST_BLOCKED' &&
      error.cause === commandError
    ),
  );
});
