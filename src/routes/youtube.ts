import { Router, Request, Response } from "express";
import fetch from "node-fetch";
import ytdl from "@distube/ytdl-core";
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
 * GET /api/youtube/download-fresh?videoId=<id>&itag=<n>&filename=<name>
 *
 * Uses @distube/ytdl-core to stream the video directly from YouTube.
 * This bypasses the CDN URL proxy approach which fails because cloud
 * provider IPs (Render, AWS, etc.) are blocked by YouTube's CDN.
 * ytdl-core handles authentication and routing internally.
 */
router.get("/download-fresh", async (req: Request, res: Response) => {
  const { videoId, itag, filename } = req.query as {
    videoId?: string; itag?: string; filename?: string;
  };
  if (!videoId || !itag) {
    return res.status(400).json({ error: "videoId and itag are required" });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    // Get video info to find the matching format
    const info = await ytdl.getInfo(videoUrl);
    const format = ytdl.chooseFormat(info.formats, { quality: Number(itag) });

    if (!format) {
      return res.status(404).json({ error: `Quality itag=${itag} not available.` });
    }

    const mimeType = format.mimeType ?? "video/mp4";
    const contentType = mimeType.split(";")[0].trim(); // e.g. "video/mp4"

    let safeFilename = filename ?? `stash_youtube_${itag}.mp4`;
    if (contentType.includes("webm") && safeFilename.endsWith(".mp4")) {
      safeFilename = safeFilename.replace(/\.mp4$/i, ".webm");
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    if (format.contentLength) res.setHeader("Content-Length", format.contentLength);

    // Stream directly to the response
    const stream = ytdl(videoUrl, { format });
    stream.on("error", (err) => {
      console.error("[youtube/download-fresh] stream error:", err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: "Stream failed: " + err.message });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);

  } catch (err: any) {
    console.error("[youtube/download-fresh]", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message ?? "Download failed" });
    }
  }
});

/**
 * GET /api/youtube/download?videoId=<id>&itag=<n>&filename=<name>   [legacy alias]
 * Kept for backwards compat — forwards to /download-fresh logic via ytdl.
 */
router.get("/download", async (req: Request, res: Response) => {
  const { videoId, itag, filename, url } = req.query as {
    videoId?: string; itag?: string; filename?: string; url?: string;
  };

  // Legacy callers pass a raw CDN url — extract videoId from it if possible
  let vid = videoId;
  if (!vid && url) {
    const m = (url as string).match(/[?&]id=o-[^&]+/); // old-style id= in CDN url
    // Fall back: try extracting from the url directly (not reliable for CDN URLs)
    // Just proxy the request to download-fresh by forwarding the query
    return res.redirect(307, `/api/youtube/download-fresh?${req.url.split("?")[1] ?? ""}`);
  }
  if (!vid || !itag) {
    return res.status(400).json({ error: "videoId and itag required (or use /download-fresh)" });
  }
  return res.redirect(307, `/api/youtube/download-fresh?videoId=${vid}&itag=${itag}&filename=${filename ?? ""}`);
});

/**
 * GET /api/youtube/stream?videoId=<id>&itag=<n>
 * Streams a YouTube video for inline browser preview using ytdl-core.
 * Also used by the mobile app (expo-file-system) for downloads.
 */
router.get("/stream", async (req: Request, res: Response) => {
  const { videoId, itag } = req.query as { videoId?: string; itag?: string };

  // Legacy: some callers pass ?url= (the old CDN URL). Extract videoId from query.
  const legacyUrl = (req.query.url as string | undefined);
  let vid = videoId;
  if (!vid && legacyUrl) {
    // Try to get videoId from the legacy url — not possible from CDN url, so fail gracefully
    return res.status(400).json({ error: "Legacy stream URLs are no longer supported. Fetch a fresh preview." });
  }
  if (!vid) return res.status(400).json({ error: "videoId is required" });

  const videoUrl = `https://www.youtube.com/watch?v=${vid}`;

  try {
    const info = await ytdl.getInfo(videoUrl);
    const format = itag
      ? ytdl.chooseFormat(info.formats, { quality: Number(itag) })
      : ytdl.chooseFormat(info.formats, { quality: "highestvideo", filter: "audioandvideo" });

    if (!format) {
      return res.status(404).json({ error: "No suitable format found." });
    }

    const mimeType = format.mimeType ?? "video/mp4";
    const contentType = mimeType.split(";")[0].trim();

    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "none");
    res.setHeader("Cache-Control", "no-cache");
    if (format.contentLength) res.setHeader("Content-Length", format.contentLength);

    const stream = ytdl(videoUrl, { format });
    stream.on("error", (err) => {
      console.error("[youtube/stream] stream error:", err.message);
      if (!res.headersSent) res.status(502).json({ error: err.message });
      else res.destroy();
    });
    stream.pipe(res);

  } catch (err: any) {
    console.error("[youtube/stream]", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message ?? "Stream failed" });
  }
});

export default router;
