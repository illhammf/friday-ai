# Friday AI Daily-Use Runbook

This runbook covers a supervised, single-owner Friday installation. It does not establish WhatsApp identity verification or authorize privileged tools.

## Prerequisites

- Node.js 24 or newer. `package.json` sets `engines.node` to `>=24`; use the same Node version for install, checks, and startup.
- A Gemini API key with access and quota for the configured models.
- WhatsApp on a phone that can link a companion device.
- `ffmpeg` for voice/audio and media conversion; `yt-dlp` for optional public TikTok/Instagram downloads. The latter tools are optional for text chat.
- A stable local machine and terminal session. Keep the application to one running instance for this local data/auth directory.

## Install and verify Node.js 24

With nvm:

```bash
nvm install 24
nvm use 24
node --version
npm --version
```

The Node version shown in this terminal must be 24 or newer. On a new checkout:

```bash
npm ci
npm run doctor
npm run check
npm test
```

`npm run doctor` checks Node, whether `GEMINI_API_KEY` is present (never its value), and optional media executables. A missing media executable is a warning for that feature; missing Node support or the Gemini key is an error. A doctor check confirms configuration presence, not that the Gemini credential has usable quota.

## Environment configuration

Copy the example once; do not overwrite an existing `.env`:

```bash
cp .env.example .env
```

On PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` locally and set `GEMINI_API_KEY`. Do not put its value in shell history, screenshots, chat, source control, or diagnostic reports.

Required by the runtime:

- `GEMINI_API_KEY`: Gemini credential. Runtime diagnostics display only configured/not configured.
- Node.js `>=24`: declared in `package.json`, not an `.env` value.

Optional settings shown in `.env.example`:

- `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `GEMINI_FALLBACK_MODEL`: chat model and configured fallbacks.
- `GEMINI_IMAGE_MODEL`, `GEMINI_IMAGE_FALLBACK_MODELS`: image generation model chain.
- `BOT_NAME`: group prefix and assistant name; defaults to `Friday`.
- `FFMPEG_PATH`, `YT_DLP_PATH`: executable names or local executable paths if not on `PATH`.
- `YT_DLP_USER_AGENT`: optional request user-agent override.
- `NODE_ENV`: environment label.
- `AI_PROVIDER` and `BOT_PREFIX` appear in the example template but are not read by the current runtime; changing them does not switch providers or group-prefix behavior.

`.env`, `.wwebjs_auth/`, `.wwebjs_cache/`, SQLite files under `data/`, and log files are excluded by `.gitignore`. Keep those local files private anyway.

## Safe startup and WhatsApp authentication

From the repository root, in the terminal where Node 24 is selected:

```bash
npm run doctor
npm start
```

The application prints startup diagnostics and a WhatsApp QR code in that terminal when linking is needed. On the phone, open WhatsApp → **Linked devices** → **Link a device**, then scan the QR shown locally. Do not take or share a screenshot of the QR. Keep Friday running while testing. The `ready`/“online” message indicates the client is ready to accept events; it does not prove Gemini access or end-to-end message delivery.

WhatsApp Web.js stores local login state under `.wwebjs_auth/` relative to the working directory. Treat that directory as an account credential. Do not copy it to shared/cloud storage, commit it, or send it to anyone. Restarting normally reuses it. If authentication fails, first inspect the redacted error and linked-device state on the phone; do not delete the directory or database as a first troubleshooting step.

Friday stores conversation history and explicit memories in `data/friday.sqlite`, also relative to the repository working directory. Do not run multiple Friday processes against the same auth profile/database.

## Normal operation

- Keep the startup terminal open. Logs are written to terminal stdout/stderr; the project does not configure a persistent log file by default.
- In a private chat, send `/help`, `/ping`, or `/about`, then a short ordinary question.
- In groups, start a message with the configured bot name, for example `Friday, ...`. Group messages without the prefix are intentionally ignored. Group commands also need the prefix.
- Save memory only with the existing explicit private memory command. Do not test private memory in a group.
- Try image, Voice Note, sticker, and video features only when their local prerequisites are installed and the test content is appropriate to send to Gemini.
- A successful local send result is not proof the recipient received/read it. If a send outcome is uncertain, do not repeat the same request immediately; first check the chat and terminal to avoid a duplicate action.

## Safe shutdown

Press **Ctrl+C once** in the startup terminal and wait for the shutdown result. Friday stops admitting new messages, drains accepted queue work, destroys the WhatsApp client, and closes SQLite in that order. A normal completion log indicates local cleanup completed; it does not report WhatsApp delivery status.

For a service manager, send `SIGTERM` and wait for the process to exit. Avoid starting another instance until the first process has exited and released the WhatsApp profile and database.

## Recovery after startup failure

1. Do not repeatedly launch more instances. Confirm the previous process has exited.
2. Read the terminal error category/stage. Do not share unredacted logs; authentication/provider messages can contain operational details.
3. Check `node --version`, then run `npm run doctor` and `npm run check` from the repository root.
4. For `GEMINI_API_KEY` not configured, edit the local `.env`; never paste the value into the terminal transcript or report. If the key is configured but provider calls fail, check model access/quota through the provider's official account console.
5. For missing `ffmpeg`/`yt-dlp`, install the optional executable or set the corresponding path. Text chat can still be tested without `yt-dlp`.
6. For WhatsApp authentication errors, check the phone's Linked devices state and network. If a new QR is requested, scan it only in the trusted local terminal. Do not delete `.wwebjs_auth/` or `data/friday.sqlite` casually; deletion can invalidate login or destroy local history/memories.
7. If migrations or SQLite report an error, stop Friday and preserve a copy of the database before any recovery attempt. Do not recreate or replace the database to make startup succeed.

## Recovery after a stuck shutdown / queue drain

The queue drain has a 30-second deadline. If accepted work has not settled, Friday logs that the queue is still draining, sets a failing exit status, and intentionally keeps WhatsApp and SQLite open. Startup and cleanup waits are also bounded, but underlying operations cannot always be cancelled; the process can remain in `stopping`.

- Wait for an in-flight provider/media operation to settle. Do not close SQLite, delete auth state, or start a second instance while Friday remains alive.
- Use the terminal's stage/correlation logs to identify whether work is in provider, media, or reply submission. Correlation IDs are opaque; they do not identify a person or prove delivery.
- If the process remains stuck and you must stop it, use the operating system's normal process controls only as a last resort. Forced termination can lose accepted in-memory queued work and may leave the last response absent from history; the application does not replay it automatically on restart.
- After the process exits, restart once and verify `/ping` before normal use. Do not resend a prior request until you have checked whether its answer already appeared.

## Logs and diagnostic interpretation

Logs are in the startup terminal unless the operator explicitly redirects terminal output. `npm run doctor` prints Node version, whether the API key is configured, and version/check results for optional executables; it does not print the key itself. Runtime structured records use stages, outcomes, safe error categories, opaque correlation IDs, and selected numeric model metrics. They are not proof of recipient delivery.

Do not publish complete logs without reviewing/redacting them. In particular, QR codes, raw auth/provider errors, environment values, message/answer content, database contents, and account identifiers must not be shared. When asking for help, provide only the relevant stage/category and a sanitized excerpt.

## Gemini and WhatsApp troubleshooting

- **Friday starts but AI replies fail:** `npm run doctor` checks only key presence. Confirm model access/quota and configured model names in the provider console. User-facing errors intentionally omit provider internals. Existing bounded retries/model fallback are unchanged; do not create a manual retry loop.
- **`/ping` works but no AI answer:** the handler/transport is responsive, but this does not validate Gemini. Inspect safe provider error categories and verify network/model quota.
- **No response in a group:** use the exact configured `BOT_NAME` prefix. Unprefixed messages are ignored.
- **WhatsApp is disconnected or QR repeats:** check phone Linked devices and internet connectivity; avoid removing the local auth directory until you accept relinking.
- **A reply may have sent but the terminal reports uncertainty:** check the destination conversation before retrying. Friday suppresses duplicate fallbacks where the send outcome is uncertain.
- **Media only fails:** check `ffmpeg` and, for social-video downloads, `yt-dlp`; media support is separate from ordinary text chat.

## SQLite backup considerations

The database contains private conversation history and memories. Keep backups encrypted or in access-controlled local storage. Prefer a backup only after Friday has stopped and SQLite has closed. Copy `data/friday.sqlite` to an access-controlled destination; never include it in an issue, chat, or source repository. To restore, stop Friday first, preserve the current database as a separate backup, then restore the chosen copy. Do not inspect, edit, or delete database rows as routine troubleshooting.

## Security precautions

- Keep `.env`, WhatsApp auth/cache data, SQLite files, QR codes, and raw logs private.
- Use Friday only in chats/groups where you understand who can see prompts and responses. Group responses can be visible to all group members; private memory is not available to groups.
- Treat content sent to Gemini as leaving the local machine; avoid highly sensitive data unless you have reviewed the provider's terms and settings.
- Do not enable tool execution. WhatsApp private classification and sender identity verification are not authoritative. Keep Friday for supervised conversational use only.
- Do not run multiple instances with the same WhatsApp profile/database.
