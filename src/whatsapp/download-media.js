const MEDIA_DOWNLOAD_ATTEMPTS = 2;
const MEDIA_DOWNLOAD_RETRY_DELAY_MS = 1000;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function downloadMediaInWhatsAppPage(message) {
  const result = await message.client.pupPage.evaluate(async (messageId) => {
    const describeError = (error) => ({
      name: error?.name || 'Error',
      message: error?.message || String(error),
      status: error?.status ?? null,
      code: error?.code ?? null,
      stack: error?.stack || null,
    });

    const describeMedia = (msg) => ({
      type: msg?.type || null,
      mediaStage: msg?.mediaData?.mediaStage || null,
      hasDirectPath: Boolean(msg?.directPath),
      hasMediaKey: Boolean(msg?.mediaKey),
      hasEncryptedFileHash: Boolean(msg?.encFilehash),
      hasFileHash: Boolean(msg?.filehash),
      mimetype: msg?.mimetype || null,
      filesize: msg?.size ?? null,
    });

    const errors = [];

    try {
      const collections = window.require('WAWebCollections');
      const msg = collections.Msg.get(messageId) ||
        (await collections.Msg.getMessagesById([messageId]))?.messages?.[0];

      if (!msg) {
        return {
          ok: false,
          code: 'MESSAGE_NOT_FOUND',
          media: null,
          errors,
        };
      }

      const download = async () => {
        const manager = window.require('WAWebDownloadManager')?.downloadManager;

        if (typeof manager?.downloadAndMaybeDecrypt !== 'function') {
          throw new Error('WhatsApp media download manager is unavailable.');
        }

        const decryptedMedia = await manager.downloadAndMaybeDecrypt({
          directPath: msg.directPath,
          encFilehash: msg.encFilehash,
          filehash: msg.filehash,
          mediaKey: msg.mediaKey,
          mediaKeyTimestamp: msg.mediaKeyTimestamp,
          type: msg.type,
          mimetype: msg.mimetype,
          signal: new AbortController().signal,
          downloadQpl: {
            addAnnotations() {
              return this;
            },
            addPoint() {
              return this;
            },
          },
        });

        const data = await window.WWebJS.arrayBufferToBase64Async(
          decryptedMedia,
        );

        return {
          data,
          mimetype: msg.mimetype,
          filename: msg.filename || null,
          filesize: msg.size ?? null,
        };
      };

      try {
        const media = await download();
        return {
          ok: true,
          media,
          errors,
        };
      } catch (error) {
        errors.push({
          stage: 'direct-download',
          error: describeError(error),
        });
      }

      if (typeof msg.downloadMedia === 'function') {
        try {
          await msg.downloadMedia({
            downloadEvenIfExpensive: true,
            rmrReason: 1,
          });
        } catch (error) {
          errors.push({
            stage: 'media-resolution',
            error: describeError(error),
          });
        }

        try {
          const media = await download();
          return {
            ok: true,
            media,
            errors,
          };
        } catch (error) {
          errors.push({
            stage: 'resolved-download',
            error: describeError(error),
          });
        }
      }

      return {
        ok: false,
        code: 'MEDIA_DOWNLOAD_FAILED',
        media: describeMedia(msg),
        errors,
      };
    } catch (error) {
      return {
        ok: false,
        code: 'WHATSAPP_PAGE_ERROR',
        media: null,
        errors: [
          ...errors,
          {
            stage: 'page-evaluation',
            error: describeError(error),
          },
        ],
      };
    }
  }, message.id._serialized);

  if (result?.ok && result.media) {
    return result.media;
  }

  if (!result) {
    return undefined;
  }

  const error = new Error(
    `Unduhan media gagal (${result.code || 'UNKNOWN'}): ${JSON.stringify(result)}`,
  );
  error.mediaDiagnostic = result;
  throw error;
}

export async function downloadMediaWithRetry(
  message,
  downloadAttempt = downloadMediaInWhatsAppPage,
) {
  for (let attempt = 1; attempt <= MEDIA_DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await downloadAttempt(message);
    } catch (error) {
      if (attempt === MEDIA_DOWNLOAD_ATTEMPTS) {
        throw new Error(
          `Unduhan media WhatsApp gagal setelah ${MEDIA_DOWNLOAD_ATTEMPTS} percobaan: ${error?.message || String(error)}`,
          { cause: error },
        );
      }

      await sleep(MEDIA_DOWNLOAD_RETRY_DELAY_MS);
    }
  }

  throw new Error('Proses unduhan media berakhir tanpa hasil.');
}
