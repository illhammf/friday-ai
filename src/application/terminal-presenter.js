const ANSI = Object.freeze({
  reset: '\x1b[0m', bold: '\x1b[1m', gray: '\x1b[90m', cyan: '\x1b[36m',
  blue: '\x1b[34m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', purple: '\x1b[35m',
});

const STAGES = Object.freeze({
  message_received: ['MESSAGE RECEIVED', 'cyan'],
  message_processing_started: ['PROCESSING', 'yellow'],
  message_processing: ['PROCESSING', 'yellow'],
  ai_request: ['AI REQUEST', 'purple'],
  ai_provider_request: ['FRIDAY IS THINKING', 'purple'],
  ai_provider_attempt: ['AI THINKING', 'purple'],
  ai_retry_scheduled: ['AI RETRY', 'yellow'],
  ai_model_fallback: ['MODEL FALLBACK', 'yellow'],
  ai_provider_response: ['GENERATING RESPONSE', 'purple'],
  reply_submission: ['REPLY SUBMISSION', 'blue'],
  history_persistence: ['HISTORY SAVED', 'green'],
  inbound_history_persistence: ['INPUT SAVED', 'green'],
  queue_processing: ['QUEUE FAILED', 'red'],
  application_error: ['FAILED', 'red'],
});

function cleanPreview(value, maxLength) {
  const text = String(value || '')
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function safeTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('id-ID', { timeZone: timezone }).format();
    return timezone;
  } catch {
    return 'Asia/Jakarta';
  }
}

function localTime(now, timezone) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(now).replace(/\./g, ':');
}

function localDate(now, timezone) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: timezone, weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  }).format(now).toLocaleUpperCase('id-ID');
}

/** Presents sanitized runtime events without becoming the observability source. */
export function createTerminalPresenter({
  mode = process.env.FRIDAY_LOG_MODE || 'human',
  stream = process.stdout,
  errorStream = process.stderr,
  now = () => new Date(),
  timezone = process.env.FRIDAY_TIMEZONE || 'Asia/Jakarta',
  previews = process.env.FRIDAY_MESSAGE_PREVIEWS === 'true',
  color = stream.isTTY && !process.env.NO_COLOR,
} = {}) {
  const safeMode = ['human', 'json', 'quiet'].includes(mode) ? mode : 'human';
  const activeTimezone = safeTimezone(timezone);
  const useColor = Boolean(color) && stream.isTTY !== false && !process.env.NO_COLOR && safeMode === 'human';
  const paint = (value, tone) => useColor ? `${ANSI[tone] || ''}${value}${ANSI.reset}` : value;
  const write = (line, { error = false } = {}) => {
    try { (error ? errorStream : stream).write(`${line}\n`); } catch { /* diagnostics must not break processing */ }
  };
  const timestamp = () => paint(`[${localTime(now(), activeTimezone)}]`, 'gray');
  const json = (event) => write(JSON.stringify(event));

  function stage(stageName, fields = {}) {
    const event = { timestamp: now().toISOString(), component: 'conversation', stage: stageName, ...fields };
    if (safeMode === 'quiet') return;
    if (safeMode === 'json') return json(event);
    const [label, tone] = STAGES[stageName] || ['RUNTIME', 'cyan'];
    let outcome = fields.outcome === 'submitted' ? 'ANSWER SUBMITTED'
      : fields.outcome === 'uncertain' ? 'DELIVERY UNCERTAIN'
        : fields.outcome === 'failed' ? 'FAILED'
          : label;
    const details = [
      fields.modelId ? `model ${fields.modelId}` : '',
      fields.nextModelId ? `next ${fields.nextModelId}` : '',
      Number.isFinite(fields.durationMs) ? `${fields.durationMs}ms` : '',
      Number.isFinite(fields.totalTokens) ? `${fields.totalTokens} tokens` : '',
      fields.category ? fields.category : '',
      Number.isInteger(fields.httpStatus) ? `HTTP ${fields.httpStatus}` : '',
    ].filter(Boolean).join(' · ');
    write(`${timestamp()} ${paint('●', tone)} ${paint(outcome, tone)}${details ? ` ${paint(`— ${details}`, 'gray')}` : ''}`,
      { error: fields.outcome === 'failed' });
  }

  return Object.freeze({
    startup({ name = 'FRIDAY AI', version = 'unknown', model = 'unknown', nodeVersion = process.version } = {}) {
      if (safeMode !== 'human') return;
      const date = localDate(now(), activeTimezone);
      write(paint('╭──────────────────────────────────────────────╮', 'cyan'));
      write(`${paint('│', 'cyan')} ${paint(name, 'bold')} ${paint(`v${version}`, 'gray')}`);
      write(`${paint('│', 'cyan')} ${paint(date, 'gray')}`);
      write(`${paint('│', 'cyan')} Node ${nodeVersion} · Gemini ${model}`);
      write(`${paint('│', 'cyan')} ${paint('DATABASE READY · WHATSAPP CONNECTING · RUNTIME WAITING', 'yellow')}`);
      write(paint('╰──────────────────────────────────────────────╯', 'cyan'));
    },
    status(label, tone = 'cyan', detail = '') {
      if (safeMode === 'quiet') return;
      if (safeMode === 'json') return json({ timestamp: now().toISOString(), component: 'runtime', status: label, detail });
      write(`${timestamp()} ${paint('●', tone)} ${paint(label, tone)}${detail ? ` ${paint(`— ${detail}`, 'gray')}` : ''}`);
    },
    incoming({ conversationType, messageType = 'chat', preview } = {}) {
      if (safeMode === 'quiet') return;
      const category = conversationType === 'group' ? 'GROUP MESSAGE' : 'PRIVATE MESSAGE';
      if (safeMode === 'json') return json({ timestamp: now().toISOString(), component: 'conversation', event: 'incoming', conversationType, messageType, hasPreview: Boolean(preview) });
      write(`${timestamp()} ${paint('●', 'cyan')} ${paint(category, 'cyan')} ${paint(`· ${messageType}`, 'gray')}`);
      if (previews && preview) write(`${paint('           ', 'gray')}${cleanPreview(preview, 160)}`);
    },
    stage,
    event(type, title, detail = '') {
      const tone = ({ success: 'green', warn: 'yellow', error: 'red', ai: 'purple', voice: 'blue' })[type] || 'cyan';
      if (safeMode === 'quiet') return;
      if (safeMode === 'json') return json({ timestamp: now().toISOString(), component: 'runtime', type, title, detail });
      write(`${timestamp()} ${paint('●', tone)} ${paint(title, tone)}${detail ? ` ${paint(`— ${detail}`, 'gray')}` : ''}`, { error: type === 'error' });
    },
  });
}
