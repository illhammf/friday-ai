import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ai } from '../ai/gemini.js';

export async function transcribeVoiceNote(media) { // Untuk transkripsi catatan suara, media adalah objek yang berisi data audio.
  if (!media?.data || !media.mimetype?.startsWith('audio/')) {
    throw new Error('Lampiran bukan audio yang didukung.');
  }

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'friday-audio-'),
  );

  const audioPath = join(temporaryDirectory, 'voice-note.ogg');

  try {
    const audioBuffer = Buffer.from(media.data, 'base64');
    await writeFile(audioPath, audioBuffer);

    const uploadedAudio = await ai.files.upload({
      file: audioPath,
      config: {
        mime_type: media.mimetype,
      },
    });

    const transcription = await ai.interactions.create({
      model: 'gemini-3.5-transcribe',
      input: [
        {
          type: 'audio',
          uri: uploadedAudio.uri,
          mime_type: uploadedAudio.mimeType,
        },
      ],
    });

    const transcript = transcription.output_text?.trim();

    if (!transcript) {
      throw new Error('Transkripsi audio tidak menghasilkan teks.');
    }

    return transcript;
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
}
