import { getSocialVideoUrls } from './download-social-video.js';

const DOWNLOAD_ACTION =
  /\b(?:download(?:in|kan)?|unduh(?:kan)?|simpan(?:kan)?|save|ambil(?:kan)?)\b/i;
const NEGATED_ACTION =
  /\b(?:jangan|tidak|nggak|enggak|gak|ga|bukan)\b(?:\s+\w+){0,3}\s*$/i;

export function isSocialVideoDownloadRequest(text) {
  const message = String(text || '').trim();
  const videoUrls = getSocialVideoUrls(message);
  const actionMatch = DOWNLOAD_ACTION.exec(message);
  const linkIndex = message.search(/https?:\/\/\S+/i);

  if (videoUrls.length === 0 || !actionMatch) {
    return false;
  }

  if (
    NEGATED_ACTION.test(message.slice(0, actionMatch.index)) ||
    NEGATED_ACTION.test(
      message.slice(
        actionMatch.index + actionMatch[0].length,
        linkIndex,
      ),
    )
  ) {
    return false;
  }

  return true;
}
