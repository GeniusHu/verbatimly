# Verbatimly

Free video-to-text transcription in your browser.

**Try it: [verbatimly.ai](https://verbatimly.ai)**

Upload a video or audio file and get a timestamped transcript in about a minute — no sign-up, no app to install. Export as TXT, SRT or VTT subtitles.

## What it does

- Transcribes MP4, MOV, MKV, WebM, AVI, MP3, WAV, M4A (up to 25 MB per file)
- 100+ languages, automatic language detection
- Timestamped segments with click-to-seek playback
- Speaker labels (manual tagging), shareable transcripts
- Exports: plain text, SRT subtitles, VTT subtitles

## How it works

```
Browser                         Cloudflare                    Groq
────────────────────────────────────────────────────────────────────
video/audio file
 → Web Audio API extracts audio
 → 16 kHz mono resample
 → lamejs encodes 24 kbps MP3
   (30 min ≈ 5 MB)        ─────►  Worker /api/transcribe
                                  ├ Turnstile check
                                  ├ KV daily limit (3/day) ──► whisper-large-v3
                                  └ forward multipart      ◄── verbose_json (segments)
 ← render, edit, export TXT/SRT/VTT in the same page
```

Audio never touches a third-party upload service from the browser directly: the browser extracts and compresses the track, then the Worker forwards it to Groq for transcription. Per-IP daily limits are enforced with Cloudflare KV and Turnstile.

## Stack

- Cloudflare Workers (API) + Cloudflare Pages (static site)
- Vanilla JavaScript, no framework
- Groq Whisper large-v3 for transcription
- Waffo for payments (optional Pro tier)

## Local development

```bash
# one-time: wrangler login, create KV namespace, set secrets
cd src
wrangler kv namespace create RATE      # put the id into wrangler.toml
wrangler secret put GROQ_API_KEY
wrangler secret put TURNSTILE_SECRET
wrangler deploy                        # API worker -> verbatimly.ai/api/*

cd ../public
wrangler pages deploy . --project-name=verbatimly
```

## License

MIT
