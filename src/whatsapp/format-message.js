function normalizeTableRows(lines) {
  const rows = lines.map((line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim()),
  );
  const isSeparator = (cells) =>
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')));
  const contentRows = rows.filter((cells) => !isSeparator(cells));

  if (contentRows.length < 2) {
    return contentRows.map((cells) => cells.filter(Boolean).join(' — '));
  }

  const [headers, ...dataRows] = contentRows;

  return dataRows.map((cells) => {
    const values = cells
      .map((value, index) => {
        const header = headers[index];
        return value && header && value.toLowerCase() !== header.toLowerCase()
          ? `${header}: ${value}`
          : value;
      })
      .filter(Boolean);

    return values.length ? `• ${values.join(' · ')}` : '';
  });
}

export function formatWhatsAppMessage(value) {
  if (typeof value !== 'string') {
    return '';
  }

  let text = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
  const codeBlocks = [];

  text = text.replace(
    /```([^\n`]*)\n?([\s\S]*?)```/g,
    (_match, _language, code) => {
      const token = `\u0000CODE_BLOCK_${codeBlocks.length}\u0000`;
      codeBlocks.push(`\`\`\`\n${code.trimEnd()}\n\`\`\``);
      return token;
    },
  );

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6])\s*>/gi, '\n')
    .replace(/<(?:p|div|h[1-6])\b[^>]*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*(.*?)[ \t]*#*[ \t]*$/gm, '$1')
    .replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*[-+*][ \t]+/gm, '• ')
    .replace(/^[ \t]*(\d+)[.)][ \t]+/gm, '$1. ')
    .replace(/\*\*([^*\n]+)\*\*/g, '\u0000WHATSAPP_BOLD_$1\u0000')
    .replace(/__([^_\n]+)__/g, '\u0000WHATSAPP_BOLD_$1\u0000')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '_$1_')
    .replace(/~~([^~\n]+)~~/g, '~$1~')
    .replace(/\u0000WHATSAPP_BOLD_([^\u0000]*)\u0000/g, '*$1*');

  const lines = text.split('\n');

  for (let index = 0; index < lines.length;) {
    if (!/^[ \t]*\|.*\|[ \t]*$/.test(lines[index])) {
      index++;
      continue;
    }

    const start = index;

    while (
      index < lines.length &&
      /^[ \t]*\|.*\|[ \t]*$/.test(lines[index])
    ) {
      index++;
    }

    const replacement = normalizeTableRows(lines.slice(start, index));
    lines.splice(start, index - start, ...replacement);
    index = start + replacement.length;
  }

  text = lines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.replace(/\u0000CODE_BLOCK_(\d+)\u0000/g, (_match, index) =>
    codeBlocks[Number(index)],
  );
}
