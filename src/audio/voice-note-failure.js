export function isVoiceNoteQuotaError(error) {
  const status = Number(error?.status || error?.code);
  const details = [
    error?.message,
    error?.status,
    error?.code,
    error?.error?.message,
    error?.error?.status,
  ]
    .filter((value) => value != null)
    .map((value) => String(value))
    .join(' ');

  return (
    status === 429 ||
    /RESOURCE_EXHAUSTED|quota exceeded|exceeded your current quota|rate.?limit|billing details/i.test(details)
  );
}

export function getVoiceNoteFailureMessage(error, answer) {
  const explanation = isVoiceNoteQuotaError(error)
    ? 'Layanan Voice Note sedang mencapai batas penggunaan.'
    : 'Voice Note belum bisa dikirim saat ini.';

  return `${explanation}\n\nAku kirim jawabanku dalam bentuk teks:\n\n${answer}`;
}
