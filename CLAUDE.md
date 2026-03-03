# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A reverse-engineered Google Gemini API proxy built with Node.js/Express. It mimics browser requests to `gemini.google.com` using stolen session cookies to provide text generation, image generation, and SSE streaming via a local REST API.

## Commands

- `npm start` — Start the Express server (default port 3000)
- `npm install` — Install dependencies

No test framework or linter is configured.

## Architecture

Single-file application: `gemini-api.js` (745 lines). All logic lives in one file with numbered sections:

1. **Cookie & Auth** (lines 10-105) — Mutable cookie store, `COOKIE_RAW` env var support, SAPISIDHASH auth, auto cookie rotation every 540s via `accounts.google.com/RotateCookies`
2. **Session Tokens** (lines 107-160) — Extracts `atToken` (thykhd/SNlM0e), `fSid` (FdrFJe), `bl` (cfb2h) from `WIZ_global_data` in Gemini's HTML. 5-minute cache.
3. **Models** (lines 162-191) — Model selection via `x-goog-ext-525001261-jspb` header. Default: `gemini-3.0-flash`
4. **f.req Builder** (lines 233-253) — 69-element nested array format: `[null, JSON.stringify(innerReqList)]`
5. **Response Parser** (lines 255-442) — Anti-XSSI prefix strip (`)]}'`), line-based frame parsing, nested array extraction with `getNestedValue()` helper
6. **Core Functions** (lines 444-623) — `generate()` (non-streaming) and `generateStream()` (SSE)
7. **API Endpoints** (lines 625-725) — Express routes

## Key Technical Details

- **Endpoint URL**: `gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate` (note: `lamda` not `lambda`)
- **AT token**: Google replaced `SNlM0e` with `thykhd` in `WIZ_global_data`. Code tries both.
- **Cookie auth**: `COOKIE_RAW` env var (full browser cookie string) is required for image generation. Individual cookie env vars (PSID, SAPISID, etc.) only work for text.
- **Response format**: Length-prefixed frames, parsed line-by-line. `wrb.fr` frames contain the actual payloads.
- **Response paths**: text at `candidate[1][0]`, thoughts at `candidate[37][0][0]`, generated images at `candidate[12][7][0][n][0][3][3]`, web images at `candidate[12][1]`
- **Conversation tracking**: In-memory `Map` with 10-element metadata array `[cid, rid, rcid, ...]`
- **Request IDs**: 5-digit random, incremented by 100,000 per request

## .env

Requires `COOKIE_RAW` with full cookie string from browser DevTools (Copy as cURL from any gemini.google.com request). Cookies expire when user logs out or Google revokes the session; `__Secure-1PSIDTS` is auto-rotated.
