import { MAX_ASSISTANT_RESPONSE_BYTES } from '../ai/conversation-context.js';
import {
  classifyConversationError,
  createConversationCorrelationId,
} from './conversation-observability.js';

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
 * @property {(sessionId: string, userText: string, assistantText: string) => (Promise<void>|void)} history.saveConversationTurn
 * @property {(text: string) => string} formatMessage
 * @property {{sendVideo: Function, sendSticker: Function, sendImage: Function, sendVoice: Function}} deliver
 * @property {{event?: Function, error?: Function}} logger
 */

/**
 * @param {MessageServiceDependencies} dependencies Integrations supplied by the composition root.
 */
export function createMessageService(dependencies) {
  const activeSessions = new Set();

  async function saveSubmittedConversationTurn(sessionId, userText, assistantText, emitStage) {
    try {
      if (typeof dependencies.history.saveConversationTurn !== 'function') {
        throw new TypeError('An atomic conversation history writer is required.');
      }
      await dependencies.history.saveConversationTurn(
        sessionId,
        userText,
        assistantText,
      );
      emitStage('history_persistence', 'succeeded');
    } catch (error) {
      // The send call returned a message result, but recipient delivery is not
      // confirmed here. Do not issue a duplicate response on DB failure.
      emitStage('history_persistence', 'failed', error);
    }
  }

  /**
   * @param {NormalizedIncomingMessage} message
   * @param {MessageTransport} transport
   */
  async function handle(message, transport) {
    if (!message) return;

    const correlationId = message.correlationId || createConversationCorrelationId();
    let outboundAttempted = false;
    let failureStageLogged = false;
    const emitStage = (stage, outcome, error, metadata = {}) => {
      dependencies.logger?.stage?.(stage, {
        correlationId,
        outcome,
        ...(error ? { category: classifyConversationError(error, stage) } : {}),
        ...(Number.isFinite(metadata.durationMs) ? { durationMs: metadata.durationMs } : {}),
        ...(Number.isFinite(metadata.inputTokens) ? { inputTokens: metadata.inputTokens } : {}),
        ...(Number.isFinite(metadata.outputTokens) ? { outputTokens: metadata.outputTokens } : {}),
        ...(Number.isFinite(metadata.totalTokens) ? { totalTokens: metadata.totalTokens } : {}),
        ...(typeof metadata.operation === 'string' ? { operation: metadata.operation.slice(0, 80) } : {}),
      });
    };
    const logError = (operation, error) => emitStage(
      'application_error',
      'failed',
      error?.error || error,
      { operation },
    );
    const submitReply = async (text) => {
      outboundAttempted = true;
      emitStage('reply_submission', 'started');
      try {
        const result = await transport.reply(text);
        emitStage('reply_submission', result == null ? 'uncertain' : 'submitted',
          result == null ? Object.assign(new Error('Reply result is missing.'), { code: 'TRANSPORT_UNCERTAIN' }) : undefined);
        return result;
      } catch (error) {
        emitStage('reply_submission', 'uncertain', error);
        throw error;
      }
    };
    const submitMedia = async (stage, send) => {
      outboundAttempted = true;
      emitStage(stage, 'started');
      try {
        const result = await send();
        emitStage(stage, result == null ? 'uncertain' : 'submitted',
          result == null ? Object.assign(new Error('Outbound result is missing.'), { code: 'TRANSPORT_UNCERTAIN' }) : undefined);
        return result;
      } catch (error) {
        emitStage(stage, 'uncertain', error);
        throw error;
      }
    };
    emitStage('message_processing', 'started');

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
          await submitReply(
            `Halo! Aku ${dependencies.botName}. Ada yang bisa kubantu?`,
          );
          return;
        }
      } else if (!question && !isVoiceNote && !isImage) {
        await submitReply(
          `Halo! Aku ${dependencies.botName}. Ada yang bisa kubantu?`,
        );
        return;
      }

      if (dependencies.commands?.route) {
        let commandResult;
        try {
          commandResult = dependencies.commands.route(question);
        } catch (error) {
          emitStage('command_router', 'failed', error);
          commandResult = {
            handled: true,
            response: 'Perintah belum bisa diproses sekarang. Coba lagi nanti ya.',
          };
        }

        if (commandResult?.handled) {
          try {
            await submitReply(commandResult.response);
          } catch (error) {
            // Sending may have succeeded remotely despite a transport rejection.
            // Avoid a second reply after that uncertain side effect.
          }
          return;
        }
      }

      const socialVideoUrls = dependencies.video.getUrls(question);
      const asksToDownloadVideo =
        socialVideoUrls.length > 0 &&
        dependencies.video.isDownloadRequest(question);

      if (asksToDownloadVideo && socialVideoUrls.length > 1) {
        await submitReply(
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
          await submitReply(
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
            await submitReply(dependencies.formatMessage(reply));
            dependencies.logger?.event(
              'success',
              'Perintah memori diproses',
              memoryCommand.action,
            );
          }
        } catch (error) {
          emitStage('memory_command', 'failed', error);
          await submitReply(
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

      // Serialize by the conversation being processed. Group turns use the
      // shared group session; locking them by the sender's private session
      // incorrectly blocks that sender's independent private conversation.
      const activeSessionId = sharedGroupSession || privateSession;
      if (activeSessions.has(activeSessionId)) {
        await submitReply(
          'Sebentar ya, aku masih memproses pesan sebelumnya.',
        );
        return;
      }

      activeSessions.add(activeSessionId);

      try {
        if (asksToDownloadVideo && socialVideoUrls.length === 1) {
          let videoResult = null;
          let videoStage = 'download';

          try {
            emitStage('video_download', 'started');
            videoResult = await dependencies.video.download(socialVideoUrls[0]);
            emitStage('video_download', 'completed');
            videoStage = 'send';
            await submitMedia('video_submission', () => dependencies.deliver.sendVideo(
              message.chatId,
              videoResult,
              'Ini video dari tautan yang kamu kirim.',
            ));
            dependencies.logger?.event(
              'success',
              'Video berhasil diunduh dan dikirim',
              'WhatsApp',
            );
          } catch (error) {
            if (videoStage === 'download') emitStage('video_download', 'failed', error);
            // A failed send can still have reached WhatsApp. Only report a
            // fallback when processing failed before outbound submission.
            if (videoStage === 'download') {
              await submitReply(
                dependencies.video.getFailureMessage(error, videoStage),
              );
            }
          } finally {
            if (videoResult?.cleanup) {
              await videoResult.cleanup();
            }
          }

          return;
        }

        if (isVoiceNote) {
          emitStage('voice_media_download', 'started');
          let media;
          try {
            media = await message.media?.download();
            emitStage('voice_media_download', media ? 'completed' : 'uncertain');
          } catch (error) {
            emitStage('voice_media_download', 'failed', error);
            throw error;
          }

          if (!media) {
            await submitReply(
              'Maaf, Voice Note tidak bisa diunduh. Coba kirim ulang ya.',
            );
            return;
          }

          emitStage('voice_transcription', 'started');
          let transcript;
          try {
            transcript = (await dependencies.audio.transcribe(media))?.trim();
            emitStage('voice_transcription', transcript ? 'completed' : 'uncertain');
          } catch (error) {
            emitStage('voice_transcription', 'failed', error);
            throw error;
          }

          if (!transcript) {
            await submitReply(
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
            emitStage('image_media_download', 'started');
            media = await message.media?.download();
            emitStage('image_media_download', media ? 'completed' : 'uncertain');
          } catch (error) {
            emitStage('image_media_download', 'failed', error);
            await submitReply(
              'Aku menerima fotonya, tetapi WhatsApp gagal mengunduh file gambar. Coba teruskan fotonya ke chat Friday. Jika masih gagal, pengelola perlu memeriksa koneksi WhatsApp Web.',
            );
            return;
          }

          if (!media) {
            await submitReply(
              'Maaf, gambar belum bisa dibaca. Coba kirim ulang ya.',
            );
            return;
          }

          if (!media.mimetype?.startsWith('image/')) {
            await submitReply(
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
              const sentStickerMessage = await submitMedia('sticker_submission', () => dependencies.deliver.sendSticker(
                message.chatId,
                stickerResult,
                dependencies.botName,
              ));
              if (sentStickerMessage == null) {
                return;
              }

              const stickerSession =
                sharedGroupSession || privateSession;
              const userMessage = isGroup
                ? `${senderName}: ${question}`
                : question;

              await saveSubmittedConversationTurn(
                stickerSession,
                userMessage,
                'Stiker berhasil dibuat dan dikirim.',
                emitStage,
              );
              dependencies.logger?.event(
                'success',
                'Stiker berhasil dibuat dan dikirim',
                'WhatsApp',
              );
            } catch (error) {
              if (!outboundAttempted) {
                emitStage('sticker_processing', 'failed', error, { operation: 'sticker_creation' });
                await submitReply(
                  dependencies.sticker.getFailureMessage(error),
                );
              }
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
            emitStage('image_generation', 'failed', error);
            await submitReply(
              dependencies.image.getFailureMessage(error),
            );
            return;
          }

          const caption = (
            generatedImage.text || 'Ini gambar yang kamu minta.'
          ).slice(0, 1000);
          const sentImageMessage = await submitMedia('image_submission', () => dependencies.deliver.sendImage(
            message.chatId,
            generatedImage,
            dependencies.formatMessage(caption),
          ));
          if (sentImageMessage == null) {
            return;
          }

          const activeSession = sharedGroupSession || privateSession;
          const userMessage = isGroup
            ? `${senderName}: ${question}`
            : question;

          await saveSubmittedConversationTurn(
            activeSession,
            userMessage,
            `Gambar dibuat untuk permintaan: ${question}`,
            emitStage,
          );
          dependencies.logger?.event(
            'success',
            'Gambar berhasil dibuat dan dikirim',
            'WhatsApp',
          );
          return;
        }

        emitStage('message_routed', 'accepted');
        emitStage('ai_request', 'started');
        let answer;
        try {
          answer = await dependencies.assistant.ask({
          question,
          privateSession,
          sharedGroupSession,
          senderName,
          image,
          correlationId,
          logStage: emitStage,
          });
          emitStage('ai_request', 'completed');
          emitStage('ai_response_validation', 'succeeded');
        } catch (error) {
          emitStage('ai_request', 'failed', error);
          failureStageLogged = true;
          throw error;
        }

        const asksForVoice =
          /\b(?:vn|voice[\s-]?note|voice message|pesan suara)\b/i.test(question) ||
          /\b(?:balas|jawab|bales)(?:lah)?\b.{0,100}\b(?:pakai|pake|dengan|menggunakan|lewat|melalui)\s+(?:vn|suara|voice[\s-]?note|audio)\b/i.test(question) ||
          /\b(?:kirim|buat|bikin|ubah|jadikan)\b.{0,60}\b(?:vn|voice[\s-]?note|pesan suara)\b/i.test(question) ||
          /\b(?:ngomong|berbicara|ucapkan|bacakan)\b/i.test(question);

        if (isVoiceNote || asksForVoice) {
          let audioResult = null;
          let audioSent = false;
          let assistantResponseSubmitted = false;
          let voiceSubmissionStarted = false;

          try {
            audioResult = await dependencies.audio.generate(answer);

            if (!audioResult?.path) {
              throw new Error(
                'Proses pembuat audio tidak menghasilkan file audio.',
              );
            }

            const sentVoiceMessage = await submitMedia('voice_submission', () => {
              voiceSubmissionStarted = true;
              return dependencies.deliver.sendVoice(message.chatId, audioResult.path);
            });
            if (sentVoiceMessage == null) {
              return;
            }
            audioSent = true;
            assistantResponseSubmitted = true;
            dependencies.logger?.event(
              'voice',
              'Voice Note berhasil dikirim',
              'WhatsApp',
            );
          } catch (error) {
            if (!voiceSubmissionStarted) emitStage('voice_generation', 'failed', error);

            // If the Voice Note submission itself failed, its remote outcome
            // is uncertain. Do not send the same answer again as text.
            if (!voiceSubmissionStarted) {
              const fallbackText = dependencies.audio.getFailureMessage(
                error,
                answer,
              );

              try {
                const formattedFallback = dependencies.formatMessage(fallbackText);
                const containsAssistantAnswer =
                  Buffer.byteLength(formattedFallback, 'utf8') <=
                  MAX_ASSISTANT_RESPONSE_BYTES;
                const sentTextMessage = await submitReply(containsAssistantAnswer
                  ? formattedFallback
                  : 'Voice Note tidak tersedia dan jawaban terlalu panjang untuk dikirim. Coba minta rangkuman, ya.');
                if (sentTextMessage != null) {
                  assistantResponseSubmitted = containsAssistantAnswer;
                }
              } catch (replyError) {
                // The reply submission stage records the uncertain result.
              }
            }
          } finally {
            if (audioResult?.cleanup) {
              try {
                await audioResult.cleanup();
              } catch (cleanupError) {
                logError(
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
          if (assistantResponseSubmitted) {
            const userText = isGroup ? `${senderName}: ${question}` : question;
            await saveSubmittedConversationTurn(
              sharedGroupSession || privateSession,
              userText,
              answer,
              emitStage,
            );
          }
        } else {
          const formattedAnswer = dependencies.formatMessage(answer);
          if (Buffer.byteLength(formattedAnswer, 'utf8') > MAX_ASSISTANT_RESPONSE_BYTES) {
            const error = new Error('Formatted assistant response is too large.');
            error.code = 'AI_RESPONSE_TOO_LARGE';
            throw error;
          }
          try {
            const sentMessage = await submitReply(formattedAnswer);
            if (sentMessage == null) {
              return;
            }
          } catch (error) {
            // The remote send may have completed before the transport failed.
            // Do not send a second fallback message with an uncertain outcome.
            return;
          }
          const userText = isGroup ? `${senderName}: ${question}` : question;
          await saveSubmittedConversationTurn(
            sharedGroupSession || privateSession,
            userText,
            answer,
            emitStage,
          );
          dependencies.logger?.event(
            'success',
            'Jawaban teks berhasil dikirim',
            'WhatsApp',
          );
        }
      } finally {
        activeSessions.delete(activeSessionId);
      }
    } catch (error) {
      if (!outboundAttempted && !failureStageLogged) {
        emitStage('message_processing', 'failed', error);
      }
      if (outboundAttempted) return;
      const fallbackMessage = dependencies.assistant.getFailureMessage(error);

      try {
        await submitReply(fallbackMessage);
      } catch {}
    }
  }

  return { handle };
}
