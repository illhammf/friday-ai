/**
 * @typedef {Object} NormalizedIncomingMessage
 * @property {string|null} messageId
 * @property {string} chatId
 * @property {string} senderId
 * @property {'private'|'group'} chatType
 * @property {string} messageType
 * @property {string} text
 * @property {string} caption
 * @property {number} timestamp
 * @property {{senderName: string}|null} group
 * @property {{download: () => Promise<Object|null>, diagnostics?: Object}|null} media
 */

/**
 * @typedef {Object} MessageTransport
 * @property {(text: string) => Promise<*>} reply
 */

/**
 * @typedef {Object} MessageServiceDependencies
 * @property {string} botName
 * @property {() => number} getReadyAt
 * @property {{privateSessionId: (senderId: string) => string, groupSessionId: (chatId: string) => string}} sessions
 * @property {{parseCommand: Function, handleCommand: Function}} memory
 * @property {{route: (text: string) => {handled: boolean, response?: string}}} [commands]
 * @property {{getUrls: Function, isDownloadRequest: Function, download: Function, getFailureMessage: Function}} video
 * @property {{isRequest: Function, parseOptions: Function, create: Function, getFailureMessage: Function}} sticker
 * @property {{isGenerationRequest: Function, generate: Function, isQuotaError: Function, getQuotaDiagnostic: Function, getFailureMessage: Function}} image
 * @property {{ask: Function, getFailureMessage: Function}} assistant
 * @property {{transcribe: Function, generate: Function, isQuotaError: Function, getFailureMessage: Function}} audio
 * @property {{save: Function}} history
 * @property {(text: string) => string} formatMessage
 * @property {{sendVideo: Function, sendSticker: Function, sendImage: Function, sendVoice: Function}} deliver
 * @property {{event?: Function, error?: Function}} logger
 */

/**
 * @param {MessageServiceDependencies} dependencies Integrations supplied by the composition root.
 */
export function createMessageService(dependencies) {
  const activeSessions = new Set();

  /**
   * @param {NormalizedIncomingMessage} message
   * @param {MessageTransport} transport
   */
  async function handle(message, transport) {
    if (!message) return;

    try {
      const isVoiceNote = message.messageType === 'ptt';
      const isImage = message.messageType === 'image';
      const hasText = Boolean(message.text?.trim());

      if (!isVoiceNote && !isImage && !hasText) return;

      let question = message.text?.trim() || '';
      const messageTime = Number(message.timestamp);
      const readyAt = Number(dependencies.getReadyAt());

      if (
        !readyAt ||
        !Number.isFinite(messageTime) ||
        messageTime <= 0
      ) {
        dependencies.logger?.event(
          'info',
          'Pesan diabaikan',
          `Timestamp tidak valid: ${messageTime}`,
        );
        return;
      }

      if (messageTime < readyAt) {
        dependencies.logger?.event(
          'info',
          'Pesan diabaikan',
          'Pesan dikirim sebelum FRIDAY siap.',
        );
        return;
      }

      const isGroup = message.chatType === 'group';

      if (isGroup) {
        const escapedName = dependencies.botName.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        );
        const prefix = new RegExp(
          `^${escapedName}\\b[\\s,:-]*`,
          'i',
        );

        if (!prefix.test(question)) return;

        question = question.replace(prefix, '').trim();

        if (!question && !isVoiceNote && !isImage) {
          await transport.reply(
            `Halo! Aku ${dependencies.botName}. Ada yang bisa kubantu?`,
          );
          return;
        }
      } else if (!question && !isVoiceNote && !isImage) {
        await transport.reply(
          `Halo! Aku ${dependencies.botName}. Ada yang bisa kubantu?`,
        );
        return;
      }

      if (dependencies.commands?.route) {
        let commandResult;
        try {
          commandResult = dependencies.commands.route(question);
        } catch (error) {
          dependencies.logger?.error('Router perintah gagal', error);
          commandResult = {
            handled: true,
            response: 'Perintah belum bisa diproses sekarang. Coba lagi nanti ya.',
          };
        }

        if (commandResult?.handled) {
          try {
            await transport.reply(commandResult.response);
          } catch (error) {
            // Sending may have succeeded remotely despite a transport rejection.
            // Avoid a second reply after that uncertain side effect.
            dependencies.logger?.error('Pengiriman balasan perintah gagal', error);
          }
          return;
        }
      }

      const socialVideoUrls = dependencies.video.getUrls(question);
      const asksToDownloadVideo =
        socialVideoUrls.length > 0 &&
        dependencies.video.isDownloadRequest(question);

      if (asksToDownloadVideo && socialVideoUrls.length > 1) {
        await transport.reply(
          'Kirim satu tautan TikTok atau Instagram dulu ya, supaya aku bisa mengunduh videonya.',
        );
        return;
      }

      const senderId = message.senderId;
      const privateSession = dependencies.sessions.privateSessionId(senderId);
      const sharedGroupSession = isGroup
        ? dependencies.sessions.groupSessionId(message.chatId)
        : null;
      const senderName = isGroup
        ? (message.group?.senderName || 'Anggota grup')
        : 'Pengguna';
      const memoryCommand = dependencies.memory.parseCommand(question);

      if (memoryCommand && !isImage && !isVoiceNote) {
        if (isGroup) {
          await transport.reply(
            'Memori Friday hanya tersedia di chat pribadi dan tidak disimpan dari grup. Kirim perintah memori langsung ke chat pribadi Friday, ya.',
          );
          return;
        }

        try {
          const reply = await dependencies.memory.handleCommand(
            question,
            privateSession,
          );

          if (reply) {
            await transport.reply(dependencies.formatMessage(reply));
            dependencies.logger?.event(
              'success',
              'Perintah memori diproses',
              memoryCommand.action,
            );
          }
        } catch (error) {
          dependencies.logger?.error('Perintah memori gagal', error);
          await transport.reply(
            'Memorimu belum berhasil diproses. Coba lagi sebentar ya.',
          );
          dependencies.logger?.event(
            'error',
            'Perintah memori gagal',
            error?.code || 'periksa log terminal',
          );
        }

        return;
      }

      const sessionId = privateSession;

      if (activeSessions.has(sessionId)) {
        await transport.reply(
          'Sebentar ya, aku masih memproses pesan sebelumnya.',
        );
        return;
      }

      activeSessions.add(sessionId);

      try {
        if (asksToDownloadVideo && socialVideoUrls.length === 1) {
          let videoResult = null;
          let videoStage = 'download';

          try {
            videoResult = await dependencies.video.download(socialVideoUrls[0]);
            videoStage = 'send';
            await dependencies.deliver.sendVideo(
              message.chatId,
              videoResult,
              'Ini video dari tautan yang kamu kirim.',
            );
            dependencies.logger?.event(
              'success',
              'Video berhasil diunduh dan dikirim',
              'WhatsApp',
            );
          } catch (error) {
            dependencies.logger?.error(
              videoStage === 'send'
                ? 'Pengiriman video WhatsApp gagal'
                : 'Unduhan video gagal',
              error,
            );
            await transport.reply(
              dependencies.video.getFailureMessage(error, videoStage),
            );
            dependencies.logger?.event(
              'error',
              videoStage === 'send'
                ? 'Pengiriman video WhatsApp gagal'
                : 'Unduhan video gagal',
              error?.code || 'periksa log terminal',
            );
          } finally {
            if (videoResult?.cleanup) {
              await videoResult.cleanup();
            }
          }

          return;
        }

        if (isVoiceNote) {
          const media = await message.media?.download();

          if (!media) {
            await transport.reply(
              'Maaf, Voice Note tidak bisa diunduh. Coba kirim ulang ya.',
            );
            return;
          }

          const transcript = (
            await dependencies.audio.transcribe(media)
          )?.trim();

          if (!transcript) {
            await transport.reply(
              'Maaf, isi Voice Note belum bisa kupahami. Coba kirim ulang atau tuliskan pesannya ya.',
            );
            return;
          }

          question = question
            ? `${question}\n\nIsi Voice Note: ${transcript}`
            : transcript;
        }

        let image = null;

        if (isImage) {
          let media;

          try {
            media = await message.media?.download();
          } catch (error) {
            dependencies.logger?.error(
              'WhatsApp gagal mengunduh gambar',
              {
                error,
                diagnostics: message.media?.diagnostics,
              },
            );
            await transport.reply(
              'Aku menerima fotonya, tetapi WhatsApp gagal mengunduh file gambar. Coba teruskan fotonya ke chat Friday. Jika masih gagal, admin perlu memeriksa detail error WhatsApp Web di log.',
            );
            return;
          }

          if (!media) {
            await transport.reply(
              'Maaf, gambar belum bisa dibaca. Coba kirim ulang ya.',
            );
            return;
          }

          if (!media.mimetype?.startsWith('image/')) {
            await transport.reply(
              'File yang diterima bukan gambar yang didukung.',
            );
            return;
          }

          if (dependencies.sticker.isRequest(question)) {
            let stickerResult;

            try {
              const stickerOptions = dependencies.sticker.parseOptions(question);
              stickerResult = await dependencies.sticker.create(
                media,
                stickerOptions,
              );
              await dependencies.deliver.sendSticker(
                message.chatId,
                stickerResult,
                dependencies.botName,
              );

              const stickerSession =
                sharedGroupSession || privateSession;
              const userMessage = isGroup
                ? `${senderName}: ${question}`
                : question;

              dependencies.history.save(stickerSession, 'user', userMessage);
              dependencies.history.save(
                stickerSession,
                'model',
                'Stiker berhasil dibuat dan dikirim.',
              );
              dependencies.logger?.event(
                'success',
                'Stiker berhasil dibuat dan dikirim',
                'WhatsApp',
              );
            } catch (error) {
              dependencies.logger?.error('Pembuatan stiker gagal', error);
              await transport.reply(
                dependencies.sticker.getFailureMessage(error),
              );
              dependencies.logger?.event(
                'error',
                'Pembuatan atau pengiriman stiker gagal',
                error?.code || 'periksa log terminal',
              );
            } finally {
              if (stickerResult?.cleanup) {
                await stickerResult.cleanup();
              }
            }

            return;
          }

          image = {
            mimetype: media.mimetype,
            data: media.data,
          };

          if (!question) {
            question = 'Jelaskan gambar ini secara rinci.';
          }
        }

        if (!image && dependencies.image.isGenerationRequest(question)) {
          let generatedImage;

          try {
            generatedImage = await dependencies.image.generate(question);
          } catch (error) {
            if (dependencies.image.isQuotaError(error)) {
              dependencies.logger?.event(
                'error',
                'Kuota generate gambar tidak tersedia',
                dependencies.image.getQuotaDiagnostic(error),
              );
            } else {
              dependencies.logger?.error(
                'Pembuatan gambar gagal',
                error,
              );
            }
            await transport.reply(
              dependencies.image.getFailureMessage(error),
            );
            return;
          }

          const caption = (
            generatedImage.text || 'Ini gambar yang kamu minta.'
          ).slice(0, 1000);
          await dependencies.deliver.sendImage(
            message.chatId,
            generatedImage,
            dependencies.formatMessage(caption),
          );

          const activeSession = sharedGroupSession || privateSession;
          const userMessage = isGroup
            ? `${senderName}: ${question}`
            : question;

          dependencies.history.save(activeSession, 'user', userMessage);
          dependencies.history.save(
            activeSession,
            'model',
            `Gambar dibuat untuk permintaan: ${question}`,
          );
          dependencies.logger?.event(
            'success',
            'Gambar berhasil dibuat dan dikirim',
            'WhatsApp',
          );
          return;
        }

        dependencies.logger?.event(
          'info',
          `Pesan masuk · ${isGroup ? 'Grup' : 'Pribadi'}`,
          `Sesi: ${sessionId}`,
        );
        const answer = await dependencies.assistant.ask({
          question,
          privateSession,
          sharedGroupSession,
          senderName,
          image,
        });

        const asksForVoice =
          /\b(?:vn|voice[\s-]?note|voice message|pesan suara)\b/i.test(question) ||
          /\b(?:balas|jawab|bales)(?:lah)?\b.{0,100}\b(?:pakai|pake|dengan|menggunakan|lewat|melalui)\s+(?:vn|suara|voice[\s-]?note|audio)\b/i.test(question) ||
          /\b(?:kirim|buat|bikin|ubah|jadikan)\b.{0,60}\b(?:vn|voice[\s-]?note|pesan suara)\b/i.test(question) ||
          /\b(?:ngomong|berbicara|ucapkan|bacakan)\b/i.test(question);

        if (isVoiceNote || asksForVoice) {
          let audioResult = null;
          let audioSent = false;

          try {
            audioResult = await dependencies.audio.generate(answer);

            if (!audioResult?.path) {
              throw new Error(
                'Proses pembuat audio tidak menghasilkan file audio.',
              );
            }

            await dependencies.deliver.sendVoice(message.chatId, audioResult.path);
            audioSent = true;
            dependencies.logger?.event(
              'voice',
              'Voice Note berhasil dikirim',
              'WhatsApp',
            );
          } catch (error) {
            dependencies.logger?.error(
              'TTS/pengiriman audio gagal',
              error,
            );

            if (dependencies.audio.isQuotaError(error)) {
              dependencies.logger?.event(
                'warn',
                'Kuota Voice Note tercapai',
                `Status: ${error?.status || error?.code || 'unknown'}; detail lengkap ada di log terminal.`,
              );
            }

            const fallbackText = dependencies.audio.getFailureMessage(
              error,
              answer,
            );

            try {
              await transport.reply(
                dependencies.formatMessage(fallbackText),
              );
            } catch (replyError) {
              dependencies.logger?.error(
                'Fallback teks gagal',
                replyError,
              );
            }
          } finally {
            if (audioResult?.cleanup) {
              try {
                await audioResult.cleanup();
              } catch (cleanupError) {
                dependencies.logger?.error(
                  'Cleanup audio gagal',
                  cleanupError,
                );
              }
            }
          }

          if (audioSent) {
            dependencies.logger?.event(
              'voice',
              'Proses pengiriman selesai',
            );
          }
        } else {
          try {
            await transport.reply(dependencies.formatMessage(answer));
          } catch (error) {
            // The remote send may have completed before the transport failed.
            // Do not send a second fallback message with an uncertain outcome.
            dependencies.logger?.error('Pengiriman balasan WhatsApp gagal', error);
            return;
          }
          dependencies.logger?.event(
            'success',
            'Jawaban teks berhasil dikirim',
            'WhatsApp',
          );
        }
      } finally {
        activeSessions.delete(sessionId);
      }
    } catch (error) {
      dependencies.logger?.error('DETAIL ERROR FRIDAY', error);
      const fallbackMessage = dependencies.assistant.getFailureMessage(error);

      try {
        await transport.reply(fallbackMessage);
      } catch (replyError) {
        dependencies.logger?.error('Fallback gagal', replyError);
      }
    }
  }

  return { handle };
}
