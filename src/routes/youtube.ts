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
 * Maps a YouTube itag number to the closest cobalt.tools quality string.
 * cobalt supports: "144", "240", "360", "480", "720", "1080", "1440", "2160", "max"
 */
function itagToQuality(itag: number): string {
  if (itag === 22)  return "720";  // muxed 720p
  if (itag === 18)  return "360";  // muxed 360p
  if ([266, 264, 137, 399, 248, 303, 313, 315].includes(itag)) return "1080";
  if ([136, 398, 247, 302, 308, 271].includes(itag)) return "720";
  if ([135, 397, 244, 298].includes(itag)) return "480";
  if ([134, 396, 243].includes(itag)) return "360";
  if ([133, 395, 242].includes(itag)) return "240";
  if ([160, 394, 278].includes(itag)) return "144";
  return "360"; // safe default
}

/**
 * Calls cobalt.tools API and returns the download URL.
 * cobalt runs its own YouTube infrastructure that isn't IP-blocked.
 */
async function cobaltGetUrl(videoId: string, quality: string): Promise<string> {
  const requestBody = {
    url: `https://www.youtube.com/watch?v=${videoId}`,
    videoQuality: quality,
  };

  console.log("[cobalt] requesting", requestBody);

  const cobaltRes = await fetch("https://api.cobalt.tools/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  // Read body regardless of status for better error messages
  const bodyText = await cobaltRes.text();
  console.log("[cobalt] response", cobaltRes.status, bodyText.substring(0, 300));

  if (!cobaltRes.ok) {
    throw new Error(`Cobalt API error: ${cobaltRes.status} — ${bodyText.substring(0, 150)}`);
  }

  let cobalt: any;
  try { cobalt = JSON.parse(bodyText); } catch {
    throw new Error(`Cobalt returned non-JSON: ${bodyText.substring(0, 100)}`);
  }

  if (cobalt.status === "error") {
    throw new Error(cobalt.error?.code ?? cobalt.text ?? "Cobalt returned error");
  }

  // cobalt returns status: "stream", "redirect", "tunnel", or "picker"
  const url = cobalt.url ?? cobalt.picker?.[0]?.url;
  if (!url) throw new Error(`Cobalt gave status '${cobalt.status}' but no url`);
  return url as string;
}

/**
 * GET /api/youtube/download-fresh?videoId=<id>&itag=<n>&filename=<name>
 *
 * Uses cobalt.tools to download the YouTube video.
 * Proxies the stream through our backend so the browser can save it.
 */
router.get("/download-fresh", async (req: Request, res: Response) => {
  const { videoId, itag, filename } = req.query as {
    videoId?: string; itag?: string; filename?: string;
  };
  if (!videoId || !itag) {
    return res.status(400).json({ error: "videoId and itag are required" });
  }

  try {
    const quality = itagToQuality(Number(itag));
    const downloadUrl = await cobaltGetUrl(videoId, quality);

    // Proxy the stream so the browser gets it as a file download
    const upstream = await fetch(downloadUrl);
    if (!upstream.ok) {
      return res.status(502).json({ error: `Stream fetch failed: ${upstream.status}` });
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
    console.error("[youtube/download-fresh]", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message ?? "Download failed" });
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
 * GET /api/youtube/stream?videoId=<id>&itag=<n>
 *
 * Returns a 307 redirect to the cobalt.tools stream URL.
 * Used by the mobile app (expo-video / expo-file-system) which follows redirects.
 * Web preview now uses the YouTube iframe embed instead.
 */
router.get("/stream", async (req: Request, res: Response) => {
  const { videoId, itag } = req.query as { videoId?: string; itag?: string };
  if (!videoId) return res.status(400).json({ error: "videoId is required" });

  try {
    const quality = itagToQuality(Number(itag ?? 18));
    const streamUrl = await cobaltGetUrl(videoId, quality);
    // Redirect — expo-video and expo-file-system both follow 307 redirects
    return res.redirect(307, streamUrl);
  } catch (err: any) {
    console.error("[youtube/stream]", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message ?? "Stream failed" });
  }
});

export default router;
