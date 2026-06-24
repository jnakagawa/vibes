# 読む — Japanese Reader

Photograph a page of Japanese, highlight any phrase, and get **furigana**, a
**dictionary definition**, and a **natural translation**.

Built for the phone: open it on your phone's browser, tap to use the camera,
highlight a phrase in the recognized text, tap **Look up**.

## How it works

| Step | Engine |
|------|--------|
| OCR (photo → text) | **Apple Vision** (macOS, local, free, no key — default) → **Google Cloud Vision** if you set `GOOGLE_API_KEY` → in-browser **Tesseract.js** last-resort fallback |
| Furigana (readings) | **kuromoji** morphological analysis, runs locally, okurigana-aware ruby |
| Word definitions | **Jisho / JMdict** dictionary lookup |
| Sentence translation | **Google Translate API** (the "if possible" part — used automatically when a key is set) |

Interaction: drag a finger across the recognized text — the reading floats above the
phrase, the meaning below — and lift to dismiss. Tap **Edit** to fix any OCR slip.

### A note on OCR engines

- **Apple Vision** (default on macOS) reads both **horizontal and vertical** Japanese
  (textbooks, signs, novels, manga), fully local and free. It uses the modern
  `RecognizeTextRequest` API (macOS 15+), which is what powers system Live Text.
- The Apple Vision helper is a tiny Swift binary at `bin/mac-ocr`, built automatically by
  `npm install` (or `npm run build`). Requires the Xcode command-line tools (`swiftc`).
- `GOOGLE_API_KEY` (or `OCR_ENGINE=google`) switches OCR to Google Cloud Vision and also
  enables full-sentence translation.

## Run

```bash
npm install
# optional — enables Google Vision OCR + Translate:
export GOOGLE_API_KEY=your_key_here
npm start
```

Then open **http://localhost:3939**.

### Use it from your phone (same Wi-Fi)

Find your Mac's LAN IP and open `http://<that-ip>:3939` on the phone:

```bash
ipconfig getifaddr en0     # e.g. 192.168.1.42  ->  http://192.168.1.42:3939
```

Camera capture and clipboard work over plain HTTP on a LAN for most phones; if
your browser insists on HTTPS for the camera, use the "choose an image" option
or put it behind a tunnel (e.g. `cloudflared`, `ngrok`, or Tailscale).

## Google API key (optional)

1. In Google Cloud, enable **Cloud Vision API** and **Cloud Translation API**.
2. Create an **API key** under *APIs & Services → Credentials*.
3. `export GOOGLE_API_KEY=...` before `npm start` (or put it in a `.env` and
   `export $(cat .env | xargs)`).

Without a key the app still works end to end: Tesseract.js does the OCR and you
get furigana + per-word definitions; only the full-sentence Google translation
is skipped.
