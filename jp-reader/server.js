'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const kuromoji = require('kuromoji');

const app = express();
const PORT = process.env.PORT || 3939;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.GOOGLE_TRANSLATE_API_KEY || '';

// Native macOS Vision OCR (free, local). Available when running on macOS and the
// compiled helper exists. `OCR_ENGINE=google` forces Google Vision instead.
const MAC_OCR_BIN = path.join(__dirname, 'bin', 'mac-ocr');
const MAC_OCR_AVAILABLE = process.platform === 'darwin' && fs.existsSync(MAC_OCR_BIN);
const FORCE_GOOGLE = (process.env.OCR_ENGINE || '').toLowerCase() === 'google';
const OCR_ENGINE =
  (!FORCE_GOOGLE && MAC_OCR_AVAILABLE) ? 'apple-vision' : (GOOGLE_API_KEY ? 'google-vision' : null);

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Kuromoji tokenizer (built once at startup, reused for every request)
// ---------------------------------------------------------------------------
let tokenizer = null;
let tokenizerError = null;

kuromoji
  .builder({ dicPath: path.join(__dirname, 'node_modules', 'kuromoji', 'dict') })
  .build((err, tk) => {
    if (err) {
      tokenizerError = err;
      console.error('Failed to build kuromoji tokenizer:', err);
      return;
    }
    tokenizer = tk;
    console.log('kuromoji tokenizer ready');
  });

// ---------------------------------------------------------------------------
// Japanese text helpers
// ---------------------------------------------------------------------------
const KANJI_RE = /[一-龯㐀-䶿豈-﫿]/;

function hasKanji(s) {
  return KANJI_RE.test(s);
}

function kataToHira(s) {
  if (!s) return '';
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// Build okurigana-aware ruby for a single token.
// Returns { surface, reading, ruby:[{base, rt}] } where rt is '' for kana runs.
function rubyForToken(surface, readingKata) {
  const reading = kataToHira(readingKata || '');
  if (!hasKanji(surface) || !reading) {
    return { surface, reading, ruby: [{ base: surface, rt: '' }] };
  }

  // Strip matching leading kana (non-kanji surface chars that equal the reading).
  let pre = 0;
  while (
    pre < surface.length &&
    pre < reading.length &&
    !KANJI_RE.test(surface[pre]) &&
    surface[pre] === reading[pre]
  ) {
    pre++;
  }

  // Strip matching trailing kana (okurigana).
  let suf = 0;
  while (
    suf < surface.length - pre &&
    suf < reading.length - pre &&
    !KANJI_RE.test(surface[surface.length - 1 - suf]) &&
    surface[surface.length - 1 - suf] === reading[reading.length - 1 - suf]
  ) {
    suf++;
  }

  const lead = surface.slice(0, pre);
  const core = surface.slice(pre, surface.length - suf);
  const tail = suf === 0 ? '' : surface.slice(surface.length - suf);
  const coreReading = reading.slice(pre, reading.length - suf);

  const parts = [];
  if (lead) parts.push({ base: lead, rt: '' });
  if (core) parts.push({ base: core, rt: hasKanji(core) ? coreReading : '' });
  if (tail) parts.push({ base: tail, rt: '' });
  return { surface, reading, ruby: parts };
}

// Parts of speech worth looking up in the dictionary.
const CONTENT_POS = new Set(['名詞', '動詞', '形容詞', '副詞', '形容動詞', '連体詞']);

function analyzeText(text) {
  if (!tokenizer) throw new Error('tokenizer not ready');
  const tokens = tokenizer.tokenize(text);
  const out = tokens.map((t) => {
    const surface = t.surface_form;
    const base = t.basic_form && t.basic_form !== '*' ? t.basic_form : surface;
    const readingKata = t.reading && t.reading !== '*' ? t.reading : '';
    const r = rubyForToken(surface, readingKata);
    return {
      surface,
      base,
      reading: r.reading,
      pos: t.pos,
      pos_detail: t.pos_detail_1,
      ruby: r.ruby,
      // Worth a dictionary lookup: content words, skipping non-independent
      // helpers, numbers, and bare suffixes.
      lookup:
        CONTENT_POS.has(t.pos) &&
        t.pos_detail_1 !== '非自立' &&
        t.pos_detail_1 !== '数' &&
        t.pos_detail_1 !== '接尾',
    };
  });
  return out;
}

// ---------------------------------------------------------------------------
// External services
// ---------------------------------------------------------------------------
async function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out`)), ms);
  });
  try {
    return await Promise.race([promise, t]);
  } finally {
    clearTimeout(timer);
  }
}

// Jisho.org unofficial API — dictionary definitions (proxied to avoid CORS).
async function jishoLookup(word) {
  const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(word)}`;
  const res = await withTimeout(fetch(url), 8000, 'jisho');
  if (!res.ok) throw new Error(`jisho ${res.status}`);
  const json = await res.json();
  const first = (json.data || [])[0];
  if (!first) return null;
  const jp = (first.japanese || [])[0] || {};
  const senses = (first.senses || []).slice(0, 3).map((s) => ({
    definitions: s.english_definitions || [],
    pos: s.parts_of_speech || [],
  }));
  return {
    word: jp.word || word,
    reading: jp.reading || '',
    is_common: !!first.is_common,
    senses,
  };
}

// Google Translate API v2 (REST, API-key auth).
async function googleTranslate(text, target = 'en', source = 'ja') {
  if (!GOOGLE_API_KEY) return null;
  const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_API_KEY}`;
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, target, source, format: 'text' }),
    }),
    8000,
    'translate'
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`google translate ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json?.data?.translations?.[0]?.translatedText || null;
}

// Native macOS Vision OCR — writes the image to a temp file and runs the helper.
function appleVisionOcr(base64, mime) {
  return new Promise((resolve, reject) => {
    const ext = /jpe?g/.test(mime || '') ? 'jpg' : 'png';
    const tmp = path.join(os.tmpdir(), `jpreader-${crypto.randomUUID()}.${ext}`);
    fs.writeFile(tmp, Buffer.from(base64, 'base64'), (werr) => {
      if (werr) return reject(werr);
      execFile(MAC_OCR_BIN, [tmp], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        fs.unlink(tmp, () => {});
        if (err) return reject(new Error(`mac-ocr: ${stderr || err.message}`));
        resolve((stdout || '').trim());
      });
    });
  });
}

// Google Cloud Vision OCR (TEXT_DETECTION, API-key auth).
async function googleVisionOcr(base64) {
  if (!GOOGLE_API_KEY) return null;
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_API_KEY}`;
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            image: { content: base64 },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            imageContext: { languageHints: ['ja'] },
          },
        ],
      }),
    }),
    15000,
    'vision'
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`google vision ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const r = json?.responses?.[0];
  if (r?.error) throw new Error(`google vision: ${r.error.message}`);
  return r?.fullTextAnnotation?.text || '';
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/api/config', (_req, res) => {
  res.json({
    ocrEngine: OCR_ENGINE,                 // 'apple-vision' | 'google-vision' | null
    serverOcr: !!OCR_ENGINE,
    googleTranslate: !!GOOGLE_API_KEY,
    tokenizerReady: !!tokenizer,
  });
});

app.post('/api/ocr', async (req, res) => {
  try {
    let { image } = req.body || {};
    if (!image) return res.status(400).json({ error: 'missing image' });
    // Accept data URLs or raw base64.
    let mime = '';
    if (image.startsWith('data:')) {
      const comma = image.indexOf(',');
      mime = image.slice(5, image.indexOf(';'));
      if (comma !== -1) image = image.slice(comma + 1);
    }

    if (!OCR_ENGINE) {
      return res.status(200).json({ text: '', source: 'none', needFallback: true });
    }
    const text = OCR_ENGINE === 'apple-vision'
      ? await appleVisionOcr(image, mime)
      : await googleVisionOcr(image);
    res.json({ text, source: OCR_ENGINE });
  } catch (err) {
    console.error('ocr error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  try {
    const text = (req.body && req.body.text ? String(req.body.text) : '').trim();
    if (!text) return res.status(400).json({ error: 'missing text' });
    if (!tokenizer) {
      return res.status(503).json({ error: tokenizerError ? 'tokenizer failed to load' : 'tokenizer warming up' });
    }
    if (text.length > 400) {
      return res.status(413).json({ error: 'phrase too long (max 400 chars)' });
    }

    const tokens = analyzeText(text);

    // Unique dictionary-form lookups for content words (cap to keep it snappy).
    const seen = new Set();
    const lookups = [];
    for (const t of tokens) {
      if (!t.lookup) continue;
      const key = t.base || t.surface;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      lookups.push(key);
      if (lookups.length >= 10) break;
    }

    const [translation, ...wordResults] = await Promise.all([
      googleTranslate(text).catch((e) => {
        console.warn('translate failed:', e.message);
        return null;
      }),
      ...lookups.map((w) =>
        jishoLookup(w).catch((e) => {
          console.warn(`jisho "${w}" failed:`, e.message);
          return null;
        })
      ),
    ]);

    const words = wordResults.filter(Boolean);

    res.json({
      text,
      tokens,
      words,
      translation,
      translationSource: translation ? 'google' : null,
    });
  } catch (err) {
    console.error('analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Fast path: tokenize only (kuromoji, no network) so furigana feels instant.
app.post('/api/furigana', (req, res) => {
  try {
    const text = (req.body && req.body.text ? String(req.body.text) : '').trim();
    if (!text) return res.status(400).json({ error: 'missing text' });
    if (!tokenizer) return res.status(503).json({ error: 'tokenizer warming up' });
    if (text.length > 400) return res.status(413).json({ error: 'phrase too long' });
    res.json({ text, tokens: analyzeText(text) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Slower path: translation + dictionary definitions (network-bound).
app.post('/api/meaning', async (req, res) => {
  try {
    const text = (req.body && req.body.text ? String(req.body.text) : '').trim();
    if (!text) return res.status(400).json({ error: 'missing text' });
    if (!tokenizer) return res.status(503).json({ error: 'tokenizer warming up' });
    if (text.length > 400) return res.status(413).json({ error: 'phrase too long' });

    const tokens = analyzeText(text);
    const seen = new Set();
    const lookups = [];
    for (const t of tokens) {
      if (!t.lookup) continue;
      const key = t.base || t.surface;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      lookups.push(key);
      if (lookups.length >= 6) break;
    }

    const [translation, ...wordResults] = await Promise.all([
      googleTranslate(text).catch((e) => {
        console.warn('translate failed:', e.message);
        return null;
      }),
      ...lookups.map((w) => jishoLookup(w).catch(() => null)),
    ]);

    res.json({
      text,
      translation,
      translationSource: translation ? 'google' : null,
      words: wordResults.filter(Boolean),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`jp-reader listening on http://localhost:${PORT}`);
  console.log(`OCR engine: ${OCR_ENGINE || 'none (browser Tesseract.js fallback)'}`);
  console.log(`Translation: ${GOOGLE_API_KEY ? 'Google Translate enabled' : 'off (no Google key) — word definitions only'}`);
});
