import { Router, Request, Response } from "express";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { PreviewResult, YoutubeQuality, MediaItem } from "../types";

const router = Router();
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY ?? "";

// Optional proxy for the upstream googlevideo byte-fetch. Google blocks
// datacenter IPs (e.g. Render) with 403; routing the media fetch through a
// residential proxy fixes it. Unset locally (home IP isn't blocked), set on
// Render: PROXY_URL=http://user:pass@host:port
const PROXY_URL = process.env.PROXY_URL || process.env.HTTPS_PROXY || "";
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;
if (PROXY_URL) {
  console.log("[youtube] upstream media fetch routed through PROXY_URL");
}

function extractYoutubeVideoId(url: string): string | null {
  // Handles: watch?v=, youtu.be/, /embed/, /v/, /shorts/
  const match = url.match(
    /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/?|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/
  );
  return match ? match[1] : null;
}

/**
 * Strategy 0: Resolve YouTube CDN stream URL via RapidAPI.
 * Since the user already has a working RapidAPI key configured for preview,
 * we can use it to fetch the actual video formats and CDN URLs.
 */
async function rapidapiGetUrl(videoId: string, itag: number): Promise<string> {
  if (!RAPIDAPI_KEY) {
    throw new Error("RAPIDAPI_KEY is not configured in .env");
  }

  const apiRes = await fetch(
    `https://yt-api.p.rapidapi.com/dl?id=${videoId}&cgeo=US`,
    {
      headers: {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": "yt-api.p.rapidapi.com",
      },
    }
  );

  if (!apiRes.ok) {
    const text = await apiRes.text();
    throw new Error(`RapidAPI error ${apiRes.status}: ${text}`);
  }

  const json = await apiRes.json() as any;
  if (json.status !== "OK") {
    throw new Error(json.msg ?? "Could not resolve video via RapidAPI");
  }

  const formats = [
    ...(json.formats ?? []),
    ...(json.adaptiveFormats ?? []),
  ];

  const format = formats.find((f: any) => f.itag === itag);
  if (!format || !format.url) {
    throw new Error(`Quality itag ${itag} not available via RapidAPI`);
  }

  return format.url as string;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * POST /api/youtube/preview
 * Body: { url: string }
 * Returns: PreviewResult (with qualities array)
 */
router.post("/preview", async (req: Request, res: Response) => {
  const { url } = req.body as { url?: string };
  if (!url) return res.status(400).json({ error: "url is required" });

  const videoId = extractYoutubeVideoId(url);
  if (!videoId) {
    return res.status(400).json({ error: "Invalid YouTube link. Paste a youtube.com or youtu.be URL." });
  }

  try {
    const apiRes = await fetch(
      `https://yt-api.p.rapidapi.com/dl?id=${videoId}&cgeo=US`,
      {
        headers: {
          "X-RapidAPI-Key": RAPIDAPI_KEY,
          "X-RapidAPI-Host": "yt-api.p.rapidapi.com",
        },
      }
    );

    if (!apiRes.ok) {
      const text = await apiRes.text();
      return res.status(502).json({ error: `YouTube API error ${apiRes.status}: ${text}` });
    }

    const json = await apiRes.json() as any;

    if (json.status !== "OK") {
      return res.status(404).json({ error: "Could not fetch video. Make sure it is public." });
    }

    const title: string = json.title ?? "YouTube Video";
    const author: string = json.channelTitle ?? "Unknown Channel";
    const thumbnail: string =
      json.thumbnail?.[0]?.url ??
      `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    const durationSec = json.lengthSeconds ? parseInt(json.lengthSeconds as string) : 0;
    const duration = durationSec ? formatDuration(durationSec) : undefined;

    // ── ALL qualities: muxed (video+audio) + adaptive (video-only) ────────────
    // Muxed = H.264/AAC MP4 (video + audio), capped at ~720p.
    // Adaptive = VP9/AV1 (video only, no audio), up to 4K.
    // We expose both but label them clearly so the user knows.

    interface QualityWithAudio extends YoutubeQuality { hasAudio: boolean; }

    const allQualities: QualityWithAudio[] = [];
    const seenLabels = new Set<string>();

    // 1. Muxed formats (video+audio) — highest priority, add first
    const muxedFormats: any[] = (json.formats ?? []).filter(
      (f: any) => f.mimeType?.startsWith("video/mp4") && f.qualityLabel && f.url
    );
    muxedFormats.sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0));
    for (const f of muxedFormats) {
      const label = f.qualityLabel as string;
      const key = label + "_muxed";
      if (seenLabels.has(key)) continue;
      seenLabels.add(key);
      allQualities.push({ label, itag: f.itag as number, downloadUrl: f.url as string, hasAudio: true });
    }

    // 2. Adaptive formats (video-only) — allow higher resolutions
    const qualityOrder = ["2160p", "1440p", "1080p", "720p", "480p", "360p", "240p", "144p"];
    const adaptiveMap: Record<string, any> = {};
    for (const f of (json.adaptiveFormats ?? [])) {
      if (!f.mimeType?.startsWith("video/")) continue;
      const label: string = f.qualityLabel;
      if (!label || adaptiveMap[label]) continue;
      adaptiveMap[label] = f;
    }
    for (const label of qualityOrder) {
      if (!adaptiveMap[label]) continue;
      // Only add if we don't already have a muxed version at this label
      if (seenLabels.has(label + "_muxed")) continue;
      const f = adaptiveMap[label];
      allQualities.push({ label, itag: f.itag as number, downloadUrl: f.url as string, hasAudio: false });
    }

    const qualities: YoutubeQuality[] = allQualities.map(({ hasAudio, ...q }) => q);
    // Store hasAudio alongside qualities for the response
    const qualitiesWithAudio = allQualities;

    // Best download default = highest muxed quality (audio included)
    const bestMuxed = muxedFormats[0];
    const bestDownload: string = bestMuxed?.url ?? allQualities[0]?.downloadUrl ?? "";

    const items: MediaItem[] = [
      {
        id: videoId,
        type: "video",
        thumbnail,
        downloadUrl: bestDownload,
        title,
        duration,
      },
    ];

    const result = {
      platform: "youtube" as const,
      author,
      title,
      thumbnail,
      items,
      qualities: qualitiesWithAudio, // includes hasAudio flag for frontend
    };


    return res.json(result);
  } catch (err: any) {
    console.error("[youtube/preview]", err);
    return res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

/**
 * Maps a YouTube itag number to the closest cobalt.tools quality string.
 * cobalt supports: "144", "240", "360", "480", "720", "1080", "1440", "2160", "max"
 */
function itagToQuality(itag: number): string {
  if (itag === 22) return "720";
  if (itag === 18) return "360";
  if (itag === 137 || itag === 299 || itag === 303) return "1080";
  if (itag === 136 || itag === 298 || itag === 302) return "720";
  if (itag === 135 || itag === 244) return "480";
  if (itag === 134 || itag === 243) return "360";
  if (itag === 133 || itag === 242) return "240";
  if (itag === 160 || itag === 278) return "144";
  if (itag === 313 || itag === 401) return "2160";
  if (itag === 271 || itag === 400) return "1440";
  return "720"; // default fallback
}

/**
 * Strategy 1: cobalt.tools with API key (set COBALT_API_KEY env var on Render).
 * Get a free key at: https://cobalt.tools/
 */
async function cobaltGetUrl(videoId: string, quality: string): Promise<string> {
  const apiKey = process.env.COBALT_API_KEY;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Api-Key ${apiKey}`;

  const res = await fetch("https://api.cobalt.tools/", {
    method: "POST",
    headers,
    body: JSON.stringify({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoQuality: quality,
    }),
  });

  const bodyText = await res.text();
  console.log("[cobalt]", res.status, bodyText.substring(0, 200));

  if (!res.ok) throw new Error(`cobalt ${res.status}: ${bodyText.substring(0, 120)}`);

  let data: any;
  try { data = JSON.parse(bodyText); } catch { throw new Error("cobalt non-JSON"); }
  if (data.status === "error") throw new Error(data.error?.code ?? "cobalt error");

  const url = data.url ?? data.picker?.[0]?.url;
  if (!url) throw new Error("cobalt: no url in response");
  return url as string;
}

/**
 * Strategy 2: YouTube's internal MWEB player API.
 * MWEB client URLs are signed differently — less IP-restricted than ANDROID_VR.
 * Returns muxed (video+audio) stream URLs directly from YouTube's player endpoint.
 */
async function youtubeInternalGetUrl(videoId: string, itag: number): Promise<string> {
  const playerRes = await fetch(
    "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/112.0 Mobile Safari/537.36",
        "Origin": "https://www.youtube.com",
        "Referer": "https://www.youtube.com/",
        "X-YouTube-Client-Name": "2",
        "X-YouTube-Client-Version": "2.20240726.00.00",
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: "MWEB",
            clientVersion: "2.20240726.00.00",
            hl: "en",
            gl: "US",
            userAgent: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/112.0 Mobile Safari/537.36",
          },
        },
        playbackContext: {
          contentPlaybackContext: {
            html5Preference: "HTML5_PREF_WANTS",
            signatureTimestamp: 20150,
          },
        },
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    }
  );

  if (!playerRes.ok) throw new Error(`YouTube player API: ${playerRes.status}`);

  const playerData = await playerRes.json() as any;

  if (playerData.playabilityStatus?.status !== "OK") {
    throw new Error(`Video not playable: ${playerData.playabilityStatus?.reason ?? "unknown"}`);
  }

  const formats: any[] = [
    ...(playerData.streamingData?.formats ?? []),
    ...(playerData.streamingData?.adaptiveFormats ?? []),
  ];

  // Try exact itag first, then fall back to any muxed format
  let format = formats.find((f: any) => f.itag === itag);
  if (!format) format = formats.find((f: any) => f.itag === 18); // 360p muxed fallback
  if (!format) format = formats.find((f: any) => f.mimeType?.includes("video/mp4") && f.audioChannels);

  if (!format?.url) {
    throw new Error(`No suitable format found (itag ${itag})`);
  }

  console.log(`[ytinternal] found format itag=${format.itag} mime=${format.mimeType}`);
  return format.url as string;
}

/**
 * GET /api/youtube/download-fresh?videoId=<id>&itag=<n>&filename=<name>
 *
 * Tries strategy 2 (YouTube internal MWEB API) first.
 * If COBALT_API_KEY env var is set, tries cobalt first (most reliable).
 */
router.get("/download-fresh", async (req: Request, res: Response) => {
  const { videoId, itag, filename } = req.query as {
    videoId?: string; itag?: string; filename?: string;
  };
  if (!videoId || !itag) {
    return res.status(400).json({ error: "videoId and itag are required" });
  }

  const itagNum = Number(itag);
  const quality = itagToQuality(itagNum);
  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

  let downloadUrl: string | null = null;
  const errors: string[] = [];

  // Try RapidAPI first (most reliable and already configured)
  try {
    downloadUrl = await rapidapiGetUrl(videoId, itagNum);
    console.log("[download-fresh] RapidAPI success");
  } catch (e: any) {
    errors.push(`rapidapi: ${e.message}`);
    console.warn("[download-fresh] RapidAPI failed, trying cobalt/internal:", e.message);
  }

  // Try cobalt next if API key is configured (most reliable)
  if (!downloadUrl && process.env.COBALT_API_KEY) {
    try {
      downloadUrl = await cobaltGetUrl(videoId, quality);
      console.log("[download-fresh] cobalt success");
    } catch (e: any) {
      errors.push(`cobalt: ${e.message}`);
      console.warn("[download-fresh] cobalt failed, trying YouTube internal:", e.message);
    }
  }

  // Fall back to YouTube internal MWEB API
  if (!downloadUrl) {
    try {
      downloadUrl = await youtubeInternalGetUrl(videoId, itagNum);
      console.log("[download-fresh] YouTube internal success");
    } catch (e: any) {
      errors.push(`ytinternal: ${e.message}`);
      console.error("[download-fresh] YouTube internal failed:", e.message);
    }
  }

  // If cobalt key exists but wasn't tried first (no key), try cobalt as final fallback anyway
  if (!downloadUrl && !process.env.COBALT_API_KEY) {
    try {
      downloadUrl = await cobaltGetUrl(videoId, quality);
    } catch (e: any) {
      errors.push(`cobalt-nokey: ${e.message}`);
    }
  }

  if (!downloadUrl) {
    return res.status(502).json({
      error: "Download unavailable from cloud. Open on YouTube directly.",
      youtubeUrl,
      details: errors,
    });
  }

  try {
    const upstream = await fetch(downloadUrl, {
      agent: proxyAgent as any,
      headers: {
        "Referer": "https://www.youtube.com/",
        "Origin": "https://www.youtube.com",
        "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/112.0 Mobile Safari/537.36",
      },
    });

    if (!upstream.ok) {
      return res.status(502).json({
        error: `Upstream ${upstream.status}. Try opening on YouTube.`,
        youtubeUrl,
      });
    }

    const contentType = upstream.headers.get("content-type") ?? "video/mp4";
    const contentLength = upstream.headers.get("content-length");

    let safeFilename = (filename as string | undefined) ?? `stash_youtube_${quality}p.mp4`;
    if (contentType.includes("webm") && safeFilename.endsWith(".mp4")) {
      safeFilename = safeFilename.replace(/\.mp4$/i, ".webm");
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    if (contentLength) res.setHeader("Content-Length", contentLength);

    if (upstream.body) {
      upstream.body.pipe(res);
    } else {
      const buf = await (upstream as any).buffer();
      res.end(buf);
    }
  } catch (err: any) {
    console.error("[download-fresh] stream error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message, youtubeUrl });
    }
  }
});

/**
 * GET /api/youtube/download?videoId=<id>&itag=<n>&filename=<name> [legacy alias]
 */
router.get("/download", async (req: Request, res: Response) => {
  const qs = req.url.split("?")[1] ?? "";
  return res.redirect(307, `/api/youtube/download-fresh?${qs}`);
});

/**
 * GET /api/youtube/stream?videoId=<id>&itag=<n>&url=<legacyUrl>
 *
 * Resolves a fresh stream URL using the 3-step strategy and proxies the media content.
 * Supports Range headers for seekable video playback in expo-video and browser players.
 * Also handles legacy calls that pass a raw CDN URL under `url`.
 */
router.get("/stream", async (req: Request, res: Response) => {
  const { videoId, itag, url } = req.query as { videoId?: string; itag?: string; url?: string };

  let downloadUrl: string | null = null;
  let finalVideoId = videoId;
  const itagNum = Number(itag ?? 18);

  // Handle legacy/fallback: if a url query parameter is passed, try to extract videoId
  if (url) {
    const extractedId = extractYoutubeVideoId(url);
    if (extractedId) {
      finalVideoId = extractedId;
    } else {
      // Use raw URL directly if we cannot parse it (e.g. old googlevideo CDN url)
      downloadUrl = url;
    }
  }

  if (!finalVideoId && !downloadUrl) {
    return res.status(400).json({ error: "videoId or url is required" });
  }

  const quality = itagToQuality(itagNum);

  // Resolve fresh download/stream URL if we have the videoId
  if (!downloadUrl && finalVideoId) {
    const errors: string[] = [];

    // Try RapidAPI first (most reliable and already configured)
    try {
      downloadUrl = await rapidapiGetUrl(finalVideoId, itagNum);
      console.log("[stream] resolved via RapidAPI");
    } catch (e: any) {
      errors.push(`rapidapi: ${e.message}`);
      console.warn("[stream] RapidAPI failed, trying cobalt/internal:", e.message);
    }

    // Try Cobalt next if API key is configured
    if (!downloadUrl && process.env.COBALT_API_KEY) {
      try {
        downloadUrl = await cobaltGetUrl(finalVideoId, quality);
        console.log("[stream] resolved via cobalt");
      } catch (e: any) {
        errors.push(`cobalt: ${e.message}`);
        console.warn("[stream] cobalt failed, trying YouTube internal:", e.message);
      }
    }

    // Fall back to YouTube internal MWEB player API
    if (!downloadUrl) {
      try {
        downloadUrl = await youtubeInternalGetUrl(finalVideoId, itagNum);
        console.log("[stream] resolved via YouTube internal");
      } catch (e: any) {
        errors.push(`ytinternal: ${e.message}`);
        console.error("[stream] YouTube internal failed:", e.message);
      }
    }

    // Key-less cobalt final fallback if no key is configured
    if (!downloadUrl && !process.env.COBALT_API_KEY) {
      try {
        downloadUrl = await cobaltGetUrl(finalVideoId, quality);
        console.log("[stream] resolved via keyless cobalt fallback");
      } catch (e: any) {
        errors.push(`cobalt-nokey: ${e.message}`);
      }
    }

    if (!downloadUrl) {
      return res.status(502).json({
        error: "Stream currently unavailable from cloud.",
        details: errors,
      });
    }
  }

  try {
    const rangeHeader = req.headers["range"];
    const upstream = await fetch(downloadUrl!, {
      agent: proxyAgent as any,
      headers: {
        "Referer": "https://www.youtube.com/",
        "Origin": "https://www.youtube.com",
        "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/112.0 Mobile Safari/537.36",
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
    });

    if (!upstream.ok && upstream.status !== 206) {
      console.error(`[youtube/stream] upstream status ${upstream.status} for ${downloadUrl?.substring(0, 100)}...`);
      return res.status(502).json({ error: `Upstream fetch failed: ${upstream.status}` });
    }

    const contentType = upstream.headers.get("content-type") ?? "video/mp4";
    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");
    const acceptRanges = upstream.headers.get("accept-ranges") ?? "bytes";

    res.status(upstream.status); // 200 or 206 (partial)
    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", acceptRanges);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (contentRange) res.setHeader("Content-Range", contentRange);

    if (upstream.body) {
      upstream.body.pipe(res);
    } else {
      const buf = await (upstream as any).buffer();
      res.end(buf);
    }
  } catch (err: any) {
    console.error("[youtube/stream] streaming error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message ?? "Stream failed" });
    }
  }
});

export default router;
