function getErrorDetails(error) {
  return [
    error?.message,
    error?.status,
    error?.code,
    error?.error?.message,
    error?.error?.status,
  ]
    .filter((value) => value != null)
    .map(String)
    .join(' ');
}

export function getAiFailureMessage(error) {
  const status = Number(error?.status || error?.code);
  const details = getErrorDetails(error);

  if (
    status === 429 ||
    /RESOURCE_EXHAUSTED|quota exceeded|rate.?limit/i.test(details)
  ) {
    return 'Layanan AI sedang membatasi permintaan. Coba lagi beberapa saat nanti ya.';
  }

  if (
    [500, 502, 503, 504].includes(status) ||
    /UNAVAILABLE|high demand|overloaded|temporarily unavailable/i.test(details)
  ) {
    return 'Layanan AI sedang sibuk atau sementara tidak tersedia. Coba lagi sebentar ya.';
  }

  if (
    [401, 403].includes(status) ||
    /invalid api key|api key not valid|permission denied|unauthorized/i.test(details)
  ) {
    return 'Layanan AI Friday sedang tidak tersedia saat ini. Tim pengelola perlu memeriksa konfigurasi layanan.';
  }

  return 'Maaf, Friday sedang mengalami kendala dan belum bisa membalas sekarang. Coba lagi nanti ya.';
}
