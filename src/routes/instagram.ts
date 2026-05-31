import { Router, Request, Response } from "express";
import fetch from "node-fetch";
import type { PreviewResult, MediaItem } from "../types";

const router = Router();
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY ?? "";
const API_HOST = "instagram120.p.rapidapi.com";

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

/**
 * POST /api/instagram/preview
 * Body: { url: string }
 * Returns: PreviewResult
 *
 * Uses instagram120.p.rapidapi.com → POST /api/instagram/mediaByShortcode
 * Response: [{ urls:[{url, name, subName, extension, quality}], meta:{title, thumbnail, author} }]
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
    const apiRes = await fetch(
      `https://${API_HOST}/api/instagram/mediaByShortcode`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-RapidAPI-Key": RAPIDAPI_KEY,
          "X-RapidAPI-Host": API_HOST,
        },
        body: JSON.stringify({ shortcode }),
      }
    );

    const responseText = await apiRes.text();

    if (!apiRes.ok) {
      console.error("[instagram/preview] API error:", apiRes.status, responseText);
      return res.status(502).json({
        error: `Instagram API error ${apiRes.status}: ${responseText}`,
      });
    }

    let json: any;
    try {
      json = JSON.parse(responseText);
    } catch {
      return res.status(502).json({ error: "Invalid JSON from Instagram API" });
    }

    // Handle "link not found" / failure
    if (json?.success === false || json?.response_type === "link not found") {
      return res.status(404).json({
        error: "Post not found. Make sure the post is public and the link is correct.",
      });
    }

    // Response is an array of media items (carousel = multiple items)
    const mediaArray: any[] = Array.isArray(json) ? json : [json];

    if (mediaArray.length === 0) {
      return res.status(404).json({ error: "No downloadable media found in this post." });
    }

    // Extract metadata from the first item
    const firstItem = mediaArray[0];
    const meta = firstItem?.meta ?? {};
    const author: string =
      meta.author ?? meta.username ?? meta.owner ?? "Instagram";
    const title: string = meta.title ?? meta.description ?? "";
    // Top-level thumbnail — check every field name the API might use
    // NOTE: API log confirmed actual keys: urls, meta, pictureUrl, pictureUrlWrapped
    const topThumb: string =
      firstItem?.pictureUrl ??            // ← confirmed real field
      firstItem?.pictureUrlWrapped ??     // ← confirmed real field
      meta.thumbnail ?? meta.cover ?? meta.image ?? meta.preview ??
      meta.imageUrl ?? meta.thumb ?? meta.cover_image ?? "";

    // Build items list
    const items: MediaItem[] = mediaArray.map((media: any, i: number) => {
      const urls: any[] = media?.urls ?? [];
      const best = urls.sort((a: any, b: any) => (b.quality ?? 0) - (a.quality ?? 0))[0];
      const mediaUrl: string = best?.url ?? "";
      const ext: string = (best?.extension ?? best?.name ?? "").toLowerCase();
      const isVideo = ext === "mp4" || ext === "video";

      const mediaMeta = media?.meta ?? {};
      // Check pictureUrl on each carousel item too
      const thumbFromMeta: string =
        media?.pictureUrl ??              // ← confirmed real field (per-item)
        media?.pictureUrlWrapped ??
        mediaMeta.thumbnail ?? mediaMeta.cover ?? mediaMeta.image ??
        mediaMeta.preview ?? mediaMeta.thumb ?? mediaMeta.imageUrl ??
        topThumb;
      // For image items: if still no thumbnail, use the download URL itself
      const thumbnail: string = thumbFromMeta || (!isVideo ? mediaUrl : "");

      return {
        id: shortcode + (i > 0 ? `_${i}` : ""),
        type: isVideo ? "video" : "image",
        thumbnail,
        downloadUrl: mediaUrl,
        title: (mediaMeta.title ?? mediaMeta.description ?? title ?? "")
          .split("\n")[0].slice(0, 80) || `Item ${i + 1}`,
        duration: mediaMeta.duration ? formatDuration(Math.round(mediaMeta.duration)) : undefined,
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
    console.error("[instagram/preview]", err);
    return res.status(500).json({ error: err.message ?? "Internal server error" });
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
 * Extracts username + storyId, calls:
 *   POST instagram120.p.rapidapi.com/api/instagram/story { storyId, username }
 * Response has result[]: { image_versions2, video_versions, media_type, ... }
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
    const apiRes = await fetch(`https://${API_HOST}/api/instagram/story`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": API_HOST,
      },
      body: JSON.stringify({ storyId, username }),
    });

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

    if (json?.success === false) {
      return res.status(404).json({ error: "Story not found or account is private." });
    }

    // API returns { result: [ { image_versions2, video_versions, media_type, pk, ... } ] }
    const results: any[] = Array.isArray(json?.result) ? json.result : [json];

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
