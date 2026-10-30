const EXPLICIT_GENERATION_ACTION =
  /\b(?:buat(?:kan|in)?|bikin(?:kan|in)?|dibuatkan|dibikinkan|generate(?:kan)?|ciptakan|desain(?:kan)?|create)\b/i;
const DRAWING_ACTION =
  /\b(?:gambar(?:in)?|gambarkan|lukis(?:kan)?|sketsa(?:kan)?|draw|illustrate|sketch)\b/i;
const VISUAL_OUTPUT =
  /\b(?:gambar|foto|image|ilustrasi|lukisan|poster|wallpaper|logo|avatar|ikon|icon|cover|thumbnail|stiker|komik|meme|sketsa)\b/i;
const TEXTUAL_IMAGE_TASK =
  /\b(?:caption|deskripsi|jelaskan|analisis|analisa|identifikasi|teks|prompt|alt[\s-]?text)\b/i;
const TEXTUAL_QUESTION =
  /\b(?:apa|apakah|siapa|mengapa|kenapa|bagaimana|jelaskan|jelasin|deskripsikan|deskripsiin|ceritakan|ceritain|terangkan|analisis|analisa|identifikasi|caption)\b/i;
const NEGATION_BEFORE_ACTION =
  /\b(?:jangan|tidak|nggak|enggak|gak|ga|bukan)\b(?:\s+\w+){0,3}\s*$/i;

export function isImageGenerationRequest(question) {
  const text = String(question || '').trim();

  if (!text) {
    return false;
  }

  const outputMatch = VISUAL_OUTPUT.exec(text);
  const explicitActionMatch = EXPLICIT_GENERATION_ACTION.exec(text);

  if (explicitActionMatch) {
    if (!outputMatch) {
      return false;
    }

    if (
      NEGATION_BEFORE_ACTION.test(
        text.slice(0, explicitActionMatch.index),
      )
    ) {
      return false;
    }

    const distance = Math.abs(
      outputMatch.index - explicitActionMatch.index,
    );
    const between = text.slice(
      Math.min(outputMatch.index, explicitActionMatch.index),
      Math.max(
        outputMatch.index + outputMatch[0].length,
        explicitActionMatch.index + explicitActionMatch[0].length,
      ),
    );

    return distance <= 100 && !TEXTUAL_IMAGE_TASK.test(between);
  }

  const drawingActionMatch = DRAWING_ACTION.exec(text);

  if (!drawingActionMatch || TEXTUAL_QUESTION.test(text)) {
    return false;
  }

  if (
    NEGATION_BEFORE_ACTION.test(
      text.slice(0, drawingActionMatch.index),
    )
  ) {
    return false;
  }

  const subject = text
    .slice(drawingActionMatch.index + drawingActionMatch[0].length)
    .trim()
    .replace(/^(?:dong|ya|deh|nih|tolong|please)\b[\s,!?]*/i, '')
    .replace(/[?.!,\s]+$/g, '');

  return subject.split(/\s+/).filter(Boolean).length > 0;
}
