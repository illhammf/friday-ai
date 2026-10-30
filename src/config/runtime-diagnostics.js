import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function getNodeMajorVersion(version) {
  const match = String(version).match(/^v?(\d+)\./);
  return match ? Number(match[1]) : null;
}

async function checkCommand(command, args, label, guidance) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });

    return {
      label,
      ok: true,
      required: false,
      detail: String(stdout).trim().split(/\r?\n/, 1)[0] || 'tersedia',
      guidance: '',
    };
  } catch (error) {
    return {
      label,
      ok: false,
      required: false,
      detail: error?.code === 'ENOENT'
        ? 'tidak ditemukan di PATH'
        : error?.killed
          ? 'pemeriksaan timeout'
          : `gagal diperiksa (${error?.code || error?.message || 'unknown'})`,
      guidance,
    };
  }
}

export async function inspectRuntime({
  env = process.env,
  nodeVersion = process.versions.node,
  runCommand = checkCommand,
} = {}) {
  const nodeMajor = getNodeMajorVersion(nodeVersion);
  const results = [
    {
      label: 'Node.js',
      ok: nodeMajor !== null && nodeMajor >= 24,
      required: true,
      detail: `v${nodeVersion}`,
      guidance: 'Gunakan Node.js 24 atau lebih baru sesuai engines di package.json.',
    },
    {
      label: 'GEMINI_API_KEY',
      ok: Boolean(env.GEMINI_API_KEY?.trim()),
      required: true,
      detail: env.GEMINI_API_KEY?.trim()
        ? 'terkonfigurasi (nilai disembunyikan)'
        : 'belum terkonfigurasi',
      guidance: 'Isi GEMINI_API_KEY di .env; jangan tampilkan atau bagikan nilainya.',
    },
  ];

  const mediaChecks = await Promise.all([
    runCommand(
      env.YT_DLP_PATH || 'yt-dlp',
      ['--version'],
      'yt-dlp',
      'Pasang yt-dlp atau atur YT_DLP_PATH untuk fitur unduh TikTok/Reels.',
    ),
    runCommand(
      env.FFMPEG_PATH || 'ffmpeg',
      ['-version'],
      'ffmpeg',
      'Pasang ffmpeg atau atur FFMPEG_PATH untuk Voice Note dan pemrosesan video.',
    ),
  ]);

  return [...results, ...mediaChecks];
}

export function getRuntimeSummary(results) {
  const failed = results.filter((result) => !result.ok);

  return {
    ok: failed.length === 0,
    failed,
    requiredFailed: failed.filter((result) => result.required),
  };
}
