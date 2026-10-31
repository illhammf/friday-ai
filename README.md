# Friday AI

Friday is a personal AI assistant for WhatsApp, built with Node.js, the
unofficial `whatsapp-web.js` library, and Google's Gemini API. It can chat,
understand photos and voice notes, create images and stickers, and download
public TikTok or Instagram videos when explicitly asked.

**Repository:** [github.com/illhammf/friday-ai](https://github.com/illhammf/friday-ai)  
**Maintainer:** [@illhammf](https://github.com/illhammf)

> **Project status:** Friday is a personal project and is provided as-is.
> WhatsApp Web, Gemini model availability, platform access, and free quotas
> can change. Some features require local tools or API access.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Using Friday](#using-friday)
- [Model fallback](#model-fallback)
- [Runtime checks and tests](#runtime-checks-and-tests)
- [Data, privacy, and security](#data-privacy-and-security)
- [Limitations and troubleshooting](#limitations-and-troubleshooting)
- [Project structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

## Features

- **WhatsApp chat:** Responds to private messages with conversation history
  and a configurable Gemini chat model.
- **Group chats:** Responds only when a message starts with the configured bot
  name, such as `Friday, ...`. Messages that do not address Friday are ignored.
- **Photo understanding:** Send a photo with a question or caption to ask
  Friday about its contents.
- **Image generation:** Ask Friday to create an image from a text prompt.
- **Photo stickers:** Turn a supported image into a WebP WhatsApp sticker.
  Optionally add a short text caption or request a centered square crop.
- **Voice notes:** Transcribes incoming voice notes and can send replies as
  voice notes, with a text fallback if audio generation or delivery fails.
- **Social video downloads:** Download and return a public TikTok or Instagram
  video only when the user explicitly requests a download.
- **Adaptive replies:** Adapts tone to the conversation and supports explicit
  requests for a casual, playful, romantic, or firm style while keeping replies
  readable in WhatsApp.
- **Private user memory:** Saves, lists, and deletes memories only when
  explicitly requested in a private chat.
- **Per-chat message queue:** Processes messages in order, limits pending work,
  and ignores duplicate WhatsApp delivery events while the process is running.
- **Safe shutdown:** Stops accepting new messages, drains queued work, and
  closes WhatsApp and the local database on Ctrl+C or SIGTERM.

## Requirements

- Node.js **24 or newer**
- A Gemini API key with access to the models configured for your project
- WhatsApp account for linking Friday as a companion device
- `ffmpeg` for sticker creation, voice-note processing, and video conversion
- `yt-dlp` for TikTok and Instagram video downloads

Text chat and photo analysis do not require `yt-dlp`. Media features that need
an unavailable local tool will not work until that tool is installed.

Install Node.js from the [official Node.js downloads](https://nodejs.org/en/download).
On Ubuntu/Debian, ffmpeg is available through `apt`:

```bash
sudo apt update
sudo apt install ffmpeg
```

On macOS with [Homebrew](https://brew.sh/):

```bash
brew install ffmpeg yt-dlp
```

On other platforms, use the official installation instructions for
[ffmpeg](https://ffmpeg.org/download.html) and
[yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/Installation). Restart your
terminal after installing tools, then check they are available with
`ffmpeg -version` and `yt-dlp --version`.

## Quick start

### 1. Clone the repository

```bash
git clone https://github.com/illhammf/friday-ai.git
cd friday-ai
```

### 2. Install Node.js dependencies

Use Node.js 24 or newer, then install the exact versions recorded in the lock
file:

```bash
npm ci
```

### 3. Install media tools

Install `ffmpeg` using your operating system's package manager. Install
`yt-dlp` from its
[official releases](https://github.com/yt-dlp/yt-dlp/releases/latest) if you
want social-video downloads. On Linux, download the `yt-dlp` release binary,
not the GitHub homepage.

Make sure both executables are available on `PATH`, or configure their
locations with `FFMPEG_PATH` and `YT_DLP_PATH`.

### 4. Configure Friday

Copy the example configuration and add your Gemini API key:

```bash
cp .env.example .env
```

In PowerShell, use:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and set `GEMINI_API_KEY`. Keep the key private. Never commit `.env`
or paste the key into a chat, issue, screenshot, or log.

### 5. Check the setup and start Friday

```bash
npm run doctor
npm start
```

On the first launch, Friday displays a QR code in the terminal. On your
WhatsApp phone, open **Linked devices → Link a device** and scan it. Keep the
process running while Friday is online. WhatsApp login data is saved locally
so you usually do not need to scan again after every restart.

For development, use:

```bash
npm run dev
```

## Configuration

The complete template is in [.env.example](./.env.example). The most commonly
used options are:

| Variable | Purpose | Default |
| --- | --- | --- |
| `GEMINI_API_KEY` | Gemini API credential. Required; its value is not printed by the doctor. | — |
| `GEMINI_MODEL` | Primary model for chat and photo understanding. | `gemini-3.5-flash-lite` |
| `GEMINI_FALLBACK_MODELS` | Comma-separated chat fallback models, tried in order. | — |
| `GEMINI_FALLBACK_MODEL` | Legacy single chat fallback; tried after the fallback list. | — |
| `GEMINI_IMAGE_MODEL` | Primary image-generation model. | `gemini-3.1-flash-image` |
| `GEMINI_IMAGE_FALLBACK_MODELS` | Comma-separated image-generation fallbacks. Each must support image output. | — |
| `BOT_NAME` | Name Friday listens for in group messages and uses in replies. | `Friday` |
| `BOT_PREFIX` | Reserved/configuration value for the bot prefix. | `Friday` |
| `FFMPEG_PATH` | Path to the ffmpeg executable. | `ffmpeg` |
| `YT_DLP_PATH` | Path to the yt-dlp executable. | `yt-dlp` |
| `YT_DLP_USER_AGENT` | Optional browser user-agent for social-video requests. | Built-in default |
| `NODE_ENV` | Runtime environment label. | `development` |

Set paths without surrounding quotes unless your environment requires them.
For example:

```dotenv
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_FALLBACK_MODELS=gemini-3.1-flash-lite,another-model-you-verified
GEMINI_IMAGE_MODEL=gemini-3.1-flash-image
GEMINI_IMAGE_FALLBACK_MODELS=another-image-model-you-verified
BOT_NAME=Friday
FFMPEG_PATH=/usr/bin/ffmpeg
YT_DLP_PATH=/usr/local/bin/yt-dlp
```

The model names above are configuration examples, not a promise of free
availability. Confirm that each model is available to your Google AI Studio
project and that it supports the required input/output modalities.

## Using Friday

### Private chats

Send Friday a message directly. Examples:

- `Friday, bantu jelaskan cara kerja fotosintesis`
- `Buatkan gambar kucing astronot`
- Send a photo with the caption `Apa yang terlihat di foto ini?`
- Send a voice note and Friday will transcribe and respond to it.

### Group chats

Friday ignores group messages unless they start with its configured name:

```text
Friday, jelaskan foto ini
```

The bot name is matched without regard to capitalization. Unaddressed group
messages do not enter the message queue.

### Make a sticker

Send an image with a sticker request:

```text
Friday, jadiin stiker
Friday, jadiin stiker dan kasih tulisan Bestie
Friday, buat stiker crop
```

Stickers are static WebP images fitted to a 512 × 512 canvas and kept below
WhatsApp's 100 KB sticker limit. Without `crop`, Friday fits the full image
inside the canvas. A centered crop can trim image edges; it does not identify
faces, choose a subject, or remove the background.

### Generate an image

Ask Friday to create a new image, for example:

```text
Buatkan gambar kucing astronot
Generate an image of a cabin in the snow
```

Image generation uses its own model setting and fallback list. A text model
is not automatically a valid image-generation fallback.

### Download a social video

Include a public TikTok or Instagram video URL and an explicit download
request:

```text
Download video ini https://www.tiktok.com/@user/video/123
```

Friday does not download a video when only a link is sent. Downloads are
limited to 64 MB and three minutes, then converted to H.264/AAC MP4 for
WhatsApp compatibility. Only download videos you are authorized to use.

Private, login-required, age-restricted, removed, or otherwise inaccessible
content is not supported. Platform rate limits or website changes can also
temporarily prevent downloads.

### Voice notes

Incoming voice notes are transcribed before Friday generates a response.
Friday may send a voice reply; if voice generation or delivery fails, it
provides a text explanation and the answer as text instead.

### Manage private memory

Friday stores a memory only after an explicit request in a private chat:

| Example message | Action |
| --- | --- |
| `Friday, ingat ya aku suka jawaban singkat` | Save a preference |
| `Friday, ingat apa tentang aku?` | List saved memories |
| `Friday, hapus memori 2` | Delete one memory by its displayed number |
| `Friday, hapus semua memori` | Clear all memories for that private chat |

Memory is local to the account that sent the command. Friday does not load
private memories into group chats and refuses to save passwords, PINs, OTPs,
API keys, or access tokens. Memory is limited to 30 entries of up to 500
characters each.

## Model fallback

Chat and image generation use separate ordered model chains:

1. Friday tries the configured primary model.
2. On quota/rate-limit, temporary service, or unknown-model errors, it tries
   the next configured model.
3. If all configured models fail, Friday returns a short, user-friendly
   message; technical diagnostics remain in the terminal.

Configure chat fallbacks with a comma-separated `GEMINI_FALLBACK_MODELS` and
image fallbacks with `GEMINI_IMAGE_FALLBACK_MODELS`. The older
`GEMINI_FALLBACK_MODEL` setting is still supported.

Fallbacks are **not automatically discovered**, and adding a model does not
make it free. Gemini access and quota depend on the Google Cloud project,
specific model, usage tier, region, and current Google policies. Check the
active limits for your project in
[Google AI Studio](https://aistudio.google.com/rate-limit) and only configure
models you have verified. A fallback chain cannot guarantee uninterrupted
service if every configured model is unavailable or out of quota.

## Runtime checks and tests

```bash
npm run doctor  # Check Node.js, API-key presence, ffmpeg, and yt-dlp
npm run check   # Syntax-check the application entry point
npm test        # Run automated feature and regression tests
```

The doctor never prints the API key. Missing `yt-dlp` or `ffmpeg` is reported
as a feature-specific warning; ordinary chat may still work.

## Data, privacy, and security

- `.env` contains secrets and is excluded from Git. Keep it private.
- `.wwebjs_auth/` contains WhatsApp Web session credentials. Treat it as
  sensitive and do not share, commit, or upload it.
- Local chat history and memories are stored in `data/friday.sqlite`. This is
  local application data, **not an encrypted password vault**.
- Messages, prompts, and attached media used by AI features are sent to the
  configured Gemini API. Review Google's current terms and data practices
  before using Friday with sensitive information.
- Do not expose Friday to untrusted users without reviewing its permissions,
  data-retention behavior, and group-chat configuration.
- WhatsApp Web automation uses an unofficial library and is not affiliated
  with or endorsed by WhatsApp/Meta. Its behavior may break when WhatsApp Web
  changes, and use may be subject to WhatsApp's terms and account limits.
- Friday's local queue and duplicate-event cache are in memory. Duplicate
  events are suppressed for up to 24 hours while the process is running; this
  is not a durable exactly-once guarantee across restarts or multiple bot
  instances.

## Limitations and troubleshooting

### `npm run doctor` reports an unsupported Node.js version

Install Node.js 24 or newer, then rerun the doctor. If multiple versions are
installed, verify that `node --version` in the same terminal used to start
Friday reports the intended version.

### Friday does not respond in a group

Start the message with the configured `BOT_NAME`, for example `Friday, ...`.
Friday intentionally ignores messages that do not address it.

### Image generation or AI replies are unavailable

Check the terminal for diagnostics and confirm the API key, selected model,
project access, and current quota in AI Studio. Configure verified fallback
models if appropriate. Friday does not print internal provider errors in
WhatsApp replies.

### A sticker, voice note, or video feature is unavailable

Run `npm run doctor` and confirm `ffmpeg` is installed. Video downloading also
requires `yt-dlp`. Set `FFMPEG_PATH` or `YT_DLP_PATH` if the executable is not
on `PATH`.

### A public social-video link fails

“Public” in the mobile app does not guarantee that the server can fetch the
video. The platform may rate-limit requests, require authentication from the
server's location, or change its website. Try again later or use another
public link that is accessible without login. Friday cannot bypass access
controls.

## Project structure

```text
src/
  ai/          Gemini chat, image generation, fallback, style, and memory
  audio/       Voice-note transcription, generation, and failure handling
  config/      Runtime diagnostics and system configuration
  database/    Local SQLite history and memory storage
  video/       Public social-video validation, download, and conversion
  whatsapp/   WhatsApp client helpers, message queue, stickers, and formatting
  index.js     Application entry point and message routing
scripts/
  doctor.js    Runtime and media-tool diagnostics
test/          Automated unit and integration-style tests
```

## Contributing

Issues and pull requests are welcome. Before opening a pull request:

1. Keep changes focused and avoid including credentials, WhatsApp session
   files, databases, or personal chat data.
2. Run `npm run check` and `npm test`.
3. Describe any required environment variables, model access, or local media
   tools.
4. Include steps to reproduce behavior changes and tests where practical.

## License

The repository currently declares `"license": "UNLICENSED"` in `package.json`
and does not include an open-source license. Public visibility or the ability
to clone the repository does not by itself grant permission to redistribute
or reuse the code. Contact the maintainer about licensing before publishing
derivative work.
