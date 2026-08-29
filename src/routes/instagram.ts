import { Router, Request, Response } from "express";
import fetch from "node-fetch";
import type { PreviewResult, MediaItem } from "../types";

const router = Router();
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY ?? "";

// Posts + reels (URL-keyed): GET /download?url=<instagram url>
// Replaces instagram120, which was delisted from RapidAPI (gateway returns
// 404 "API doesn't exists" for every path on that host).
const REELS_API_HOST = "instagram-reels-downloader-api.p.rapidapi.com";

// Stories (username-keyed): POST /get_ig_user_stories.php, form-encoded.
const STORIES_API_HOST = "instagram-scraper-stable-api.p.rapidapi.com";

// The reels API fails roughly a third of the time on perfectly valid links —
// measured 5/8 success on identical back-to-back requests. It surfaces this
// two ways, both as HTTP 500: an "undergoing an upgrade" message, and a
// literal "[object Object]" from a bug in their own error handling. Every 5xx
// here is therefore treated as transient; only 4xx means the post is bad.
const TRANSIENT_ERROR = /undergoing an upgrade|try again later|timeout|busy/i;

/** Upstream sometimes sends a stringified object as its message — hide it. */
function cleanUpstreamMessage(message: unknown): string {
  const text = typeof message === "string" ? message : "";
  if (!text || text === "[object Object]") {
    return "Instagram is busy right now. Please try again in a moment.";
  }
  return text;
}

/**
 * Calls the reels downloader, retrying transient upstream failures, and
 * returns the `data` object. Throws once retries are exhausted.
 */
async function fetchInstagramMedia(igUrl: string, attempts = 4): Promise<any> {
  let lastError = "Instagram API request failed";

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 400 * i));

    let apiRes;
    let responseText: string;
    try {
      apiRes = await fetch(
        `https://${REELS_API_HOST}/download?url=${encodeURIComponent(igUrl)}`,
        {
          headers: {
            "Content-Type": "application/json",
            "X-RapidAPI-Key": RAPIDAPI_KEY,
            "X-RapidAPI-Host": REELS_API_HOST,
          },
        }
      );
      responseText = await apiRes.text();
    } catch (err: any) {
      // Network-level failure — always worth another attempt.
      lastError = err?.message ?? "Could not reach the Instagram API";
      continue;
    }

    let json: any;
    try {
      json = JSON.parse(responseText);
    } catch {
      lastError = "Invalid JSON from Instagram API";
      continue;
    }

    if (json?.success && json?.data) return json.data;

    const status = Number(json?.code ?? apiRes.status);
    lastError = cleanUpstreamMessage(json?.message);
    console.error("[instagram] upstream", status, responseText.slice(0, 200));

    // 4xx means the link itself is bad — retrying cannot help.
    if (status < 500) break;
  }

  throw new Error(lastError);
}

function extractInstagramShortcode(url: string): string | null {
  // Matches /p/, /reel/, /tv/ shortcodes
  const match = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Widest-first, so the highest quality rendition of a media item wins. */
function resolutionWidth(media: any): number {
  const w = String(media?.resolution ?? media?.quality ?? "").match(/^(\d+)/);
  return w ? Number(w[1]) : 0;
}

/**
 * POST /api/instagram/preview
 * Body: { url: string }
 * Returns: PreviewResult
 *
 * Uses instagram-reels-downloader-api.p.rapidapi.com → GET /download?url=<url>
 * Handles both /p/ posts and /reel/ reels.
 * Response: { success, data: { title, author, owner:{username}, thumbnail,
 *             shortcode, duration, medias:[{id, url, thumbnail, type,
 *             extension, quality, resolution, duration}] } }
 */
router.post("/preview", async (req: Request, res: Response) => {
  const { url } = req.body as { url?: string };
  if (!url) return res.status(400).json({ error: "url is required" });

  const shortcode = extractInstagramShortcode(url);
  if (!shortcode) {
    return res.status(400).json({
      error: "Invalid Instagram link. Paste a post, reel, or /p/ URL.",
    });
  }

  try {
    const data = await fetchInstagramMedia(url);

    // Reels ship a separate audio track alongside the video — it is not a
    // downloadable item of its own, so drop it before building the list.
    // NB: `is_audio` is true on the *video* entry too (it means "has sound"),
    // so `type` is the only field that identifies the standalone audio track.
    const playable: any[] = (data?.medias ?? []).filter(
      (m: any) =>
        m?.url &&
        m.type !== "audio" &&
        !String(m.mimeType ?? "").startsWith("audio/")
    );

    // Carousels return one entry per slide; a single item can still return
    // several renditions sharing an id. Keep the widest per id.
    const bestById = new Map<string, any>();
    playable.forEach((m: any, i: number) => {
      const key = String(m.id ?? i);
      const current = bestById.get(key);
      if (!current || resolutionWidth(m) > resolutionWidth(current)) {
        bestById.set(key, m);
      }
    });
    const medias = [...bestById.values()];

    if (medias.length === 0) {
      return res.status(404).json({
        error: "No downloadable media found in this post.",
      });
    }

    // owner.username is the real handle; author is the display name.
    const author: string = data?.owner?.username ?? data?.author ?? "Instagram";
    const title: string = data?.title ?? "";
    const topThumb: string = data?.thumbnail ?? medias[0]?.thumbnail ?? "";

    const items: MediaItem[] = medias.map((m: any, i: number) => {
      const isVideo =
        m.type === "video" || String(m.extension).toLowerCase() === "mp4";
      const seconds = Number(m.duration ?? data?.duration ?? 0);

      return {
        id: String(m.id ?? shortcode + (i > 0 ? `_${i}` : "")),
        type: isVideo ? "video" : "image",
        // Images carry no separate thumbnail — the media URL is the preview.
        thumbnail: m.thumbnail || (!isVideo ? m.url : topThumb),
        downloadUrl: m.url,
        title: (title || "").split("\n")[0].slice(0, 80) || `Item ${i + 1}`,
        duration: seconds > 0 ? formatDuration(Math.round(seconds)) : undefined,
      } as MediaItem;
    });

    const result: PreviewResult = {
      platform: "instagram",
      author,
      title,
      thumbnail: topThumb || items[0]?.thumbnail || "",
      items,
    };

    return res.json(result);
  } catch (err: any) {
    const message = err?.message ?? "Internal server error";
    console.error("[instagram/preview]", message);

    // Quota text leaks the plan name and an upgrade link — never show it to
    // users, but keep it loud in the logs so it is obvious what broke.
    if (/exceeded the (monthly quota|rate limit)/i.test(message)) {
      return res.status(429).json({
        error: "Download limit reached. Please try again later.",
      });
    }
    if (TRANSIENT_ERROR.test(message)) {
      return res.status(503).json({
        error: "Instagram is busy right now. Please try again in a moment.",
      });
    }
    if (/not found|private|invalid/i.test(message)) {
      return res.status(404).json({
        error:
          "Post not found. Make sure the post is public and the link is correct.",
      });
    }
    return res.status(502).json({ error: message });
  }
});

/**
 * GET /api/instagram/download?url=<mediaUrl>&filename=<name>
 * Proxies the media file as a forced download (Content-Disposition: attachment).
 */
router.get("/download", async (req: Request, res: Response) => {
  const { url, filename } = req.query as { url?: string; filename?: string };
  if (!url) return res.status(400).json({ error: "url is required" });

  try {
    const upstream = await fetch(url, {
      headers: {
        "Referer": "https://www.instagram.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Origin": "https://www.instagram.com",
      },
    });
    if (!upstream.ok) {
      return res.status(502).json({ error: `Upstream fetch failed: ${upstream.status}` });
    }

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const contentLength = upstream.headers.get("content-length");

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename ?? "stash_instagram_media"}"`
    );
    if (contentLength) res.setHeader("Content-Length", contentLength);

    if (upstream.body) {
      upstream.body.pipe(res);
    } else {
      const buf = await upstream.buffer();
      res.end(buf);
    }
  } catch (err: any) {
    console.error("[instagram/download]", err);
    res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

/**
 * GET /api/instagram/stream?url=<mediaUrl>
 * Proxies the video/image for INLINE browser preview (no Content-Disposition).
 * Strips the "dl=1" param so CDN serves it as streaming instead of download.
 * Supports Range requests so the browser video player can seek.
 * Adds Instagram CDN headers so thumbnails and videos load without 403.
 */
router.get("/stream", async (req: Request, res: Response) => {
  const { url } = req.query as { url?: string };
  if (!url) return res.status(400).json({ error: "url is required" });

  // Remove dl=1 from the URL — that param forces CDN into download mode
  const streamUrl = url.replace(/[&?]dl=1/g, "");

  try {
    const rangeHeader = req.headers["range"];
    const upstream = await fetch(streamUrl, {
      headers: {
        // Instagram CDN requires these — without them it returns 403
        "Referer": "https://www.instagram.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Origin": "https://www.instagram.com",
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).json({ error: `Upstream fetch failed: ${upstream.status}` });
    }

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");
    const acceptRanges = upstream.headers.get("accept-ranges") ?? "bytes";

    res.status(upstream.status); // 200 or 206 (partial)
    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", acceptRanges);
    res.setHeader("Cache-Control", "public, max-age=3600"); // cache images for 1h
    res.setHeader("Access-Control-Allow-Origin", "*");
    // NO Content-Disposition — allows inline display
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (contentRange) res.setHeader("Content-Range", contentRange);

    if (upstream.body) {
      upstream.body.pipe(res);
    } else {
      const buf = await upstream.buffer();
      res.end(buf);
    }
  } catch (err: any) {
    console.error("[instagram/stream]", err);
    res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

/**
 * GET /api/instagram/thumb?url=<imageUrl>
 * Dedicated thumbnail proxy — same as stream but optimised for image caching.
 * Use this as the `src` of <img> tags for Instagram thumbnails.
 */
router.get("/thumb", async (req: Request, res: Response) => {
  const { url } = req.query as { url?: string };
  if (!url) return res.status(400).json({ error: "url is required" });

  try {
    const upstream = await fetch(url, {
      headers: {
        "Referer": "https://www.instagram.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Origin": "https://www.instagram.com",
      },
    });

    if (!upstream.ok) {
      return res.status(502).json({ error: `Thumbnail fetch failed: ${upstream.status}` });
    }

    const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
    const contentLength = upstream.headers.get("content-length");

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400"); // cache 24h
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    if (upstream.body) {
      upstream.body.pipe(res);
    } else {
      const buf = await upstream.buffer();
      res.end(buf);
    }
  } catch (err: any) {
    console.error("[instagram/thumb]", err);
    res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

/**
 * POST /api/instagram/story
 * Body: { url: string }  — accepts a full story URL:
 *   https://www.instagram.com/stories/{username}/{storyId}/
 *
 * Extracts the username, calls:
 *   POST instagram-scraper-stable-api.p.rapidapi.com/get_ig_user_stories.php
 *   (form-encoded: username_or_url=<username>)
 * Response is a bare array: [{ id, pk, media_type, image_versions2,
 * video_versions, video_duration, ... }]
 *
 * That endpoint returns the user's whole active story tray rather than one
 * story, so we narrow it to the linked storyId when it is still live and fall
 * back to the full tray when it has already expired.
 */
router.post("/stories", async (req: Request, res: Response) => {
  const { url } = req.body as { url?: string };
  if (!url) return res.status(400).json({ error: "url is required" });

  // Extract username + storyId from URL
  // Pattern: instagram.com/stories/{username}/{storyId}
  const match = url.match(/instagram\.com\/stories\/([^/?#]+)\/(\d+)/);
  if (!match) {
    return res.status(400).json({
      error: "Invalid story URL. Paste a link like: instagram.com/stories/username/123456789/",
    });
  }

  const username = match[1];
  const storyId = match[2];

  try {
    const apiRes = await fetch(
      `https://${STORIES_API_HOST}/get_ig_user_stories.php`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-RapidAPI-Key": RAPIDAPI_KEY,
          "X-RapidAPI-Host": STORIES_API_HOST,
        },
        body: `username_or_url=${encodeURIComponent(username)}`,
      }
    );

    const responseText = await apiRes.text();

    if (!apiRes.ok) {
      console.error("[instagram/story] API error:", apiRes.status, responseText);
      return res.status(502).json({
        error: `Instagram API error ${apiRes.status}: ${responseText}`,
      });
    }

    let json: any;
    try { json = JSON.parse(responseText); } catch {
      return res.status(502).json({ error: "Invalid JSON from Instagram API" });
    }

    if (json?.success === false || json?.error) {
      return res.status(404).json({
        error: json?.error ?? "Story not found or account is private.",
      });
    }

    // Endpoint returns a bare array of story items.
    const tray: any[] = Array.isArray(json) ? json : [json];

    // Story ids look like "3973701598586094809_787132" — the leading pk is the
    // storyId from the URL. Narrow to it if that story is still live.
    const linked = tray.filter(
      (s: any) =>
        String(s?.pk) === storyId || String(s?.id ?? "").split("_")[0] === storyId
    );
    const results: any[] = linked.length > 0 ? linked : tray;

    const items: MediaItem[] = results.map((s: any, i: number) => {
      // media_type 2 = video, 1 = image
      const isVideo = s?.media_type === 2 || !!s?.video_versions?.length;

      // Best video URL — pick highest bitrate
      const videoVersions: any[] = s?.video_versions ?? [];
      const videoUrl: string = videoVersions.sort((a: any, b: any) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? "";

      // Best image URL — pick highest resolution candidate
      const imgCandidates: any[] = s?.image_versions2?.candidates ?? [];
      const imgUrl: string = imgCandidates.sort((a: any, b: any) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? "";

      const mediaUrl = isVideo ? videoUrl : imgUrl;
      const thumbUrl = imgUrl;

      const durationSec = s?.video_duration ?? 0;

      return {
        id: s?.pk ?? s?.id ?? `story_${i}`,
        type: isVideo ? "video" : "image",
        thumbnail: thumbUrl,
        downloadUrl: mediaUrl,
        title: `Story ${i + 1}`,
        duration: durationSec ? formatDuration(Math.round(durationSec)) : undefined,
      } as MediaItem;
    }).filter((item) => !!item.downloadUrl);

    if (items.length === 0) {
      return res.status(404).json({ error: "No downloadable media found in this story." });
    }

    const result: PreviewResult = {
      platform: "instagram",
      author: username,
      title: `Story from @${username}`,
      thumbnail: items[0].thumbnail,
      items,
    };

    return res.json(result);
  } catch (err: any) {
    console.error("[instagram/story]", err);
    return res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

export default router;
