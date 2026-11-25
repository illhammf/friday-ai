import { getMemoryTerms } from './memory-retriever.js';

export const RECENT_CONVERSATION_MESSAGES = 4;
export const RELEVANT_EARLIER_MESSAGES = 4;
export const RECENT_RECALL_MESSAGES = 8;
const SHORT_NON_SUBSTANTIVE_MESSAGES = new Set([
  'tes', 'test', 'halo', 'hai', 'pagi', 'siang', 'sore', 'malam',
  'oke', 'ok', 'makasih', 'terima kasih', 'siap', 'hmm', 'hehe', 'wkwk',
]);
const GENERIC_CONTEXT_TERMS = new Set([
  'baru', 'saja', 'sedang', 'ingin', 'memahami', 'topik', 'sebutkan',
  'kembali', 'ceritakan', 'sebelumnya', 'minta', 'hal', 'tadi', 'pernah',
]);
const TOPIC_SWITCH_PATTERN = /\b(?:sekarang|now|ganti|switch|pindah|beralih|bahas|membahas|discuss|let['’]?s\s+(?:discuss|talk)|let's)\b/i;
const HISTORICAL_RECALL_PATTERN = /\b(?:sebelumnya|sebelum|tadi|barusan|yang\s+(?:aku|saya)\s+(?:bilang|ceritakan|minta)|apa\s+yang\s+(?:aku|saya)|previous(?:ly)?|earlier|before|what\s+did\s+i)\b/i;

function messageText(message) {
  return (message?.parts || [])
    .map((part) => part?.text)
    .filter((text) => typeof text === 'string')
    .join(' ');
}

export function isShortNonSubstantiveMessage(question) {
  const normalized = String(question || '')
    .trim()
    .toLocaleLowerCase('id-ID')
    .replace(/(.)\1+/gu, '$1');
  return SHORT_NON_SUBSTANTIVE_MESSAGES.has(normalized);
}

export function isIdentityQuestion(question) {
  const text = String(question || '').trim();
  return /(?:\b(?:siapa|who)\s+(?:kamu|dirimu|you)\b|\b(?:kamu|you)\s+(?:siapa|who)\b|\bperkenalkan(?:\s+dirimu)?\b|\btentang\s+(?:kamu|dirimu|friday)\b|\bbahas\s+(?:kamu|dirimu|friday)\b|\b(?:kamu|dirimu)\s+aja\b)/i.test(text);
}

export function isRecentHistoryQuestion(question) {
  return /\b(?:tadi|barusan|baru\s+saja|apa\s+yang\s+(?:kita|aku|saya)\s+(?:bahas|bicarakan)|what\s+did\s+we\s+(?:just\s+)?(?:discuss|talk\s+about)|what\s+were\s+we\s+talking)\b/i.test(String(question || ''));
}

export function isPreviousTopicRecallQuestion(question) {
  return /\b(?:sebelum|before)\b.{0,80}\b(?:pindah|ganti|switch|java|topic|topik)\b/i.test(String(question || ''));
}

export function isConversationCorrection(question) {
  return /\b(?:kok|kenapa|harusnya|seharusnya|jangan|gausah|gak\s+usah|nggak\s+usah|tidak\s+usah|masih\s+ikut|salah)\b/i.test(String(question || ''));
}

export function isOpenTopicQuestion(question) {
  return /^coba(?:\s+deh)?\s+sekarang\s+kita\s+bahas\s+apa\b/i.test(String(question || '').trim());
}

export function isExplicitTopicSwitch(question) {
  const text = String(question || '').trim();
  if (/^(?:apa|siapa|bagaimana|what|who|how)\b/i.test(text)) return false;
  if (/^coba(?:\s+deh)?\s+sekarang\s+kita\s+bahas\s+apa\b/i.test(text)) return false;
  if (isRecentHistoryQuestion(text)) return false;
  return TOPIC_SWITCH_PATTERN.test(text);
}

export function isHistoricalRecallQuestion(question) {
  return HISTORICAL_RECALL_PATTERN.test(String(question || ''));
}

/**
 * Keeps the latest exchange evidence regardless of keywords, then adds only
 * earlier messages that overlap the current question. Order is never changed.
 */
export function selectConversationContext(history, question, {
  recentLimit = RECENT_CONVERSATION_MESSAGES,
  earlierLimit = RELEVANT_EARLIER_MESSAGES,
} = {}) {
  const entries = Array.isArray(history) ? history : [];
  if (isShortNonSubstantiveMessage(question)) {
    return Object.freeze({
      history: Object.freeze([]),
      recentCount: 0,
      relevantEarlierCount: 0,
      excludedEarlierCount: entries.length,
      intent: 'short',
    });
  }
  if (isIdentityQuestion(question)) {
    return Object.freeze({
      history: Object.freeze([]),
      recentCount: 0,
      relevantEarlierCount: 0,
      excludedEarlierCount: entries.length,
      intent: 'identity',
    });
  }
  if (isConversationCorrection(question)) {
    return Object.freeze({
      history: Object.freeze([]),
      recentCount: 0,
      relevantEarlierCount: 0,
      excludedEarlierCount: entries.length,
      intent: 'correction',
    });
  }
  if (isOpenTopicQuestion(question)) {
    return Object.freeze({
      history: Object.freeze([]),
      recentCount: 0,
      relevantEarlierCount: 0,
      excludedEarlierCount: entries.length,
      intent: 'open_topic',
    });
  }
  if (isExplicitTopicSwitch(question)) {
    return Object.freeze({
      history: Object.freeze([]),
      recentCount: 0,
      relevantEarlierCount: 0,
      excludedEarlierCount: entries.length,
      topicSwitch: true,
      intent: 'topic_switch',
    });
  }
  if (isRecentHistoryQuestion(question) && !isPreviousTopicRecallQuestion(question)) {
    return Object.freeze({
      history: Object.freeze(entries.slice(-RECENT_RECALL_MESSAGES)),
      recentCount: Math.min(entries.length, RECENT_RECALL_MESSAGES),
      relevantEarlierCount: 0,
      excludedEarlierCount: Math.max(0, entries.length - RECENT_RECALL_MESSAGES),
      intent: 'recent_recall',
    });
  }
  const recent = entries.slice(-recentLimit);
  const earlier = entries.slice(0, Math.max(0, entries.length - recent.length));
  const terms = new Set(
    [...getMemoryTerms(question)].filter((term) => !GENERIC_CONTEXT_TERMS.has(term)),
  );
  const relevantIndexes = earlier
    .map((message, index) => ({
      index,
      score: [...terms].reduce(
        (total, term) => total + Number(getMemoryTerms(messageText(message)).has(term)),
        0,
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, earlierLimit)
    .map(({ index }) => index)
    .sort((left, right) => left - right);
  const selectedEarlier = relevantIndexes.map((index) => earlier[index]);

  const latestTopicSwitch = entries.reduce(
    (latest, message, index) => message?.role === 'user' &&
      isExplicitTopicSwitch(messageText(message)) ? index : latest,
    -1,
  );
  if (latestTopicSwitch >= 0 && isPreviousTopicRecallQuestion(question)) {
    const beforeSwitch = entries.slice(0, latestTopicSwitch);
    const lastUserBeforeSwitch = beforeSwitch.reduce(
      (latest, message, index) => message?.role === 'user' ? index : latest,
      -1,
    );
    const proposedTopicHistory = lastUserBeforeSwitch >= 0
      ? beforeSwitch.slice(lastUserBeforeSwitch)
      : beforeSwitch.slice(-recentLimit);
    return Object.freeze({
      history: Object.freeze(proposedTopicHistory.slice(-recentLimit)),
      recentCount: Math.min(proposedTopicHistory.length, recentLimit),
      relevantEarlierCount: 0,
      excludedEarlierCount: entries.length - Math.min(proposedTopicHistory.length, recentLimit),
      topicSwitch: false,
      intent: 'previous_topic_recall',
    });
  }
  if (latestTopicSwitch >= 0 && !isHistoricalRecallQuestion(question)) {
    const activeTopicHistory = entries.slice(latestTopicSwitch);
    return Object.freeze({
      history: Object.freeze(activeTopicHistory.slice(-recentLimit)),
      recentCount: Math.min(activeTopicHistory.length, recentLimit),
      relevantEarlierCount: 0,
      excludedEarlierCount: entries.length - Math.min(activeTopicHistory.length, recentLimit),
      topicSwitch: true,
      intent: 'active_topic',
    });
  }

  return Object.freeze({
    history: Object.freeze([...selectedEarlier, ...recent]),
    recentCount: recent.length,
    relevantEarlierCount: selectedEarlier.length,
    excludedEarlierCount: earlier.length - selectedEarlier.length,
    topicSwitch: false,
    intent: 'conversation',
  });
}

export function getConversationIntentInstruction(intent) {
  const instructions = {
    short: 'Pesan terbaru adalah sapaan atau tes singkat. Jawab singkat dan natural; jangan menjelaskan topik lama.',
    identity: 'Pesan terbaru menanyakan FRIDAY. Jawab identitas, peran, kemampuan nyata, atau pengembang secara langsung; jangan menambahkan topik teknis lama.',
    open_topic: 'Pengguna ingin memilih topik baru. Tanggapi santai dan tanyakan topik yang ingin dibahas tanpa menghidupkan topik lama.',
    topic_switch: 'Pesan terbaru menetapkan topik baru. Fokuskan jawaban pada topik baru dan jangan membawa topik lama kecuali diminta.',
    recent_recall: 'Pengguna meminta ringkasan percakapan terbaru. Gunakan pesan terbaru yang benar-benar tersedia; jangan menyebut sesi kosong jika konteks tersedia.',
    active_topic: 'Jawab berdasarkan topik aktif terbaru. Jangan merangkum seluruh riwayat atau mengulang pertanyaan lama yang tidak relevan.',
    previous_topic_recall: 'Pengguna menanyakan topik yang diajukan sebelum perpindahan topik. Gunakan pertukaran tepat sebelum switch; bedakan topik yang baru diusulkan dari materi yang benar-benar sudah dibahas.',
    correction: 'Pengguna sedang mengoreksi respons atau gaya FRIDAY. Akui singkat, minta maaf bila sesuai, dan terapkan koreksi tanpa mengulang sapaan atau topik lama.',
    conversation: 'Jawab pesan terbaru dengan konteks percakapan yang relevan saja.',
  };
  return instructions[intent] || instructions.conversation;
}
