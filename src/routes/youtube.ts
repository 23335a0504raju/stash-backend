import { Router, Request, Response } from "express";
import fetch from "node-fetch";
import type { PreviewResult, YoutubeQuality, MediaItem } from "../types";

const router = Router();
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY ?? "";

function extractYoutubeVideoId(url: string): string | null {
  // Handles: watch?v=, youtu.be/, /embed/, /v/, /shorts/
  const match = url.match(
    /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/?|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/
  );
  return match ? match[1] : null;
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
 * GET /api/youtube/download?url=<mediaUrl>&filename=<name>
 * Proxies the YouTube media stream to the client.
 *
 * IMPORTANT: YouTube CDN URLs are signed with c=ANDROID_VR client.
 * The User-Agent MUST match that client type or YouTube returns 403.
 */

// Must match the client that generated the signed URL (c=ANDROID_VR from yt-api)
const YT_UA = "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; Build/SQ3A.220705.001.B1) gzip";

router.get("/download", async (req: Request, res: Response) => {
  const { url, filename } = req.query as { url?: string; filename?: string };
  if (!url) return res.status(400).json({ error: "url is required" });

  try {
    const upstream = await fetch(url, {
      headers: {
        "User-Agent": YT_UA,
        "Referer": "https://www.youtube.com/",
        "Origin": "https://www.youtube.com",
      },
    });

    if (!upstream.ok) {
      console.error(`[youtube/download] upstream ${upstream.status} for ${url.substring(0, 80)}...`);
      return res.status(502).json({ error: `Upstream fetch failed: ${upstream.status}` });
    }

    const contentType = upstream.headers.get("content-type") ?? "video/mp4";
    const contentLength = upstream.headers.get("content-length");

    // Correct the file extension when content is actually WebM
    let safeFilename = filename ?? "stash_youtube.mp4";
    if (contentType.includes("webm") && safeFilename.endsWith(".mp4")) {
      safeFilename = safeFilename.replace(/\.mp4$/i, ".webm");
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFilename}"`
    );
    if (contentLength) res.setHeader("Content-Length", contentLength);

    if (upstream.body) {
      upstream.body.pipe(res);
    } else {
      const buf = await upstream.buffer();
      res.end(buf);
    }
  } catch (err: any) {
    console.error("[youtube/download]", err);
    res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

// YT_UA is defined above near the download route

/**
 * GET /api/youtube/stream?url=<mediaUrl>
 * Proxies YouTube video for INLINE browser preview (no Content-Disposition).
 * Supports Range requests for seeking.
 *
 * Also used by the mobile app (expo-file-system) for downloads.
 * IMPORTANT: Same UA requirement as /download — must match c=ANDROID_VR.
 */
router.get("/stream", async (req: Request, res: Response) => {
  const { url } = req.query as { url?: string };
  if (!url) return res.status(400).json({ error: "url is required" });

  try {
    const rangeHeader = req.headers["range"];
    const upstream = await fetch(url, {
      headers: {
        "User-Agent": YT_UA,
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).json({ error: `Upstream fetch failed: ${upstream.status}` });
    }

    const contentType = upstream.headers.get("content-type") ?? "video/mp4";
    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");
    const acceptRanges = upstream.headers.get("accept-ranges") ?? "bytes";

    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", acceptRanges);
    res.setHeader("Cache-Control", "no-cache");
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (contentRange) res.setHeader("Content-Range", contentRange);

    if (upstream.body) {
      upstream.body.pipe(res);
    } else {
      const buf = await upstream.buffer();
      res.end(buf);
    }
  } catch (err: any) {
    console.error("[youtube/stream]", err);
    res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

export default router;
