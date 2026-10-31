# Friday AI

Personal WhatsApp assistant built with Node.js, WhatsApp Web, and Gemini.

## Requirements

- Node.js 24 or newer
- A Gemini API key with access to the configured chat and image models
- `ffmpeg` (used for voice notes and social-video remuxing)
- `yt-dlp` available on `PATH` to download public TikTok and Instagram video links

Copy `.env.example` to `.env`, then set `GEMINI_API_KEY`. `YT_DLP_PATH` and
`FFMPEG_PATH` can be set to their executable paths if either program is not
available on `PATH`. `YT_DLP_USER_AGENT` can optionally override the browser
user-agent used when requesting social videos.

## Media features

- Send a photo in WhatsApp to have Friday describe it. A caption or question
  sent with the photo is included in the request.
- Ask Friday to make an image, for example: "Buatkan gambar kucing astronot".
  Requests such as "bikin foto pemandangan pantai" and "generate an image of a
  cabin in the snow" are also supported, as are short prompts such as
  "gambar burung". Requests to describe or caption an existing image stay in
  the normal chat flow. `GEMINI_IMAGE_MODEL` controls the Gemini
  image-generation model; the default is `gemini-3.1-flash-image`.
- Send a public TikTok or Instagram video URL with an explicit request such as
  "download video ini https://www.tiktok.com/@user/video/..." to download and
  return the video. Sending a link alone does not start a download. Downloads
  are limited to 64 MB and three minutes. Private content, login-required
  content, and content protected by access restrictions are not supported.
  Only download content you are authorized to use.

## Conversation style

Friday adapts its reply tone to the user's message and recent chat context.
Explicit requests such as "coba bercanda", "balas romantis", or "jawab dengan
tegas" take priority over the default tone. Humor stays light, romance is
wordplay rather than a claim of a real relationship, and an angry/firm tone
must not become insults or threats. Style changes the delivery, not accuracy
or safety.

Video downloads require `yt-dlp` and `ffmpeg` to be installed on the machine
running Friday. Install them using your operating system's package manager or
the projects' official installation instructions.
For a Linux standalone binary, use the asset named `yt-dlp` from the official
[yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases/latest), not the
GitHub homepage URL. Friday converts downloaded videos to H.264/AAC MP4 before
sending them so formats such as TikTok HEVC videos are compatible with
WhatsApp Web. If a download fails, WhatsApp receives a concise explanation
for common causes such as temporary platform limits, login-only videos,
network failures, or file-size limits; internal diagnostics remain in the
Friday terminal.

Run `npm run doctor` to check the Node.js version, whether `GEMINI_API_KEY` is
configured (its value is never displayed), and whether `yt-dlp` and `ffmpeg`
are available. Missing media tools are reported as warnings so text chat and
other available features can continue working.

## Commands

- `npm start` starts Friday.
- `npm run check` checks the entry point syntax.
- `npm run doctor` checks runtime and media-tool setup.
- `npm test` runs the automated tests.
