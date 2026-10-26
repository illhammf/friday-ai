
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  throw new Error('GEMINI_API_KEY belum dikonfigurasi di file .env.');
}

export const ai = new GoogleGenAI({
  apiKey: API_KEY,
});

