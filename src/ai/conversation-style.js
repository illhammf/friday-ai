// fungsi pendeteksi gaya percakapan
export function detectConversationStyle(question) {
  const text = String(question || '').toLowerCase();

  const patterns = [
    {
      style: 'supportive',
      keywords: [
        'sedih',
        'kecewa',
        'capek banget',
        'lelah banget',
        'aku takut',
        'aku cemas',
        'aku khawatir',
        'aku kesepian',
        'lagi down',
        'butuh cerita',
      ],
    },
    {
      style: 'excited',
      keywords: [
        'akhirnya berhasil',
        'berhasil juga',
        'aku lolos',
        'kabar baik',
        'senang banget',
        'bahagia banget',
        'wkwkwk',
        'wkwk',
        'HAHAHA',
        'mantap',
        'gaskeun',
      ],
    },
    {
      style: 'affectionate',
      keywords: [
        'sayang',
        'aku kangen',
        'makasih sayang',
        'love you',
        'i love you',
      ],
    },
    {
      style: 'technical',
      keywords: [
        'error',
        'debug',
        'javascript',
        'node.js',
        'database',
        'sql',
        'coding',
        'program',
        'kode',
        'npm',
        'stack trace',
      ],
    },
  ];

  for (const item of patterns) {
    if (item.keywords.some((keyword) => text.includes(keyword))) {
      return item.style;
    }
  }

  return 'natural';
}

// instruksi gaya komunikasi dinamis
export function getStyleInstruction(style) {
  const styles = {
    supportive: `
GAYA RESPONS: SUPORTIF
- Gunakan bahasa yang tenang dan penuh perhatian.
- Akui perasaan yang disampaikan tanpa menghakimi.
- Jangan langsung membanjiri pengguna dengan solusi.
- Jika sesuai, bantu pengguna memikirkan langkah berikutnya.
- Jangan menganggap kondisi emosional pengguna sebagai fakta
  jika pesannya belum cukup jelas.
`,

    excited: `
GAYA RESPONS: ANTUSIAS
- Ikuti energi pengguna secara wajar.
- Boleh menggunakan bahasa santai dan emoji secukupnya.
- Berikan apresiasi yang relevan dengan konteks.
- Hindari respons yang terlalu formal atau berlebihan.
`,

    affectionate: `
GAYA RESPONS: HANGAT
- Balas dengan ramah dan natural.
- Sesuaikan keakraban dengan konteks percakapan.
- Jangan mengasumsikan adanya hubungan romantis nyata.
- Jangan menggunakan panggilan intim secara otomatis.
`,

    technical: `
GAYA RESPONS: TEKNIS
- Prioritaskan ketepatan dan solusi yang bisa diterapkan.
- Jelaskan langkah-langkah secara berurutan.
- Gunakan contoh kode jika diperlukan.
- Jangan mengorbankan kejelasan demi candaan.
`,

    natural: `
GAYA RESPONS: NATURAL
- Ikuti gaya bahasa dan kebutuhan pengguna.
- Untuk pertanyaan sederhana, jawab secara ringkas.
- Untuk percakapan santai, jangan terlalu formal.
- Jangan memaksakan humor atau pertanyaan lanjutan.
`,
  };

  return styles[style] || styles.natural;
}
