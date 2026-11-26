/**
 * Small deterministic intent helpers for application-owned response routing.
 * These helpers never execute an action; they only identify requests that
 * require an honest capability response before the model is asked to answer.
 */

export function isVoiceResponseRequest(text) {
  const value = String(text || '');
  return (
    /\b(?:vn|voice[\s-]?note|voice message|pesan suara)\b/i.test(value) ||
    /\b(?:balas|jawab|bales)(?:lah)?\b.{0,100}\b(?:pakai|pake|dengan|menggunakan|lewat|melalui)\s+(?:vn|suara|voice[\s-]?note|audio)\b/i.test(value) ||
    /\b(?:kirim|buat|bikin|ubah|jadikan)\b.{0,60}\b(?:vn|voice[\s-]?note|pesan suara)\b/i.test(value) ||
    /\b(?:ngomong|berbicara|ucapkan|bacakan)\b/i.test(value)
  );
}

export function classifyUnsupportedAction(text) {
  const value = String(text || '').trim();
  if (!value || /\b(?:cara|bagaimana|gimana|apa itu|jelaskan|tutorial)\b/i.test(value)) {
    return null;
  }
  if (/\b(?:leave|keluar)\b.{0,40}\b(?:grup|group)\b|\b(?:grup|group)\b.{0,40}\b(?:leave|keluar)\b/i.test(value)) {
    return 'leave_group';
  }
  if (/\b(?:hapus|delete)\b.{0,50}\b(?:file|berkas|folder)\b/i.test(value)) {
    return 'delete_file';
  }
  if (/\b(?:kirim|send)\b.{0,70}\b(?:pesan|message|chat)\b/i.test(value)) {
    return 'send_message';
  }
  return null;
}

export function getUnsupportedActionResponse(kind, { playful = false } = {}) {
  if (kind === 'leave_group') {
    return playful
      ? 'WKWKWK 😭 Aku nggak bisa leave grup sendiri dongg. Kalau memang mau keluar, kamu yang perlu melakukannya.'
      : 'Aku belum bisa keluar dari grup secara otomatis. Kalau mau keluar, kamu perlu melakukannya dari WhatsApp.';
  }
  if (kind === 'delete_file') {
    return 'Aku belum punya akses penghapusan file yang aman di chat ini, jadi aku tidak akan mengklaim file sudah dihapus.';
  }
  if (kind === 'send_message') {
    return 'Aku belum bisa mengirim pesan ke orang lain secara mandiri, jadi pesan itu belum dikirim.';
  }
  return 'Aku belum bisa melakukan tindakan itu secara langsung.';
}
