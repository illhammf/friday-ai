# Friday AI

Personal WhatsApp assistant built with Node.js, WhatsApp Web, and Gemini.

## Requirements

- Node.js 24 or newer
- A Gemini API key with access to the configured chat and image models
- `ffmpeg` (used for voice notes and social-video remuxing)
- `yt-dlp` available on `PATH` to download public TikTok and Instagram video links

Copy `.env.example` to `.env`, then set `GEMINI_API_KEY`. `YT_DLP_PATH` can be
set to the full executable path if `yt-dlp` is not available on `PATH`.

## Media features

- Send a photo in WhatsApp to have Friday describe it. A caption or question
  sent with the photo is included in the request.
- Ask Friday to make an image, for example: "Buatkan gambar kucing astronot".
  Requests such as "bikin foto pemandangan pantai" and "generate an image of a
  cabin in the snow" are also supported, as are short prompts such as
  "gambar burung". Requests to describe or caption an existing image stay in
  the normal chat flow. `GEMINI_IMAGE_MODEL` controls the Gemini
  image-generation model; the default is `gemini-3.1-flash-image`.
- Send one public TikTok or Instagram video URL to download and return the
  video. Downloads are limited to 64 MB and three minutes. Private content,
  login-required content, and content protected by access restrictions are not
  supported. Only download content you are authorized to use.

Video downloads require `yt-dlp` and `ffmpeg` to be installed on the machine
running Friday. Install them using your operating system's package manager or
the projects' official installation instructions.

## Commands

- `npm start` starts Friday.
- `npm run check` checks the entry point syntax.
- `npm test` runs the automated tests.
