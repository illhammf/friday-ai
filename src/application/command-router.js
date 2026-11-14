const COMMANDS = Object.freeze(new Set(['help', 'ping', 'about']));

function createHelpText(botName) {
  return [
    `Aku ${botName}, asisten AI yang masih dalam pengembangan.`,
    '',
    'Kamu bisa ngobrol denganku dengan bahasa sehari-hari. Saat ini aku dapat membantu percakapan, memahami dan membuat gambar, memproses voice note, membuat stiker dari foto, mengunduh video TikTok/Instagram, serta menyimpan memori jika diminta di chat pribadi.',
    '',
    'Perintah:',
    '/help — melihat bantuan ini',
    '/ping — memeriksa respons Friday',
    '/about — informasi tentang Friday',
    '',
    'Memori hanya digunakan di chat pribadi. Aksi otomatis melalui tools dan beberapa integrasi masih belum tersedia atau dapat bersifat eksperimental.',
  ].join('\n');
}

/** Creates a deterministic router. Command arguments are never evaluated. */
export function createCommandRouter({
  botName = 'Friday',
  version = null,
  description = 'Asisten AI pribadi yang membantu percakapan sehari-hari melalui WhatsApp.',
} = {}) {
  if (typeof botName !== 'string' || !botName.trim()) {
    throw new TypeError('A non-empty bot name is required.');
  }
  if (version != null && (typeof version !== 'string' || !version.trim())) {
    throw new TypeError('Version must be a non-empty string when provided.');
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new TypeError('A non-empty description is required.');
  }

  const name = botName.trim();
  const helpText = createHelpText(name);

  return Object.freeze({
    route(input) {
      if (typeof input !== 'string') return Object.freeze({ handled: false });
      const text = input.trim();
      if (!text.startsWith('/')) return Object.freeze({ handled: false });

      const match = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
      if (!match) {
        return Object.freeze({
          handled: true,
          response: 'Format perintah tidak dikenali. Ketik /help untuk melihat perintah yang tersedia.',
        });
      }

      const command = match[1].toLowerCase();
      const args = match[2]?.trim() || '';
      if (!COMMANDS.has(command)) {
        return Object.freeze({
          handled: true,
          response: `Perintah /${command} belum tersedia. Ketik /help untuk melihat perintah yang tersedia.`,
        });
      }
      if (args) {
        return Object.freeze({
          handled: true,
          response: `Perintah /${command} tidak menerima argumen.`,
        });
      }
      if (command === 'help') {
        return Object.freeze({ handled: true, response: helpText });
      }
      if (command === 'ping') {
        return Object.freeze({ handled: true, response: `Pong! ${name} siap menerima pesan.` });
      }

      return Object.freeze({
        handled: true,
        response: [
          `${name} — ${description}`,
          version ? `Versi aplikasi: ${version}` : null,
          'Friday masih dalam pengembangan.',
        ].filter(Boolean).join('\n'),
      });
    },
  });
}
