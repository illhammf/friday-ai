function getErrorDetails(error) {
  const details = [];
  const seen = new Set();
  let current = error;

  while (current && !seen.has(current)) {
    seen.add(current);

    if (typeof current === 'string') {
      details.push(current);
      break;
    }

    if (typeof current !== 'object') {
      break;
    }

    details.push(
      current.code,
      current.message,
      current.stdout,
      current.stderr,
    );
    current = current.cause;
  }

  return details.filter(Boolean).join('\n');
}

export function getVideoDownloadFailureMessage(error, stage = 'download') {
  if (stage === 'send') {
    return 'Videonya berhasil diunduh, tetapi WhatsApp gagal mengirimnya. Coba lagi sebentar ya; jika masih gagal, videonya mungkin terlalu besar atau koneksi WhatsApp sedang bermasalah.';
  }

  const code = error?.code;
  const details = getErrorDetails(error);

  if (code === 'YT_DLP_NOT_INSTALLED') {
    return 'Fitur unduh video sedang belum tersedia di server. Admin perlu memeriksa yt-dlp.';
  }

  if (code === 'FFMPEG_NOT_INSTALLED') {
    return 'Video belum bisa disiapkan karena alat pemrosesan video di server tidak tersedia. Admin perlu memeriksa ffmpeg.';
  }

  if (code === 'TIKTOK_REQUEST_BLOCKED' || /\b429\b|too many requests|rate.?limit|captcha|challenge/i.test(details)) {
    return 'TikTok atau Instagram sedang membatasi permintaan dari server Friday. Coba lagi beberapa saat nanti.';
  }

  if (/private video|video is private|login required|log in to|sign in to|authentication required|age.?restricted|cookies are required/i.test(details)) {
    return 'Video ini tampaknya memerlukan login, izin khusus, atau batasan usia. Tautan yang bisa dibuka di aplikasi belum tentu dapat diakses server Friday; coba tautan publik lain yang tidak memerlukan akun.';
  }

  if (/video unavailable|video not found|not found|has been removed|does not exist|HTTP Error 404/i.test(details)) {
    return 'Video tidak ditemukan atau sudah dihapus dari platform. Periksa tautannya atau coba kirim video lain.';
  }

  if (/64 MB|too large|maximum file size|filesize.*exceed/i.test(details)) {
    return 'Video melebihi batas ukuran yang bisa diproses atau dikirim Friday (64 MB). Coba video yang lebih pendek atau berukuran lebih kecil.';
  }

  if (
    code === 'VIDEO_TRANSCODE_FAILED' ||
    code === 'VIDEO_TRANSCODE_TIMEOUT'
  ) {
    return 'Video berhasil diambil, tetapi formatnya belum bisa disiapkan untuk WhatsApp. Coba lagi nanti atau kirim tautan lain ya.';
  }

  if (
    error?.killed ||
    error?.signal === 'SIGTERM' ||
    /timed out|timeout|operation timed out/i.test(details)
  ) {
    return 'Proses unduh video terlalu lama dan dihentikan. Server mungkin sedang sibuk atau koneksi platform lambat; coba lagi nanti.';
  }

  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|network is unreachable|network error|temporary failure in name resolution/i.test(details)) {
    return 'Koneksi Friday ke platform video sedang bermasalah. Coba lagi nanti; tautanmu belum tentu bermasalah.';
  }

  return 'Friday belum bisa mengambil video dari platform. Penyebabnya bisa berupa pembatasan sementara, perubahan layanan, atau video yang membutuhkan akses khusus. Coba lagi nanti atau kirim tautan publik lain.';
}
