const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = 'captured_requests.json';
const captured = [];

function log(msg) {
  const time = new Date().toISOString().split('T')[1].slice(0, 8);
  console.log(`[${time}] ${msg}`);
}

function isTarget(url) {
  return url.includes('streamgenerate') || url.includes('batchexecute');
}

async function tryReadBody(response) {
  try {
    const buffer = await response.buffer();
    return buffer.toString('utf-8');
  } catch {
    return null;
  }
}

function parseChunkedResponse(raw) {
  if (!raw) return [];
  const chunks = [];
  const lines = raw.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Chunk size satırını atla (hex sayı)
    if (/^[0-9a-f]+$/i.test(line)) continue;
    if (line.startsWith(')]}\'\n') || line === ')]}\'' || line === '') continue;

    try {
      const parsed = JSON.parse(line);
      chunks.push(parsed);
    } catch {
      // Parse edilemeyen satırlar ham olarak ekle
      if (line.length > 2) chunks.push({ raw: line });
    }
  }
  return chunks;
}

function extractImageUrls(text) {
  if (!text) return [];
  const regex = /https:\/\/lh3\.googleusercontent\.com\/(?:gg-dl|rd-gg-dl)\/[A-Za-z0-9_\-]*/g;
  return [...new Set(text.match(regex) || [])];
}

function saveCapture(entry) {
  captured.push(entry);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(captured, null, 2), 'utf-8');
}

(async () => {
  log('Browser başlatılıyor...');

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });

  const page = await browser.newPage();

  // Request interceptor — body'yi yakalamak için
  const requestBodies = new Map();

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (isTarget(req.url())) {
      const entry = {
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        postData: req.postData() || null,
      };
      requestBodies.set(req.url() + Date.now(), entry);

      log(`>>> REQUEST: ${req.method()} ${req.url().split('?')[0].split('/').pop()}`);

      const postData = req.postData();
      if (postData) {
        try {
          const params = new URLSearchParams(postData);
          const fReq = params.get('f.req');
          if (fReq) {
            log(`    f.req: ${fReq.substring(0, 120)}...`);
          }
        } catch {}
      }
    }
    req.continue();
  });

  // Response interceptor
  page.on('response', async (response) => {
    const url = response.url();
    if (!isTarget(url)) return;

    const status = response.status();
    const type = url.includes('streamgenerate') ? 'streamgenerate' : 'batchexecute';

    log(`<<< RESPONSE [${status}]: ${type} — ${url.split('?')[0].split('/').pop()}`);

    const body = await tryReadBody(response);
    const imageUrls = extractImageUrls(body);
    const chunks = parseChunkedResponse(body);

    if (imageUrls.length > 0) {
      log(`    *** ${imageUrls.length} RESIM URL BULUNDU! ***`);
      imageUrls.forEach((u, i) => log(`    [${i + 1}] ${u}`));
    }

    // URL query parametrelerini parse et
    const urlParams = {};
    try {
      new URL(url).searchParams.forEach((v, k) => { urlParams[k] = v; });
    } catch {}

    // f.req'i request'ten al
    let fReq = null;
    for (const [key, req] of requestBodies.entries()) {
      if (req.url === url || url.startsWith(req.url.split('?')[0])) {
        if (req.postData) {
          try {
            fReq = new URLSearchParams(req.postData).get('f.req');
          } catch {}
        }
        requestBodies.delete(key);
        break;
      }
    }

    const entry = {
      timestamp: new Date().toISOString(),
      type,
      url,
      urlParams,
      status,
      fReq,
      imageUrls,
      chunks,
      rawBody: body,
    };

    saveCapture(entry);
    log(`    Kaydedildi → ${OUTPUT_FILE}`);
  });

  log('gemini.google.com açılıyor...');
  await page.goto('https://gemini.google.com/', { waitUntil: 'domcontentloaded' });

  log('');
  log('='.repeat(60));
  log('  Lütfen Google hesabınla giriş yap.');
  log('  Giriş yaptıktan sonra bir resim üret.');
  log('  Tüm istekler otomatik yakalanacak.');
  log('  Çıkmak için CTRL+C');
  log('='.repeat(60));
  log('');

  // Browser kapanana kadar bekle
  await new Promise((resolve) => {
    browser.on('disconnected', resolve);
    process.on('SIGINT', async () => {
      log('\nKapatılıyor...');
      log(`Toplam yakalanan istek: ${captured.length}`);
      log(`Kaydedilen dosya: ${path.resolve(OUTPUT_FILE)}`);

      const allImages = captured.flatMap(c => c.imageUrls || []);
      if (allImages.length > 0) {
        log('\nBulunan tüm resim URL\'leri:');
        allImages.forEach((u, i) => log(`  [${i + 1}] ${u}`));
      }

      await browser.close();
      resolve();
    });
  });
})();
