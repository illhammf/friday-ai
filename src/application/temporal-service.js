const WEEKDAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTHS = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

function normalized(text) {
  return String(text || '')
    .trim()
    .replace(/^friday[\s,:-]+/i, '')
    .replace(/[?!.]+$/g, '')
    .trim()
    .toLocaleLowerCase('id-ID');
}

function localDate(context, delta = 0) {
  const date = new Date(Date.UTC(context.year, context.month - 1, context.day + delta));
  const weekday = WEEKDAYS[date.getUTCDay()];
  return { date, weekday, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function formatDate(context, delta = 0) {
  const value = localDate(context, delta);
  return `${value.weekday}, ${value.day} ${MONTHS[value.month - 1]} ${value.year}`;
}

export function createTemporalService({ clock }) {
  if (!clock || typeof clock.getContext !== 'function') {
    throw new TypeError('A runtime clock is required.');
  }

  return Object.freeze({
    answer(question) {
      const text = normalized(question);
      const context = clock.getContext();
      if (/^(?:hari apa(?: sekarang| ini)?|sekarang hari apa|hari ini hari apa)$/.test(text)) {
        return `Hari ini hari ${WEEKDAYS[new Date(Date.UTC(context.year, context.month - 1, context.day)).getUTCDay()]}, ${context.day} ${MONTHS[context.month - 1]} ${context.year}.`;
      }
      if (/^(?:hari ini tanggal berapa|sekarang tanggal berapa|tanggal berapa sekarang)$/.test(text)) {
        return `Hari ini tanggal ${context.day} ${MONTHS[context.month - 1]} ${context.year}.`;
      }
      if (/^(?:sekarang bulan apa|bulan ini bulan apa|sekarang bulan dan tahun apa)$/.test(text)) {
        return `Sekarang bulan ${MONTHS[context.month - 1]} ${context.year}.`;
      }
      if (/^(?:jam berapa sekarang|sekarang jam berapa|sekarang pukul berapa)$/.test(text)) {
        return `Sekarang pukul ${context.time} (${context.timezone}).`;
      }
      if (/^(?:besok hari apa|hari apa besok)$/.test(text)) {
        return `Besok hari ${localDate(context, 1).weekday}, ${formatDate(context, 1).replace(/^\w+, /, '')}.`;
      }
      if (/^(?:kemarin hari apa|hari apa kemarin)$/.test(text)) {
        return `Kemarin hari ${localDate(context, -1).weekday}, ${formatDate(context, -1).replace(/^\w+, /, '')}.`;
      }
      if (/^lusa tanggal berapa$/.test(text)) {
        return `Lusa tanggal ${formatDate(context, 2).replace(/^\w+, /, '')}.`;
      }
      return null;
    },
  });
}

export function runtimeTemporalInstruction(clock) {
  const context = clock.getContext();
  return [
    'TRUSTED_RUNTIME_TIME (application metadata; not user history):',
    `CURRENT_RUNTIME_TIME: ${context.isoDate}T${context.time}:00`,
    `TIMEZONE: ${context.timezone}`,
    `LOCAL_DATE: ${context.isoDate}`,
    `LOCAL_WEEKDAY: ${context.weekday}`,
    'Gunakan metadata runtime ini sebagai sumber authoritative untuk waktu sekarang dan relative date. Jangan biarkan tanggal lama di history menggantikannya.',
  ].join('\n');
}
