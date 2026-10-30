import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 180_000;
const SUPPORTED_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'instagr.am',
  'www.instagr.am',
  'tiktok.com',
  'www.tiktok.com',
  'm.tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
]);

export function getSocialVideoUrls(text) {
  const candidates = String(text || '').match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  const urls = new Set();

  for (const candidate of candidates) {
    const trimmed = candidate.replace(/[),.!?;:]+$/g, '');

    try {
      const url = new URL(trimmed);

      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.port ||
        !SUPPORTED_HOSTS.has(url.hostname.toLowerCase())
      ) {
        continue;
      }

      urls.add(url.href);
    } catch {
      continue;
    }
  }

  return [...urls];
}

export async function downloadSocialVideo(url) {
  const urls = getSocialVideoUrls(url);

  if (urls.length !== 1) {
    throw new Error('Tautan video TikTok atau Instagram tidak valid.');
  }

  const [validatedUrl] = urls;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'friday-video-'));
  const outputTemplate = join(temporaryDirectory, '%(id)s.%(ext)s');
  let completed = false;

  try {
    try {
      await execFileAsync(
        process.env.YT_DLP_PATH || 'yt-dlp',
        [
          '--ignore-config',
          '--no-cache-dir',
          '--no-warnings',
          '--no-progress',
          '--no-playlist',
          '--max-filesize',
          '64M',
          '--format',
          'best[ext=mp4]/best',
          '--merge-output-format',
          'mp4',
          '--remux-video',
          'mp4',
          '--output',
          outputTemplate,
          validatedUrl,
        ],
        {
          timeout: VIDEO_DOWNLOAD_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(
          'yt-dlp tidak ditemukan. Pasang yt-dlp dan pastikan tersedia di PATH.',
        );
      }

      throw error;
    }

    const videoFiles = (await readdir(temporaryDirectory, {
      withFileTypes: true,
    }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mp4'))
      .map((entry) => join(temporaryDirectory, entry.name));

    if (videoFiles.length !== 1) {
      throw new Error('yt-dlp tidak menghasilkan satu file video MP4.');
    }

    const videoPath = videoFiles[0];
    const videoStats = await stat(videoPath);

    if (videoStats.size > MAX_VIDEO_BYTES) {
      throw new Error('Ukuran video melebihi batas pengiriman 64 MB.');
    }

    completed = true;

    return {
      path: videoPath,
      cleanup: () => rm(temporaryDirectory, {
        recursive: true,
        force: true,
      }),
    };
  } finally {
    if (!completed) {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  }
}
