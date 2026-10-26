import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ai } from '../ai/gemini.js';

export async function generateVoiceNote(text) {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'friday-tts-'),
  );

  const wavPath = join(temporaryDirectory, 'answer.wav');
  const oggPath = join(temporaryDirectory, 'answer.ogg');

  try {
    const interaction = await ai.interactions.create({
      model: 'gemini-3.8-flash-tts',
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text: text.slice(0, 4000),
              annotations: [
                {
                  type: 'speech_metadata',
                  style: 'A calm, intelligent, feminine-sounding futuristic AI assistant. Speak Indonesian naturally, with clear articulation, measured pacing, subtle warmth, and confident but gentle intonation. Sound composed, polished, and professional. Avoid exaggerated emotion and an overly cheerful tone.',
                },
              ],
            },
          ],
        },
      ],
      response_format: { type: 'audio' },
      generation_config: {
        speech_config: [
          { voice: 'Despina' }, // Bisa juga Laomedeia, Kore, Achernar, Erinome, Despina atau lainnya sesuai dokumentasi Gemini TTS.
        ],
      },
    });

    if (!interaction.output_audio?.data) {
      throw new Error('Gemini tidak menghasilkan data audio.');
    }

    await writeFile(
      wavPath,
      Buffer.from(interaction.output_audio.data, 'base64'),
    );

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    await execFileAsync('ffmpeg', [
      '-y',
      '-i', wavPath,
      '-vn',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-vbr', 'on',
      '-application', 'voip',
      '-ac', '1',
      '-ar', '48000',
      oggPath,
    ]);

    return {
      path: oggPath,
      cleanup: () => rm(temporaryDirectory, {
        recursive: true,
        force: true,
      }),
    };
  } catch (error) {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
    });
    throw error;
  }
}
