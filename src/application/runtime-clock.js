const DEFAULT_TIMEZONE = 'Asia/Jakarta';

function validateTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone.trim()) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function partsFor(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', weekday: 'long',
  }).formatToParts(date);
  return Object.fromEntries(parts
    .filter(({ type }) => type !== 'literal')
    .map(({ type, value }) => [type, value]));
}

export function createRuntimeClock({ now = () => new Date(), timezone } = {}) {
  const activeTimezone = validateTimezone(timezone || process.env.FRIDAY_TIMEZONE);

  function getContext() {
    const current = now();
    if (!(current instanceof Date) || Number.isNaN(current.getTime())) {
      throw new TypeError('Runtime clock returned an invalid Date.');
    }
    const parts = partsFor(current, activeTimezone);
    return Object.freeze({
      now: current,
      timezone: activeTimezone,
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second),
      weekday: parts.weekday,
      isoDate: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}:${parts.second}`,
    });
  }

  return Object.freeze({ timezone: activeTimezone, getContext });
}

export const DEFAULT_RUNTIME_TIMEZONE = DEFAULT_TIMEZONE;
