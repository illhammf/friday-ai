const NEGATION_PATTERN =
  /\b(?:jangan|tidak|nggak|enggak|gak|ga|bukan|tanpa)\b(?:\s+\w+){0,3}\s*$/i;
const NEGATED_STYLE_REQUEST_PATTERN =
  /\b(?:jangan|tidak|nggak|enggak|gak|ga|bukan|tanpa)\b(?:[\s,]+\w+){0,3}[\s,]+\b(?:bercanda|lucu|humor|jokes?|romantis|romantiskan|romantisin|rayu|gombal|gombalin|bucin|marah|marahin|marahi|tegas|tegasin|galak|judes)\b/i;

const EXPLICIT_STYLE_REQUESTS = [
  {
    style: 'playful',
    patterns: [
      /\b(?:coba|tolong|bisa|boleh|jawab|balas|bicara|ngomong|kirim|jadi|pakai|pake|mode|mau|pengen|pengin)\b.{0,45}\b(?:bercanda|lucu|humor|jokes?|ngakak|guyon|roast)\b/i,
      /\b(?:bercanda|lucu|humor|jokes?|ngakak|guyon|roast)\b.{0,24}\b(?:dong|ya|deh|sama aku|sedikit)\b/i,
    ],
  },
  {
    style: 'romantic',
    patterns: [
      /\b(?:coba|tolong|bisa|boleh|jawab|balas|bicara|ngomong|jadi|buat|mode|mau|pengen|pengin)\b.{0,45}\b(?:romantis|romantiskan|romantisin|rayu|gombal|bucin)\b/i,
      /\b(?:romantis|romantiskan|romantisin|rayu|gombal|gombalin|bucin)\b.{0,24}\b(?:dong|ya|deh|aku|sama aku)\b/i,
    ],
  },
  {
    style: 'assertive',
    patterns: [
      /\b(?:coba|tolong|bisa|boleh|jawab|balas|bicara|ngomong|jadi|buat|mode|mau|pengen|pengin)\b.{0,45}\b(?:marah|marahin|marahi|tegas|galak|judes)\b/i,
      /\b(?:marahin|marahi|tegasin)\s+(?:aku|saya|dia|mereka)\b/i,
      /\b(?:marah|tegas|galak|judes)\b.{0,24}\b(?:dong|ya|deh|sedikit)\b/i,
    ],
  },
  {
    style: 'casual',
    patterns: [
      /\b(?:santai|santuy|casual|kasual|ngobrol aja|kayak teman|kayak temen|jangan formal|nggak usah formal|ga usah formal)\b/i,
    ],
  },
];

const TECHNICAL_PATTERN =
  /\b(?:error|debug|javascript|node\.js|database|sql|coding|program|kode|npm|stack trace|terminal|api|server)\b/i;
const SUPPORTIVE_PATTERN =
  /\b(?:sedih|kecewa|capek banget|lelah banget|aku takut|aku cemas|aku khawatir|aku kesepian|lagi down|butuh cerita|patah hati|berduka)\b/i;
const EXCITED_PATTERN =
  /\b(?:akhirnya berhasil|berhasil juga|aku lolos|kabar baik|senang banget|bahagia banget|mantap|gaskeun|gass+|wkwk+|haha+|hehe+)\b/i;
const AFFECTIONATE_PATTERN =
  /\b(?:sayang|aku kangen|makasih sayang|love you|i love you|miss you)\b/i;
const CASUAL_PATTERN =
  /\b(?:wkwk+|haha+|hehe+|gass+|gaskeun|dong|deh|nih|sih|kok|santuy|btw|guys|bro|bestie|gak|ga|nggak|enggak|aja|banget)\b/i;

function findExplicitStyle(text) {
  for (const request of EXPLICIT_STYLE_REQUESTS) {
    for (const pattern of request.patterns) {
      const match = pattern.exec(text);

      if (!match) {
        continue;
      }

      const precedingText = text.slice(0, match.index + match[0].length);
      const matchedTerm = match[0].match(
        /(?:bercanda|lucu|humor|jokes?|ngakak|guyon|roast|romantis|romantiskan|romantisin|rayu|gombal|bucin|marah|marahin|marahi|tegas|galak|judes|santai|santuy|casual|kasual|ngobrol aja|kayak teman|kayak temen|jangan formal|nggak usah formal|ga usah formal)/i,
      );

      if (
        matchedTerm &&
        NEGATION_PATTERN.test(
          precedingText.slice(0, precedingText.lastIndexOf(matchedTerm[0])),
        )
      ) {
        continue;
      }

      return request.style;
    }
  }

  return null;
}

function getUserMessages(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((entry) => entry?.role === 'user')
    .map((entry) =>
      (entry.parts || [])
        .map((part) => part?.text)
        .filter((text) => typeof text === 'string')
        .join(' '),
    )
    .filter(Boolean);
}

export function detectConversationStyle(question, history = []) {
  const text = String(question || '').trim().toLowerCase();

  if (!text) {
    return 'natural';
  }

  const explicitStyle = findExplicitStyle(text);

  if (explicitStyle) {
    return explicitStyle;
  }

  if (NEGATED_STYLE_REQUEST_PATTERN.test(text)) {
    return 'natural';
  }

  if (SUPPORTIVE_PATTERN.test(text)) {
    return 'supportive';
  }

  if (TECHNICAL_PATTERN.test(text)) {
    return 'technical';
  }

  if (EXCITED_PATTERN.test(text)) {
    return 'excited';
  }

  if (AFFECTIONATE_PATTERN.test(text)) {
    return 'affectionate';
  }

  if (CASUAL_PATTERN.test(text)) {
    return 'casual';
  }

  const recentUserMessages = getUserMessages(history);
  const latestUserMessage = recentUserMessages.at(-1)?.toLowerCase() || '';

  if (CASUAL_PATTERN.test(latestUserMessage)) {
    return 'casual';
  }

  return 'natural';
}

export function getStyleInstruction(style) {
  const styles = {
    supportive: `
GAYA RESPONS: SUPORTIF
- Balas dengan hangat dan terasa hadir; akui perasaan yang memang
  disampaikan, tanpa mengasumsikan hal yang belum jelas.
- Jangan buru-buru memberi daftar solusi. Dengarkan dulu, lalu tawarkan
  satu langkah kecil jika memang membantu.
- Hindari nada klinis, menggurui, atau menyepelekan.
`,

    excited: `
GAYA RESPONS: IKUT SENANG
- Ikuti energi pengguna dengan antusias yang tulus dan proporsional.
- Beri reaksi singkat yang terasa spontan; emoji atau ekspresi chat boleh
  dipakai sesekali bila cocok.
- Hindari pujian generik atau berlebihan.
`,

    affectionate: `
GAYA RESPONS: HANGAT
- Balas dengan akrab, lembut, dan natural sesuai konteks.
- Jangan menganggap satu sapaan sayang sebagai bukti hubungan romantis.
- Jangan mengaku memiliki perasaan manusia atau hubungan nyata.
`,

    romantic: `
GAYA RESPONS: ROMANTIS RINGAN
- Pengguna secara eksplisit meminta nuansa romantis: balas dengan manis,
  hangat, dan boleh memakai rayuan ringan atau emoji yang sesuai.
- Jadikan ini gaya bahasa/roleplay ringan, bukan klaim hubungan nyata.
- Jangan mengaku memiliki perasaan manusia, eksklusivitas, atau meminta
  pengguna bergantung secara emosional.
- Jangan memaksakan gombalan jika pengguna sedang membahas hal serius.
`,

    playful: `
GAYA RESPONS: BERCANDA DAN PLAYFUL
- Pengguna mengundang humor: balas dengan spontan, ringan, dan nyambung
  dengan topik; boleh memakai ekspresi chat atau satu emoji lucu.
- Boleh menggoda ringan jika konteksnya akrab, tetapi jangan merendahkan,
  menyerang identitas, atau menjadikan kerentanan sebagai bahan lelucon.
- Tetap jawab inti permintaan; jangan mengubah semuanya menjadi lelucon.
`,

    assertive: `
GAYA RESPONS: TEGAS / PURA-PURA KESAL
- Pengguna meminta gaya marah/tegas: gunakan ketegasan yang jelas dan
  teatrikal ringan, seperti teman yang sedang gemas.
- Jangan menghina, mengancam, mempermalukan, mengintimidasi, atau
  menyerang pengguna maupun orang lain.
- Jika konteksnya serius atau pengguna sedang rentan, utamakan dukungan
  dan kejujuran daripada berpura-pura marah.
`,

    casual: `
GAYA RESPONS: SANTAI SEPERTI CHAT SEHARI-HARI
- Gunakan bahasa percakapan yang ringan, akrab, dan tidak kaku; sesuaikan
  slang dengan cara pengguna bicara tanpa menirunya secara berlebihan.
- Jawab seperti teman ngobrol yang sigap: langsung ke inti, tidak selalu
  membuat daftar atau memberi pembukaan formal.
- Emoji dan ekspresi chat boleh sesekali, bukan di setiap kalimat.
`,

    technical: `
GAYA RESPONS: TEKNIS TAPI TETAP NATURAL
- Prioritaskan ketepatan dan solusi yang bisa diterapkan.
- Jelaskan langkah secara runtut, namun gunakan bahasa percakapan yang
  jelas alih-alih terdengar seperti dokumen formal.
- Gunakan contoh kode bila membantu; humor tidak boleh mengaburkan solusi.
`,

    natural: `
GAYA RESPONS: NATURAL DAN ADAPTIF
- Ikuti nada, panjang pesan, dan tingkat formalitas pengguna.
- Untuk chat pendek, balas ringkas dan luwes; untuk pertanyaan kompleks,
  tetap terstruktur tanpa pembukaan kaku.
- Jangan memaksakan humor, slang, emoji, pujian, atau pertanyaan penutup.
`,
  };

  return styles[style] || styles.natural;
}
