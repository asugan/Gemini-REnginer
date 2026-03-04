# Gemini Reverse-Engineered API

Node.js/Express API that uses Google Gemini's web interface. Supports text generation, image generation, and SSE streaming.

## Installation

```bash
npm install
```

## .env Configuration

Log into `gemini.google.com` in your browser, open DevTools (F12), right-click any request → **Copy as cURL** → copy the Cookie header value:

```
COOKIE_RAW=AEC=...; NID=...; SID=...; __Secure-1PSID=...; SAPISID=...; ...
```

## Running

```bash
npm start
```

Server starts at `http://localhost:3000`.

## API Endpoints

### POST /chat

Text generation. Supports SSE with `stream: true`.

```bash
# Basic
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello, how are you?"}'

# Model selection
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello", "model": "gemini-3.0-pro"}'

# Streaming (SSE)
curl -N -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello", "stream": true}'

# Continue conversation
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Continue", "conversationId": "uuid-from-previous-response"}'
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | User message |
| `model` | string | No | Model selection (default: `gemini-3.0-flash`) |
| `stream` | boolean | No | Enable SSE streaming |
| `conversationId` | string | No | Continue a conversation |
| `gemId` | string | No | Custom Gem ID |

**Response:**

```json
{
  "text": "Response text",
  "thoughts": "Model thinking process (for thinking model)",
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
  -d '{"prompt": "draw a banana"}'
```

**Response:**

```json
{
  "images": ["https://lh3.googleusercontent.com/...=s2048"],
  "expandedPrompt": "Detailed prompt",
  "message": "Text response"
}
```

### POST /reset-session

Resets session cache and conversations.

```bash
curl -X POST http://localhost:3000/reset-session
```

### GET /models

Lists available models.

```bash
curl http://localhost:3000/models
```

**Response:**

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

## Models

| Model | Description |
|-------|-------------|
| `gemini-3.0-flash` | Fast, default model |
| `gemini-3.0-pro` | More capable, slower |
| `gemini-3.0-flash-thinking` | Thinking process visible |
| `unspecified` | No model header sent |

## Cookie Renewal

Cookies are normally valid for weeks/months. The `__Secure-1PSIDTS` token is automatically refreshed every 540 seconds.

When cookies expire (500 errors):

1. Go to `gemini.google.com`
2. F12 → Network → any request → Copy as cURL
3. Paste the Cookie header value into `COOKIE_RAW` in `.env`
4. Restart the server

## Features

- Text generation and image generation
- SSE streaming support
- 4 model options
- Automatic cookie rotation (540s)
- In-memory conversation tracking (cid/rid/rcid)
- UTF-16 frame-based response parser
- Error code detection (USAGE_LIMIT, IP_BLOCKED, etc.)
