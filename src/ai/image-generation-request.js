const GENERATION_ACTION =
  /\b(?:buat(?:kan|in)?|bikin(?:kan|in)?|dibuatkan|dibikinkan|generate(?:kan)?|ciptakan|gambarkan|gambarin|lukis(?:kan)?|desain(?:kan)?|create|draw|illustrate)\b/i;
const VISUAL_OUTPUT =
  /\b(?:gambar|foto|image|ilustrasi|lukisan|poster|wallpaper|logo|avatar|ikon|icon|cover|thumbnail|stiker|komik|meme|sketsa)\b/i;
const TEXTUAL_IMAGE_TASK =
  /\b(?:caption|deskripsi|jelaskan|analisis|analisa|identifikasi|teks|prompt|alt[\s-]?text)\b/i;
const NEGATION_BEFORE_ACTION =
  /\b(?:jangan|tidak|nggak|enggak|gak|ga|bukan)\b(?:\s+\w+){0,3}\s*$/i;

export function isImageGenerationRequest(question) {
  const text = String(question || '').trim();

  if (!text) {
    return false;
  }

  const outputMatch = VISUAL_OUTPUT.exec(text);
  const actionMatch = GENERATION_ACTION.exec(text);

  if (!outputMatch || !actionMatch) {
    return false;
  }

  if (NEGATION_BEFORE_ACTION.test(text.slice(0, actionMatch.index))) {
    return false;
  }

  const distance = Math.abs(outputMatch.index - actionMatch.index);
  const between = text.slice(
    Math.min(outputMatch.index, actionMatch.index),
    Math.max(
      outputMatch.index + outputMatch[0].length,
      actionMatch.index + actionMatch[0].length,
    ),
  );

  return distance <= 100 && !TEXTUAL_IMAGE_TASK.test(between);
}
