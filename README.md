# Gemini Reverse-Engineered API

Google Gemini'nin web arayuzunu kullanan Node.js/Express API. Text generation, image generation ve SSE streaming destekler.

## Kurulum

```bash
npm install
```

## .env Ayarlari

Tarayicidan `gemini.google.com`'a giris yap, DevTools (F12) ac, herhangi bir request'e sag tikla → **Copy as cURL** → Cookie header degerini kopyala:

```
COOKIE_RAW=AEC=...; NID=...; SID=...; __Secure-1PSID=...; SAPISID=...; ...
```

## Calistirma

```bash
npm start
```

Sunucu `http://localhost:3000` adresinde baslar.

## API Endpoints

### POST /chat

Text generation. `stream: true` ile SSE destegi.

```bash
# Normal
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Merhaba, nasilsin?"}'

# Model secimi
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Merhaba", "model": "gemini-3.0-pro"}'

# Streaming (SSE)
curl -N -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Merhaba", "stream": true}'

# Conversation devami
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Devam et", "conversationId": "uuid-from-previous-response"}'
```

**Parametreler:**

| Parametre | Tip | Zorunlu | Aciklama |
|-----------|-----|---------|----------|
| `prompt` | string | Evet | Kullanici mesaji |
| `model` | string | Hayir | Model secimi (varsayilan: `gemini-3.0-flash`) |
| `stream` | boolean | Hayir | SSE streaming aktif |
| `conversationId` | string | Hayir | Konusma devam ettirme |
| `gemId` | string | Hayir | Ozel Gem ID |

**Yanit:**

```json
{
  "text": "Yanit metni",
  "thoughts": "Model dusunce sureci (thinking modeli icin)",
  "images": [],
  "webImages": [],
  "expandedPrompt": null,
  "conversationId": null
}
```

### POST /generate-image

Image generation.

```bash
curl -X POST http://localhost:3000/generate-image \
  -H "Content-Type: application/json" \
  -d '{"prompt": "bir muz resmi ciz"}'
```

**Yanit:**

```json
{
  "images": ["https://lh3.googleusercontent.com/...=s2048"],
  "expandedPrompt": "Detayli prompt",
  "message": "Text yaniti"
}
```

### POST /reset-session

Session cache ve konusmalari sifirlar.

```bash
curl -X POST http://localhost:3000/reset-session
```

### GET /models

Mevcut modelleri listeler.

```bash
curl http://localhost:3000/models
```

**Yanit:**

```json
{
  "models": [
    { "id": "gemini-3.0-flash", "name": "gemini-3.0-flash", "isDefault": true },
    { "id": "gemini-3.0-pro", "name": "gemini-3.0-pro", "isDefault": false },
    { "id": "gemini-3.0-flash-thinking", "name": "gemini-3.0-flash-thinking", "isDefault": false },
    { "id": "unspecified", "name": "unspecified", "isDefault": false }
  ],
  "default": "gemini-3.0-flash"
}
```

## Modeller

| Model | Aciklama |
|-------|----------|
| `gemini-3.0-flash` | Hizli, varsayilan model |
| `gemini-3.0-pro` | Daha yetenekli, yavas |
| `gemini-3.0-flash-thinking` | Dusunce sureci gorunur |
| `unspecified` | Model header'i gonderilmez |

## Cookie Yenileme

Cookie'ler normal sartlarda haftalarca/aylarca gecerlidir. `__Secure-1PSIDTS` tokeni 540sn aralikla otomatik yenilenir.

Cookie'ler expire oldugunda (500 hatasi alindiginda):

1. `gemini.google.com`'a git
2. F12 → Network → herhangi bir request → Copy as cURL
3. Cookie header degerini `.env`'deki `COOKIE_RAW`'a yapistir
4. Sunucuyu yeniden baslat

## Ozellikler

- Text generation ve image generation
- SSE streaming destegi
- 4 model secenegi
- Otomatik cookie rotation (540sn)
- In-memory conversation tracking (cid/rid/rcid)
- UTF-16 frame-based response parser
- Hata kodu algilama (USAGE_LIMIT, IP_BLOCKED vb.)
