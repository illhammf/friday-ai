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
- Send a photo with a request such as "buatkan stiker dari foto ini" to get a
  WhatsApp sticker. Static stickers are converted to WebP, fitted within a
  512-pixel canvas, and compressed to WhatsApp's 100 KB sticker limit. Add
  optional text with "buat stiker, kasih tulisan Bestie"; ask for a centered
  square crop with "buat stiker crop". Crop keeps the center of the image and
  can trim its edges; it does not detect faces or remove the background.
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

WhatsApp replies are formatted for mobile reading: Markdown headings and
blockquotes are flattened, lists are normalized, tables become bullets, and
code blocks remain copyable. Text, image captions, and Voice Note fallback
replies use the same formatter.

Messages in each WhatsApp chat are processed in order. Friday can keep up to
three additional messages waiting while one is being handled; when that queue
is full, Friday asks the sender to retry instead of silently dropping a
message. Repeated WhatsApp delivery events for the same message ID are ignored
for up to 24 hours, with a bounded in-memory cache. Unaddressed group messages
are ignored without entering the queue.
On shutdown, Friday stops accepting new messages, drains the current queue,
then closes WhatsApp and the local database. Both Ctrl+C and SIGTERM use the
same cleanup sequence.

If an AI or media feature is unavailable, Friday replies with a short
explanation and a reasonable next step. Provider errors, stack traces, and
configuration details stay in the terminal logs rather than WhatsApp replies.

## User-controlled memory

Friday only saves a memory when a user explicitly asks in a private chat, for
example: "Friday, ingat ya aku suka jawaban singkat." Memories are local to
that WhatsApp account, are not loaded in group chats, and are stored in the
local `data/friday.sqlite` database. The database is local application data,
not an encrypted password vault; protect access to the machine and database
file. Friday does not save passwords, PINs, one-time codes, API keys, or access
tokens.

- "Friday, ingat apa tentang aku?" lists saved memories.
- "Friday, hapus memori 2" deletes one item by its displayed number.
- "Friday, hapus semua memori" clears that private chat's memories.
- "Friday, ingat ya ..." explicitly saves a new item.

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
