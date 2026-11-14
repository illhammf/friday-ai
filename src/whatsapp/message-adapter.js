/**
 * Converts a whatsapp-web.js message into the transport-neutral contract used
 * by the application service.
 * @param {Object} message
 * @param {(message: Object) => Promise<Object|null>} downloadMedia
 */
export function normalizeWhatsAppMessage(message, downloadMedia) {
  if (!message || typeof message.from !== 'string' || !message.from) {
    return null;
  }

  const isGroup = message.from.endsWith('@g.us');
  const mediaDetails = message._data || {};
  const rawId = message.id;
  const fallbackSerializedId = rawId?.fromMe != null && rawId.remote && rawId.id
    ? `${rawId.fromMe}_${rawId.remote}_${rawId.id}`
    : null;
  const messageId = typeof rawId === 'string'
    ? rawId
    : rawId?._serialized || rawId?.$1 || fallbackSerializedId || null;
  const text = typeof message.body === 'string'
    ? message.body.trim()
    : '';
  const timestamp = typeof message.timestamp === 'number'
    ? message.timestamp
    : typeof message.timestamp === 'string' && message.timestamp.trim()
      ? Number(message.timestamp)
      : Number.NaN;

  return {
    messageId,
    chatId: message.from,
    senderId: isGroup
      ? (message.author || message.from)
      : message.from,
    chatType: isGroup ? 'group' : 'private',
    messageType: typeof message.type === 'string' ? message.type : 'unknown',
    text,
    caption: message.type === 'image'
      ? text
      : '',
    timestamp,
    group: isGroup
      ? {
          senderName: typeof mediaDetails.notifyName === 'string' &&
            mediaDetails.notifyName
            ? mediaDetails.notifyName
            : 'Anggota grup',
        }
      : null,
    media: message.hasMedia || message.type === 'image' || message.type === 'ptt'
      ? {
          download: () => downloadMedia(message),
          diagnostics: {
            type: message.type,
            hasMedia: message.hasMedia,
            mimetype: mediaDetails.mimetype || 'unknown',
            size: mediaDetails.size ?? 'unknown',
            directPath: Boolean(mediaDetails.directPath),
            mediaKey: Boolean(mediaDetails.mediaKey),
            encFilehash: Boolean(mediaDetails.encFilehash),
            mediaStage: mediaDetails.mediaData?.mediaStage || 'unknown',
          },
        }
      : null,
  };
}

/**
 * Builds concrete WhatsApp delivery and reply adapters from injected fakes or
 * SDK implementations.
 */
export function createWhatsAppAdapters({
  client,
  MessageMedia,
  downloadMedia,
  readStickerData,
}) {
  return {
    normalize: (message) => normalizeWhatsAppMessage(message, downloadMedia),
    reply: (message) => (text) => message.reply(text),
    deliver: {
      sendVideo: (chatId, videoResult, caption) => {
        const media = MessageMedia.fromFilePath(videoResult.path);
        return client.sendMessage(chatId, media, { caption });
      },
      sendSticker: async (chatId, stickerResult, botName) => {
        const media = new MessageMedia(
          stickerResult.mimetype,
          await readStickerData(stickerResult.path),
          'friday-sticker.webp',
          stickerResult.size,
        );
        return client.sendMessage(chatId, media, {
          sendMediaAsSticker: true,
          stickerName: botName,
          stickerAuthor: 'Friday AI',
        });
      },
      sendImage: (chatId, generatedImage, caption) => {
        const extension = generatedImage.mimeType === 'image/jpeg'
          ? 'jpg'
          : generatedImage.mimeType === 'image/webp'
            ? 'webp'
            : 'png';
        const media = new MessageMedia(
          generatedImage.mimeType,
          generatedImage.data,
          `friday-generated.${extension}`,
        );
        return client.sendMessage(chatId, media, { caption });
      },
      sendVoice: (chatId, path) => {
        const media = MessageMedia.fromFilePath(path);
        return client.sendMessage(chatId, media, { sendAudioAsVoice: true });
      },
    },
  };
}

export function registerQueuedMessageHandler(
  client,
  {
    botName,
    canAccept = () => true,
    isQueueableMessage,
    getDeduplicationKey,
    deduplicator,
    queue,
    normalize,
    handle,
    reply,
    logger = console,
  },
) {
  client.on('message', (message) => {
    if (!canAccept()) return;
    if (!isQueueableMessage(message, botName)) return;

    const deduplicationKey = getDeduplicationKey(message);

    if (!deduplicator.claim(deduplicationKey)) {
      logger.log('[Diabaikan] Event pesan WhatsApp duplikat.');
      return;
    }

    const queuedMessage = queue.enqueue(message.from, () => {
      const normalizedMessage = normalize(message);
      if (!normalizedMessage) return undefined;
      return handle(normalizedMessage, {
        reply: reply(message),
      });
    });

    if (!queuedMessage) {
      deduplicator.release(deduplicationKey);
      void reply(message)(
        'Aku masih memproses beberapa pesan di chat ini. Pesan baru ini belum masuk antrean, coba kirim lagi sebentar ya.',
      ).catch((error) => {
        logger.error(
          '[Pemberitahuan antrean penuh gagal]',
          error?.message || error,
        );
      });
      return;
    }

    queuedMessage.catch((error) => {
      logger.error(
        '[Pemrosesan pesan antrean gagal]',
        error,
      );
    });
  });
}
