# Stash Backend — Complete Flow Documentation

> Reference guide for connecting the **web app**, **mobile app**, and **backend** together — locally and in production.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENTS                                  │
│                                                                 │
│   build-it-ready  (React/Vite)    stash-expo  (React Native)   │
│   runs on :8080                   runs on Expo Go / device     │
└──────────────────────┬──────────────────────┬───────────────────┘
                       │  HTTP REST            │  HTTP REST
                       ▼                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                   stash-backend  (Node/Express)                 │
│                   runs on :4000                                 │
│                                                                 │
│   POST /api/instagram/preview                                   │
│   GET  /api/instagram/download                                  │
│   GET  /api/instagram/stream                                    │
│   POST /api/youtube/preview                                     │
│   GET  /api/youtube/download                                    │
│   GET  /api/youtube/stream                                      │
│   GET  /health                                                  │
└──────────────────────┬──────────────────────────────────────────┘
                       │  HTTPS (RapidAPI key hidden server-side)
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RAPIDAPI                                   │
│                                                                 │
│   instagram120.p.rapidapi.com  → Instagram media URLs          │
│   yt-api.p.rapidapi.com        → YouTube media URLs            │
└─────────────────────────────────────────────────────────────────┘
```

**Why a backend proxy?**
- Keeps the RapidAPI key off the client (never exposed in JS bundles or APK)
- Bypasses CORS restrictions on Instagram/YouTube CDN URLs
- Strips `&dl=1` from Instagram CDN URLs so videos stream inline
- Forwards `Range` headers so video players can seek

---

## 2. Folder Structure

```
Stash/
├── stash-backend/          ← shared backend (Node/Express/TypeScript)
│   ├── src/
│   │   ├── index.ts        ← Express app, CORS, routes mount
│   │   ├── types.ts        ← shared interfaces (MediaItem, PreviewResult, etc.)
│   │   └── routes/
│   │       ├── instagram.ts  ← /api/instagram/*
│   │       └── youtube.ts    ← /api/youtube/*
│   ├── .env                ← secret keys (NEVER commit)
│   ├── .env.example        ← template to copy
│   └── package.json
│
├── build-it-ready/         ← web app (React/Vite)
│   ├── src/sake/services/
│   │   └── downloader.ts   ← calls backend, typed responses
│   └── .env.local          ← VITE_BACKEND_URL=http://localhost:4000
│
└── stash-expo/             ← mobile app (React Native/Expo)
    └── src/
        ├── screens/
        │   ├── InstagramScreen.tsx
        │   └── YouTubeScreen.tsx
        └── (needs) services/downloader.ts  ← same pattern as web
```

---

## 3. Environment Variables

### `stash-backend/.env`
```env
# Your RapidAPI key — subscribe to both APIs below (free plans)
RAPIDAPI_KEY=your_rapidapi_key_here

# Port the backend listens on
PORT=4000

# Comma-separated allowed CORS origins
# Dev: include localhost ports for web + Expo
# Prod: add your deployed web app domain
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000,http://localhost:8080,http://localhost:8081,exp://localhost:8081
```

> **CORS Note:** The backend auto-allows any `localhost:*` and `exp://` origin. In production, only origins in `ALLOWED_ORIGINS` are permitted.

### `build-it-ready/.env.local`
```env
VITE_BACKEND_URL=http://localhost:4000
# Prod: VITE_BACKEND_URL=https://your-backend.railway.app
```

### `stash-expo/.env`
```env
# Dev: your machine's local IP (NOT localhost — device can't reach it)
EXPO_PUBLIC_BACKEND_URL=http://192.168.x.x:4000
# Prod: EXPO_PUBLIC_BACKEND_URL=https://your-backend.railway.app
```

> **Mobile dev tip:** Find your PC's IP with `ipconfig` → IPv4 Address (e.g. `192.168.1.42`).

---

## 4. RapidAPI Subscriptions Required

| Service | Plan | Used for |
|---|---|---|
| `instagram120` (mrngstar) | Free | Instagram reels/posts |
| `yt-api` (ytjar) | Free | YouTube videos/shorts |

Both use the same `RAPIDAPI_KEY`. Subscribe once, key works for both.

---

## 5. Complete API Reference

### `GET /health`
```json
{ "status": "ok", "version": "1.0.0", "timestamp": "..." }
```

---

### `POST /api/instagram/preview`
**Request:** `{ "url": "https://www.instagram.com/reel/ABC123xyz/" }`

**Flow:**
1. Extracts shortcode (`/reel/ABC123xyz/` → `ABC123xyz`)
2. Calls `POST instagram120.p.rapidapi.com/api/instagram/mediaByShortcode` with `{ shortcode }`
3. Maps to `PreviewResult`

**Response:**
```json
{
  "platform": "instagram",
  "author": "username",
  "title": "Caption text here...",
  "thumbnail": "",
  "items": [
    {
      "id": "ABC123xyz",
      "type": "video",
      "thumbnail": "",
      "downloadUrl": "https://scontent.cdninstagram.com/...&dl=1",
      "title": "First line of caption",
      "duration": "0:35"
    }
  ]
}
```

**Notes:**
- `thumbnail` is often empty — API doesn't reliably return thumbnails
- Carousel posts return multiple `items` (one per slide)
- `downloadUrl` ends with `&dl=1` — use `/stream` for preview, `/download` for saving

| Status | Meaning |
|---|---|
| `400` | Missing `url` or invalid Instagram link |
| `404` | Post not found or private |
| `502` | RapidAPI error (check key + subscription) |

---

### `GET /api/instagram/download?url=<cdnUrl>&filename=<name>`
Proxies the Instagram CDN file with `Content-Disposition: attachment`.

**Web:** Used by `triggerBrowserDownload()` to save file to Downloads folder.
**Mobile:** Do NOT use. Use `/stream` + `expo-file-system` instead.

---

### `GET /api/instagram/stream?url=<cdnUrl>`
Proxies Instagram CDN video for **inline playback**.

- Strips `&dl=1` so CDN streams instead of downloads
- Forwards `Range` headers for seeking
- Returns `206 Partial Content` for range requests
- No `Content-Disposition` header

**Web:** `<video src="http://localhost:4000/api/instagram/stream?url=...">`
**Mobile:** `<Video source={{ uri: 'https://your-backend/api/instagram/stream?url=...' }}>`

---

### `POST /api/youtube/preview`
**Request:** `{ "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }`

**Flow:**
1. Extracts video ID
2. Calls `GET yt-api.p.rapidapi.com/dl?id=<videoId>&cgeo=US`
3. Maps adaptive formats to quality list

**Response:**
```json
{
  "platform": "youtube",
  "author": "Channel Name",
  "title": "Video Title",
  "thumbnail": "https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
  "items": [
    {
      "id": "dQw4w9WgXcQ",
      "type": "video",
      "thumbnail": "https://...",
      "downloadUrl": "https://redirector.googlevideo.com/...",
      "title": "Video Title",
      "duration": "3:33"
    }
  ],
  "qualities": [
    { "label": "1080p", "itag": 137, "downloadUrl": "https://..." },
    { "label": "720p",  "itag": 136, "downloadUrl": "https://..." },
    { "label": "480p",  "itag": 135, "downloadUrl": "https://..." },
    { "label": "360p",  "itag": 134, "downloadUrl": "https://..." }
  ]
}
```

**Notes:**
- `thumbnail` is always available (YouTube CDN)
- YouTube signed URLs expire in ~6 hours — never cache them
- `qualities` are video-only adaptive streams (no audio track)
- `items[0].downloadUrl` is a muxed (video+audio) stream — best for download

---

### `GET /api/youtube/download?url=<googlevideoUrl>&filename=<name>`
Proxies YouTube video as forced download with Chrome User-Agent (bypasses bot detection).

---

### `GET /api/youtube/stream?url=<googlevideoUrl>`
Same as Instagram stream — proxies for inline playback with Range support.

---

## 6. Shared TypeScript Types

Defined in `stash-backend/src/types.ts`. Keep in sync with web and mobile service files.

```typescript
interface MediaItem {
  id: string;
  type: "video" | "image";
  thumbnail: string;      // may be empty for Instagram
  downloadUrl: string;    // raw CDN URL — use /stream or /download proxy
  title: string;
  sizeMb?: number;
  duration?: string;      // "3:33" format
}

interface YoutubeQuality {
  label: string;          // "1080p", "720p", etc.
  itag: number;
  downloadUrl: string;
}

interface PreviewResult {
  platform: "instagram" | "youtube";
  author: string;
  title: string;
  thumbnail: string;
  items: MediaItem[];
  qualities?: YoutubeQuality[];   // YouTube only
}
```

---

## 7. Mobile App Integration (stash-expo)

### `src/services/api.ts`
```typescript
const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL ?? "http://192.168.x.x:4000";

export async function fetchInstagramPreview(url: string): Promise<PreviewResult> {
  const res = await fetch(`${BACKEND}/api/instagram/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `Server error ${res.status}`);
  return json;
}

export async function fetchYoutubePreview(url: string): Promise<PreviewResult> {
  const res = await fetch(`${BACKEND}/api/youtube/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `Server error ${res.status}`);
  return json;
}

/** Build stream URL for inline playback via backend proxy */
export function toStreamUrl(rawUrl: string, platform: "instagram" | "youtube"): string {
  return `${BACKEND}/api/${platform}/stream?url=${encodeURIComponent(rawUrl)}`;
}
```

### Download to Gallery
```typescript
import * as FileSystem from "expo-file-system";
import * as MediaLibrary from "expo-media-library";

async function downloadToGallery(
  downloadUrl: string,
  platform: "instagram" | "youtube"
) {
  const streamUrl = toStreamUrl(downloadUrl, platform);
  const filename = `stash_${platform}_${Date.now()}.mp4`;
  const localUri = FileSystem.documentDirectory + filename;

  const { uri } = await FileSystem.downloadAsync(streamUrl, localUri);

  const { status } = await MediaLibrary.requestPermissionsAsync();
  if (status !== "granted") throw new Error("Gallery permission denied");
  await MediaLibrary.saveToLibraryAsync(uri);
}
```

### Video Preview
```tsx
import { Video } from "expo-av";

<Video
  source={{ uri: toStreamUrl(item.downloadUrl, "instagram") }}
  useNativeControls
  resizeMode="contain"
  style={{ width: "100%", aspectRatio: 9 / 16 }}
/>
```

### Required Packages
```bash
npx expo install expo-file-system expo-media-library expo-av
```

### `app.json` Permissions
```json
{
  "expo": {
    "plugins": [
      ["expo-media-library", {
        "photosPermission": "Allow Stash to save videos to your gallery.",
        "savePhotosPermission": "Allow Stash to save videos to your gallery.",
        "isAccessMediaLocationEnabled": true
      }]
    ]
  }
}
```

---

## 8. Running Locally

```bash
# Terminal 1 — Backend
cd stash-backend
npm install
npm run dev
# → 🚀 http://localhost:4000

# Terminal 2 — Web app
cd build-it-ready
npm install
npm run dev
# → http://localhost:8080

# Terminal 3 — Mobile
cd stash-expo
npx expo start --dev-client
```

---

## 9. Deploying to Railway

```bash
# 1. Create a GitHub repo for stash-backend (or push as subfolder)
# 2. Go to railway.app → New Project → Deploy from GitHub
# 3. Select the stash-backend repo
# 4. Add environment variables in Railway dashboard:
#      RAPIDAPI_KEY = <your key>
#      PORT         = 4000
#      ALLOWED_ORIGINS = https://your-web-app.vercel.app

# Railway runs automatically:
#   npm run build  → compiles TypeScript to dist/
#   npm start      → node dist/index.js

# 5. Copy the Railway URL (e.g. https://stash-backend.railway.app)
# 6. Update web app:  VITE_BACKEND_URL=https://stash-backend.railway.app
# 7. Update mobile:   EXPO_PUBLIC_BACKEND_URL=https://stash-backend.railway.app
# 8. Rebuild EAS:     eas build --platform android --profile production
```

---

## 10. Pre-Deployment Checklist

- [ ] `RAPIDAPI_KEY` set in backend env
- [ ] Both RapidAPI subscriptions active: `instagram120` + `yt-api`
- [ ] `npm run build` succeeds (`tsc` compiles without errors)
- [ ] `package.json` `"start"` uses `node dist/index.js` (not ts-node)
- [ ] `tsconfig.json` has `"outDir": "dist"` and `"module": "commonjs"`
- [ ] `ALLOWED_ORIGINS` includes production web app URL
- [ ] Web app `VITE_BACKEND_URL` → deployed backend URL
- [ ] Mobile `EXPO_PUBLIC_BACKEND_URL` → deployed backend URL
- [ ] `GET /health` returns 200 after deploy
- [ ] `POST /api/instagram/preview` returns valid data
- [ ] `POST /api/youtube/preview` returns valid data
- [ ] EAS build triggered after updating backend URL

---

## 11. Common Errors

| Error | Cause | Fix |
|---|---|---|
| `EADDRINUSE :4000` | Another process using port 4000 | `Get-NetTCPConnection -LocalPort 4000 \| ... \| taskkill /F` |
| `403 You are not subscribed` | Not subscribed to that RapidAPI | Subscribe on rapidapi.com (free plan) |
| `502 Bad Gateway` | RapidAPI returned an error | Check `RAPIDAPI_KEY` in `.env`, check subscription |
| `CORS blocked` | Origin not in allowed list | Add origin to `ALLOWED_ORIGINS` |
| `localhost refused` on mobile | Device can't reach PC localhost | Use local IP `192.168.x.x:4000` |
| Video won't play inline | `dl=1` forces download mode | Use `/stream` endpoint (strips it automatically) |
| Video not seekable | Missing Range header support | `/stream` handles this — use it instead of raw CDN URL |
| `Cannot find module 'dist/index.js'` | TypeScript not compiled | Run `npm run build` before `npm start` |
| `ts-node not found` in prod | Using dev script in production | Use `npm run build && npm start` |

---

## 12. Quick Reference

```
LOCAL
─────────────────────────────────────────────────────────────
Backend:   http://localhost:4000
Web:       http://localhost:8080
Mobile:    Expo Go → scan QR

PRODUCTION
─────────────────────────────────────────────────────────────
Backend:   https://your-backend.railway.app
Web:       https://your-web.vercel.app
Mobile:    EAS build with EXPO_PUBLIC_BACKEND_URL set

KEY ENDPOINTS
─────────────────────────────────────────────────────────────
GET  /health                          → server status
POST /api/instagram/preview           → metadata + download URLs
GET  /api/instagram/stream?url=...    → inline video (use for <video> / expo-av)
GET  /api/instagram/download?url=...  → force-download (web only)
POST /api/youtube/preview             → metadata + quality options
GET  /api/youtube/stream?url=...      → inline video
GET  /api/youtube/download?url=...    → force-download (web only)
```
