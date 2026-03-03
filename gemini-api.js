require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════════
// 1. COOKIE & AUTH YONETIMI
// ═══════════════════════════════════════════════════════════════════════════════

// Mutable cookie store (rotation destegi icin)
const cookies = {
  '__Secure-1PSID': process.env.PSID,
  '__Secure-1PSIDTS': process.env.PSIDTS,
  'SAPISID': process.env.SAPISID,
  'HSID': process.env.HSID,
  'SSID': process.env.SSID,
  'APISID': process.env.APISID,
  'NID': process.env.NID,
};

function buildCookieString() {
  return Object.entries(cookies)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function sapisidHash() {
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1')
    .update(`${ts} ${cookies.SAPISID} https://gemini.google.com`)
    .digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

function buildBaseHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    'Cookie': buildCookieString(),
    'Origin': 'https://gemini.google.com',
    'Referer': 'https://gemini.google.com/',
    'X-Same-Domain': '1',
    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
  };
}

// Cookie rotation (540sn aralikla)
let rotationInterval = null;

async function rotateCookies() {
  try {
    const res = await axios.post(
      'https://accounts.google.com/RotateCookies',
      '[000,"-0000000000000000000"]',
      {
        headers: {
          'Content-Type': 'application/json',
          'Cookie': buildCookieString(),
        },
        timeout: 15000,
      }
    );

    const setCookieHeaders = res.headers['set-cookie'];
    if (setCookieHeaders) {
      const raw = Array.isArray(setCookieHeaders) ? setCookieHeaders.join('; ') : setCookieHeaders;
      const match = raw.match(/__Secure-1PSIDTS=([^;]+)/);
      if (match) {
        cookies['__Secure-1PSIDTS'] = match[1];
        sessionCache = null; // Session'i invalidate et
        console.log('[rotate] PSIDTS yenilendi');
      }
    }
  } catch (err) {
    console.error('[rotate] hata:', err.message);
  }
}

function startRotation() {
  if (rotationInterval) return;
  rotationInterval = setInterval(rotateCookies, 540 * 1000);
  console.log('[rotate] 540sn aralikla cookie rotation aktif');
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. SESSION TOKEN EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

let sessionCache = null;

async function getSession() {
  if (sessionCache) return sessionCache;

  const res = await axios.get('https://gemini.google.com/app', {
    headers: buildBaseHeaders(),
    timeout: 30000,
  });

  const html = res.data;
  const atToken = html.match(/"SNlM0e":"([^"]+)"/)?.[1];
  const fSid = html.match(/"FdrFJe":"([^"]+)"/)?.[1];
  const bl = html.match(/"cfb2h":"([^"]+)"/)?.[1];

  if (!atToken) throw new Error('SNlM0e (at token) bulunamadi — cookie\'leri kontrol et');

  sessionCache = { atToken, fSid, bl };
  setTimeout(() => { sessionCache = null; }, 5 * 60 * 1000); // 5dk cache
  return sessionCache;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. MODEL DESTEGI
// ═══════════════════════════════════════════════════════════════════════════════

const MODELS = {
  'unspecified': {
    name: 'unspecified',
    header: {},
  },
  'gemini-3.0-pro': {
    name: 'gemini-3.0-pro',
    header: {
      'x-goog-ext-525001261-jspb': '[1,null,null,null,"9d8ca3786ebdfbea",null,null,0,[4],null,null,1]',
    },
  },
  'gemini-3.0-flash': {
    name: 'gemini-3.0-flash',
    header: {
      'x-goog-ext-525001261-jspb': '[1,null,null,null,"fbb127bbb056c959",null,null,0,[4],null,null,1]',
    },
  },
  'gemini-3.0-flash-thinking': {
    name: 'gemini-3.0-flash-thinking',
    header: {
      'x-goog-ext-525001261-jspb': '[1,null,null,null,"5bf011840784117a",null,null,0,[4],null,null,1]',
    },
  },
};

const DEFAULT_MODEL = 'gemini-3.0-flash';

// ═══════════════════════════════════════════════════════════════════════════════
// 4. REQUEST ID YONETIMI
// ═══════════════════════════════════════════════════════════════════════════════

let _reqid = Math.floor(Math.random() * 90000) + 10000;

function nextReqId(isNewConversation = true) {
  if (isNewConversation) {
    _reqid = Math.floor(Math.random() * 90000) + 10000;
  }
  const id = _reqid;
  _reqid += 100000;
  return id;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. CONVERSATION STORE
// ═══════════════════════════════════════════════════════════════════════════════

const conversations = new Map();

function getOrCreateConversation(conversationId) {
  if (!conversationId) conversationId = crypto.randomUUID();
  if (!conversations.has(conversationId)) {
    conversations.set(conversationId, {
      metadata: ['', '', '', null, null, null, null, null, null, ''],
      history: [],
    });
  }
  return { id: conversationId, chat: conversations.get(conversationId) };
}

function mergeMetadata(existing, incoming) {
  const merged = [...existing];
  for (let i = 0; i < Math.min(incoming.length, 10); i++) {
    if (incoming[i] != null) merged[i] = incoming[i];
  }
  return merged;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. f.req BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

function buildFReq(prompt, metadata, gemId) {
  const innerReqList = new Array(69).fill(null);

  // [0] = prompt content
  innerReqList[0] = [prompt, 0, null, null, null, null, 0];

  // [2] = chat metadata
  innerReqList[2] = metadata || ['', '', '', null, null, null, null, null, null, ''];

  // [7] = snapshot streaming aktif
  innerReqList[7] = 1;

  // [19] = gem_id (opsiyonel)
  if (gemId) innerReqList[19] = gemId;

  return JSON.stringify([null, JSON.stringify(innerReqList)]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. RESPONSE PARSER (UTF-16 Frame-Based)
// ═══════════════════════════════════════════════════════════════════════════════

const ERROR_CODES = {
  1013: 'TEMPORARY_ERROR',
  1037: 'USAGE_LIMIT_EXCEEDED',
  1050: 'MODEL_INCONSISTENT',
  1052: 'MODEL_HEADER_INVALID',
  1060: 'IP_TEMPORARILY_BLOCKED',
};

function getNestedValue(data, path, defaultVal = null) {
  let current = data;
  for (const key of path) {
    if (current == null) return defaultVal;
    if (typeof key === 'number' && Array.isArray(current) && key >= 0 && key < current.length) {
      current = current[key];
    } else if (typeof key === 'string' && typeof current === 'object' && key in current) {
      current = current[key];
    } else {
      return defaultVal;
    }
  }
  return current ?? defaultVal;
}

function parseResponseByFrame(content) {
  const frames = [];
  let pos = 0;
  const lengthPattern = /(\d+)\n/g;

  while (pos < content.length) {
    // Skip whitespace
    while (pos < content.length && /\s/.test(content[pos])) pos++;
    if (pos >= content.length) break;

    lengthPattern.lastIndex = pos;
    const match = lengthPattern.exec(content);
    if (!match || match.index !== pos) break;

    const lengthVal = match[1];
    const utf16Length = parseInt(lengthVal, 10);
    const startContent = match.index + lengthVal.length + 1; // +1 for \n

    // UTF-16 code units -> JS char count
    let charCount = 0;
    let unitsFound = 0;
    for (let i = startContent; i < content.length && unitsFound < utf16Length; i++) {
      const code = content.charCodeAt(i);
      const units = code > 0xFFFF ? 2 : 1;
      if (unitsFound + units > utf16Length) break;
      unitsFound += units;
      charCount++;
    }

    if (unitsFound < utf16Length) break; // Incomplete frame

    const endPos = startContent + charCount;
    const chunk = content.slice(startContent, endPos).trim();
    pos = endPos;

    if (!chunk) continue;

    try {
      const parsed = JSON.parse(chunk);
      if (Array.isArray(parsed)) {
        frames.push(...parsed);
      } else {
        frames.push(parsed);
      }
    } catch { /* skip unparseable */ }
  }

  return { frames, remaining: content.slice(pos) };
}

function checkErrorCode(part) {
  const errorCode = getNestedValue(part, [5, 2, 0, 1, 0]);
  if (!errorCode) return null;
  const code = parseInt(errorCode, 10);
  if (isNaN(code)) return null;
  return {
    code,
    name: ERROR_CODES[code] || 'UNKNOWN',
  };
}

function extractFromFrames(frames) {
  const result = {
    text: null,
    thoughts: null,
    generatedImages: [],
    webImages: [],
    expandedPrompt: null,
    metadata: null,
    context: null,
    rcid: null,
    isFinal: false,
    error: null,
  };

  for (const frame of frames) {
    if (!Array.isArray(frame)) continue;

    // wrb.fr frames
    if (frame[0] === 'wrb.fr') {
      const payloadStr = frame[2];
      if (!payloadStr) continue;

      let partJson;
      try { partJson = JSON.parse(payloadStr); } catch { continue; }

      // Error check
      const err = checkErrorCode(partJson);
      if (err) {
        result.error = err;
        continue;
      }

      // Metadata: partJson[1]
      const meta = getNestedValue(partJson, [1]);
      if (Array.isArray(meta) && meta.length > 0) {
        result.metadata = meta;
      }

      // Context: partJson[25]
      const ctx = getNestedValue(partJson, [25]);
      if (ctx) result.context = ctx;

      // Candidates: partJson[4]
      const candidates = getNestedValue(partJson, [4]);
      if (!Array.isArray(candidates)) continue;

      for (const candidate of candidates) {
        if (!Array.isArray(candidate)) continue;

        // rcid: candidate[0]
        const candidateRcid = getNestedValue(candidate, [0]);
        if (candidateRcid && !result.rcid) result.rcid = candidateRcid;

        // Text: candidate[1][0]
        const text = getNestedValue(candidate, [1, 0]);
        if (text) result.text = text;

        // Thoughts: candidate[37][0][0]
        const thoughts = getNestedValue(candidate, [37, 0, 0]);
        if (thoughts) result.thoughts = thoughts;

        // Completion: candidate[2] exists or candidate[8][0] === 2
        if (getNestedValue(candidate, [2]) != null || getNestedValue(candidate, [8, 0]) === 2) {
          result.isFinal = true;
        }

        // Generated images: candidate[12][7][0]
        const genImages = getNestedValue(candidate, [12, 7, 0]);
        if (Array.isArray(genImages)) {
          for (const img of genImages) {
            const url = getNestedValue(img, [0, 3, 3]);
            if (url && url.startsWith('http')) {
              result.generatedImages.push({
                url: url + '=s2048',
                alt: getNestedValue(img, [3, 5, 0]) || '',
              });
            }
          }
          // Expanded prompt
          const ep = getNestedValue(genImages, [0, 20]);
          if (ep) result.expandedPrompt = ep;
        }

        // Web images: candidate[12][1]
        const webImgs = getNestedValue(candidate, [12, 1]);
        if (Array.isArray(webImgs)) {
          for (const wi of webImgs) {
            const url = getNestedValue(wi, [0, 0, 0]);
            if (url && url.startsWith('http')) {
              result.webImages.push({
                url,
                title: getNestedValue(wi, [7, 0]) || '',
                alt: getNestedValue(wi, [0, 4]) || '',
              });
            }
          }
        }
      }
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. CORE: GENERATE (non-streaming)
// ═══════════════════════════════════════════════════════════════════════════════

async function generate(prompt, options = {}) {
  const { model = DEFAULT_MODEL, conversationId, gemId } = options;

  const session = await getSession();
  const modelConfig = MODELS[model] || MODELS[DEFAULT_MODEL];

  // Conversation tracking
  const { id: convId, chat } = conversationId
    ? getOrCreateConversation(conversationId)
    : { id: null, chat: null };

  const metadata = chat ? chat.metadata : undefined;
  const isNew = !chat || !metadata[0]; // cid bos ise yeni
  const reqid = nextReqId(isNew);

  const fReq = buildFReq(prompt, metadata, gemId);

  const params = new URLSearchParams({
    _reqid: String(reqid),
    rt: 'c',
    bl: session.bl || '',
    'f.sid': session.fSid || '',
  });

  const body = new URLSearchParams({
    'at': session.atToken,
    'f.req': fReq,
  });

  const url = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${params}`;

  const res = await axios.post(url, body.toString(), {
    headers: {
      ...buildBaseHeaders(),
      'Authorization': sapisidHash(),
      ...modelConfig.header,
    },
    responseType: 'text',
    timeout: 90000,
  });

  const { frames } = parseResponseByFrame(res.data);
  const parsed = extractFromFrames(frames);

  // Conversation metadata guncelle
  if (chat && parsed.metadata?.length) {
    chat.metadata = mergeMetadata(chat.metadata, parsed.metadata);
  }
  if (chat && parsed.context) {
    chat.metadata[9] = parsed.context;
  }
  if (chat && parsed.rcid) {
    chat.metadata[2] = parsed.rcid;
  }
  if (chat && prompt) {
    chat.history.push({ role: 'user', content: prompt });
    if (parsed.text) chat.history.push({ role: 'model', content: parsed.text });
  }

  return { ...parsed, conversationId: convId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. CORE: GENERATE STREAMING (SSE)
// ═══════════════════════════════════════════════════════════════════════════════

async function generateStream(prompt, res, options = {}) {
  const { model = DEFAULT_MODEL, conversationId, gemId } = options;

  const session = await getSession();
  const modelConfig = MODELS[model] || MODELS[DEFAULT_MODEL];

  const { id: convId, chat } = conversationId
    ? getOrCreateConversation(conversationId)
    : { id: null, chat: null };

  const metadata = chat ? chat.metadata : undefined;
  const isNew = !chat || !metadata[0];
  const reqid = nextReqId(isNew);

  const fReq = buildFReq(prompt, metadata, gemId);

  const params = new URLSearchParams({
    _reqid: String(reqid),
    rt: 'c',
    bl: session.bl || '',
    'f.sid': session.fSid || '',
  });

  const body = new URLSearchParams({
    'at': session.atToken,
    'f.req': fReq,
  });

  const url = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${params}`;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (convId) res.setHeader('X-Conversation-Id', convId);

  let lastText = '';
  let buffer = '';
  let finalParsed = null;

  try {
    const axiosRes = await axios.post(url, body.toString(), {
      headers: {
        ...buildBaseHeaders(),
        'Authorization': sapisidHash(),
        ...modelConfig.header,
      },
      responseType: 'stream',
      timeout: 90000,
    });

    await new Promise((resolve, reject) => {
      axiosRes.data.on('data', (chunk) => {
        buffer += chunk.toString();

        const { frames, remaining } = parseResponseByFrame(buffer);
        buffer = remaining;

        if (frames.length === 0) return;

        const parsed = extractFromFrames(frames);
        finalParsed = parsed;

        if (parsed.error) {
          res.write(`data: ${JSON.stringify({ error: parsed.error })}\n\n`);
          return;
        }

        const delta = parsed.text && parsed.text.length > lastText.length
          ? parsed.text.slice(lastText.length)
          : null;

        if (delta || parsed.thoughts || parsed.generatedImages.length || parsed.webImages.length) {
          res.write(`data: ${JSON.stringify({
            text: parsed.text,
            delta,
            thoughts: parsed.thoughts,
            images: parsed.generatedImages,
            webImages: parsed.webImages,
            isFinal: parsed.isFinal,
            conversationId: convId,
            metadata: { rcid: parsed.rcid },
          })}\n\n`);
        }

        if (parsed.text) lastText = parsed.text;
      });

      axiosRes.data.on('end', resolve);
      axiosRes.data.on('error', reject);
    });

    // Conversation metadata guncelle
    if (chat && finalParsed) {
      if (finalParsed.metadata?.length) {
        chat.metadata = mergeMetadata(chat.metadata, finalParsed.metadata);
      }
      if (finalParsed.context) chat.metadata[9] = finalParsed.context;
      if (finalParsed.rcid) chat.metadata[2] = finalParsed.rcid;
      chat.history.push({ role: 'user', content: prompt });
      if (finalParsed.text) chat.history.push({ role: 'model', content: finalParsed.text });
    }

    res.write('data: [DONE]\n\n');
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    res.end();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 10. API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /chat — Text generation (stream: true ile SSE destegi)
app.post('/chat', async (req, res) => {
  const { prompt, model, conversationId, gemId } = req.body;
  const stream = req.body.stream === true || req.query.stream === 'true';

  if (!prompt) return res.status(400).json({ error: 'prompt gerekli' });

  const modelName = model || DEFAULT_MODEL;
  if (model && !MODELS[model]) {
    return res.status(400).json({ error: `Gecersiz model: ${model}`, models: Object.keys(MODELS) });
  }

  console.log(`[chat] prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}" | model: ${modelName} | stream: ${stream}`);

  if (stream) {
    return generateStream(prompt, res, { model: modelName, conversationId, gemId });
  }

  try {
    const result = await generate(prompt, { model: modelName, conversationId, gemId });

    if (result.error) {
      return res.status(500).json({
        error: `Gemini hatasi: ${result.error.name} (${result.error.code})`,
        code: result.error.code,
      });
    }

    res.json({
      text: result.text,
      thoughts: result.thoughts,
      images: result.generatedImages,
      webImages: result.webImages,
      expandedPrompt: result.expandedPrompt,
      conversationId: result.conversationId,
    });
  } catch (err) {
    console.error('[chat] hata:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /generate-image — Image generation (eski API ile uyumlu)
app.post('/generate-image', async (req, res) => {
  const { prompt, model } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt gerekli' });

  const modelName = model || DEFAULT_MODEL;
  console.log(`[generate-image] prompt: "${prompt}"`);

  try {
    const result = await generate(prompt, { model: modelName });

    if (result.error) {
      return res.status(500).json({
        error: `Gemini hatasi: ${result.error.name} (${result.error.code})`,
        code: result.error.code,
      });
    }

    if (result.generatedImages.length === 0) {
      return res.status(500).json({
        error: 'Resim uretilemedi',
        text: result.text,
      });
    }

    console.log(`[generate-image] ${result.generatedImages.length} resim bulundu`);
    res.json({
      images: result.generatedImages.map(img => img.url),
      expandedPrompt: result.expandedPrompt,
      message: result.text,
    });
  } catch (err) {
    console.error('[generate-image] hata:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /reset-session — Session cache ve conversation temizle
app.post('/reset-session', (_req, res) => {
  sessionCache = null;
  conversations.clear();
  _reqid = Math.floor(Math.random() * 90000) + 10000;
  console.log('[reset] session, conversations ve reqid sifirlandi');
  res.json({ ok: true });
});

// GET /models — Mevcut modelleri listele
app.get('/models', (_req, res) => {
  const models = Object.entries(MODELS).map(([key, val]) => ({
    id: key,
    name: val.name,
    isDefault: key === DEFAULT_MODEL,
  }));
  res.json({ models, default: DEFAULT_MODEL });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. START
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  startRotation();
  console.log(`Gemini API → http://localhost:${PORT}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  POST /chat              — Text generation (stream: true ile SSE)`);
  console.log(`  POST /generate-image    — Image generation`);
  console.log(`  POST /reset-session     — Session sifirla`);
  console.log(`  GET  /models            — Model listesi`);
  console.log('');
  console.log(`Varsayilan model: ${DEFAULT_MODEL}`);
});
