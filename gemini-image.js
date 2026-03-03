require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ─── COOKIES (.env dosyasından okunur) ───────────────────────────────────────
const SAPISID   = process.env.SAPISID;
const COOKIE_STR = [
  `__Secure-1PSID=${process.env.PSID}`,
  `__Secure-1PSIDTS=${process.env.PSIDTS}`,
  `SAPISID=${SAPISID}`,
  `HSID=${process.env.HSID}`,
  `SSID=${process.env.SSID}`,
  `APISID=${process.env.APISID}`,
  `NID=${process.env.NID}`,
].join('; ');

// ─── SAPISID HASH ────────────────────────────────────────────────────────────
function sapisidHash() {
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1')
    .update(`${ts} ${SAPISID} https://gemini.google.com`)
    .digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

// ─── BASE HEADERS ────────────────────────────────────────────────────────────
const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  'Cookie': COOKIE_STR,
  'Origin': 'https://gemini.google.com',
  'Referer': 'https://gemini.google.com/',
  'x-same-domain': '1',
  'x-browser-channel': 'stable',
  'x-browser-year': '2026',
};

// ─── SESSION TOKENS ──────────────────────────────────────────────────────────
let sessionCache = null;

async function getSession() {
  if (sessionCache) return sessionCache;

  const res = await axios.get('https://gemini.google.com/app', {
    headers: BASE_HEADERS,
  });

  const html = res.data;
  const atToken = html.match(/"SNlM0e":"([^"]+)"/)?.[1];
  const fSid    = html.match(/"FdrFJe":"([^"]+)"/)?.[1];
  const bl      = html.match(/"cfb2h":"([^"]+)"/)?.[1];

  if (!atToken) throw new Error('SNlM0e (at token) bulunamadı — cookie\'leri kontrol et');

  sessionCache = { atToken, fSid, bl };
  setTimeout(() => { sessionCache = null; }, 5 * 60 * 1000); // 5dk cache
  return sessionCache;
}

// ─── f.req BUILDER ───────────────────────────────────────────────────────────
// Repodan öğrendiğimiz 69 elemanlı nested array formatı
function buildFReq(prompt, cid = '', rid = '', rcid = '') {
  const inner = [
    [prompt, 0, null, [], null, null, null],
    null,
    [[cid, rid, rcid]],
    null, null, null, null,
    1,          // snapshot streaming aktif
    null, null, null, null, null, null, null, null, null, null, null,
    null,       // gem_id
  ];
  return JSON.stringify([[['CF5n2b', JSON.stringify(inner), null, 'generic']]]);
}

// ─── RESPONSE PARSER ─────────────────────────────────────────────────────────
// Repodan: generated images → candidate[12][7][0], her biri [0][3][3] = URL
function parseStreamResponse(raw) {
  const result = { imageUrls: [], prompt: null, text: null, raw: [] };

  // Chunked format: )]}' + length + \n + json + \n
  const parts = raw.split(')]}\'').filter(Boolean);

  for (const part of parts) {
    // Her satırı parse etmeye çalış
    const lines = part.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      // Sayısal chunk-size satırlarını atla
      if (/^\d+$/.test(line)) continue;
      try {
        const frame = JSON.parse(line);
        if (!Array.isArray(frame)) continue;

        for (const item of frame) {
          if (!Array.isArray(item) || item[0] !== 'wrb.fr') continue;
          const payloadStr = item[2];
          if (!payloadStr) continue;

          let payload;
          try { payload = JSON.parse(payloadStr); } catch { continue; }

          // candidate listesi: payload[4][0] → candidate[12][7][0] = generated images
          const candidates = payload?.[4];
          if (!Array.isArray(candidates)) continue;

          for (const candidate of candidates) {
            // Text
            const text = candidate?.[1]?.[0];
            if (text && !result.text) result.text = text;

            // Generated images (Nano Banana / Imagen)
            const genImages = candidate?.[12]?.[7]?.[0];
            if (Array.isArray(genImages)) {
              for (const img of genImages) {
                const url = img?.[0]?.[3]?.[3];   // candidate[12][7][0][n][0][3][3]
                if (url && url.startsWith('http')) {
                  result.imageUrls.push(url + '=s2048'); // full resolution
                }
              }
            }

            // Expanded prompt (Gemini'nin oluşturduğu detaylı prompt)
            const expandedPrompt = candidate?.[12]?.[7]?.[0]?.[0]?.[20];
            if (expandedPrompt && !result.prompt) result.prompt = expandedPrompt;
          }
        }
      } catch { /* skip */ }
    }
  }

  return result;
}

// ─── IMAGE GENERATION ────────────────────────────────────────────────────────
async function generateImage(prompt) {
  const { atToken, fSid, bl } = await getSession();

  const fReq = buildFReq(prompt);

  const urlParams = new URLSearchParams({
    bl: bl || '',
    'f.sid': fSid || '',
    hl: 'tr',
    _reqid: String(Math.floor(Math.random() * 900000) + 100000),
    rt: 'c',
  });

  const body = new URLSearchParams({ 'f.req': fReq, at: atToken });

  const url = `https://gemini.google.com/_/BardChatUi/data/assistant.lambda.BardFrontendService/StreamGenerate?${urlParams}`;

  const res = await axios.post(url, body.toString(), {
    headers: {
      ...BASE_HEADERS,
      'Authorization': sapisidHash(),
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    responseType: 'text',
    timeout: 90000,
  });

  return parseStreamResponse(res.data);
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.post('/generate', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt gerekli' });

  try {
    console.log(`[generate] prompt: "${prompt}"`);
    const result = await generateImage(prompt);

    if (result.imageUrls.length === 0) {
      return res.status(500).json({
        error: 'Resim üretilemedi',
        text: result.text,
      });
    }

    console.log(`[generate] ${result.imageUrls.length} resim bulundu`);
    res.json({
      images: result.imageUrls,
      expandedPrompt: result.prompt,
      message: result.text,
    });
  } catch (err) {
    console.error('[generate] hata:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Session cache temizle (cookie değişince kullan)
app.post('/reset-session', (_req, res) => {
  sessionCache = null;
  res.json({ ok: true });
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(3000, () => {
  console.log('Gemini Image API → http://localhost:3000');
  console.log('');
  console.log('Kullanım:');
  console.log('  curl -X POST http://localhost:3000/generate \\');
  console.log('    -H "Content-Type: application/json" \\');
  console.log('    -d \'{"prompt": "bir muz resmi çiz"}\'');
});
