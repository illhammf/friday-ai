const MEDIA_DOWNLOAD_ATTEMPTS = 2;
const MEDIA_DOWNLOAD_RETRY_DELAY_MS = 750;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function downloadMediaWithRetry(message) {
  for (let attempt = 1; attempt <= MEDIA_DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await message.downloadMedia();
    } catch (error) {
      if (attempt === MEDIA_DOWNLOAD_ATTEMPTS) {
        throw new Error(
          `WhatsApp gagal mengunduh media setelah ${MEDIA_DOWNLOAD_ATTEMPTS} percobaan.`,
          { cause: error },
        );
      }

      await sleep(MEDIA_DOWNLOAD_RETRY_DELAY_MS);
    }
  }

  throw new Error('Proses unduhan media berakhir tanpa hasil.');
}
