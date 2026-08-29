import { Router, Request, Response } from "express";
import fetch from "node-fetch";
import type { PreviewResult, MediaItem } from "../types";

const router = Router();
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY ?? "";

// One URL-keyed API covers posts, carousels, reels and stories:
//   GET /convert?url=<instagram url>  →  { media: [{ type, quality, thumbnail, url }] }
//
// History: instagram120 was delisted from RapidAPI (its host returns 404
// "API doesn't exists" for every path), and its replacement,
// instagram-reels-downloader-api, capped the free plan at 20 requests/month
// and failed 3 of 8 identical requests. This one is a single API for every
// link type, so there is one quota and one failure mode to reason about.
const IG_API_HOST =
  "instagram-downloader-download-instagram-stories-videos4.p.rapidapi.com";

// Retried on 5xx only; a 4xx means the link itself is bad.
const TRANSIENT_ERROR = /try again later|timeout|busy|temporarily/i;

const BROWSER_HEADERS = {
  Referer: "https://www.instagram.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
};

/** Upstream sometimes sends a stringified object as its message — hide it. */
function cleanUpstreamMessage(message: unknown): string {
  const text = typeof message === "string" ? message : "";
  if (!text || text === "[object Object]") {
    return "Instagram is busy right now. Please try again in a moment.";
  }
  return text;
}

/**
 * The downloader returns media URLs but no author or caption, which the app's
 * preview card shows. Instagram's public oembed fills that in for free (no
 * RapidAPI quota). It is best-effort: it is rate-limited and can be blocked
 * from datacenter IPs, so a failure degrades to empty strings rather than
 * failing the request.
 */
async function fetchOembedMeta(
  igUrl: string
): Promise<{ author: string; title: string }> {
  const empty = { author: "", title: "" };
  try {
    const res = await fetch(
      `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(igUrl)}`,
      { headers: BROWSER_HEADERS, timeout: 6000 }
    );
    if (!res.ok) return empty;
    const json: any = await res.json();
    return {
      author: json?.author_name ?? "",
      title: json?.title ?? "",
    };
  } catch {
    return empty;
  }
}

/**
 * Calls the downloader, retrying transient upstream failures, and returns the
 * `media` array. Throws once retries are exhausted.
 */
async function fetchInstagramMedia(
  igUrl: string,
  attempts = 3
): Promise<any[]> {
  let lastError = "Instagram API request failed";

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 400 * i));

    let apiRes;
    let responseText: string;
    try {
      apiRes = await fetch(
        `https://${IG_API_HOST}/convert?url=${encodeURIComponent(igUrl)}`,
        {
          headers: {
            "Content-Type": "application/json",
            "X-RapidAPI-Key": RAPIDAPI_KEY,
            "X-RapidAPI-Host": IG_API_HOST,
          },
          timeout: 45000,
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

    if (Array.isArray(json?.media)) return json.media;

    const status = Number(json?.code ?? apiRes.status);
    lastError = cleanUpstreamMessage(json?.message ?? json?.error);
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

/**
 * POST /api/instagram/preview
 * Body: { url: string }
 * Returns: PreviewResult
 *
 * Handles /p/ posts, carousels, /reel/ reels and /tv/ IGTV.
 * Upstream returns { media: [{ type, quality, thumbnail, url }] } — one entry
 * per carousel slide, and no caption or handle, which oembed supplies.
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
    // The caption and handle come from oembed, which costs no RapidAPI quota
    // and is allowed to fail — so run it alongside rather than before.
    const [media, meta] = await Promise.all([
      fetchInstagramMedia(url),
      fetchOembedMeta(url),
    ]);

    // A carousel returns one entry per slide, already one per item.
    const items: MediaItem[] = media
      .filter((m: any) => m?.url)
      .map((m: any, i: number) => {
        const isVideo = m.type === "video";
        return {
          id: `${shortcode}${i > 0 ? `_${i}` : ""}`,
          type: isVideo ? "video" : "image",
          // Images carry no separate thumbnail — the media URL is the preview.
          thumbnail: m.thumbnail || (!isVideo ? m.url : ""),
          downloadUrl: m.url,
          title:
            (meta.title || "").split("\n")[0].slice(0, 80) || `Item ${i + 1}`,
        } as MediaItem;
      });

    if (items.length === 0) {
      return res.status(404).json({
        error: "No downloadable media found in this post.",
      });
    }

    const result: PreviewResult = {
      platform: "instagram",
      author: meta.author || "Instagram",
      title: meta.title,
      thumbnail: items[0]?.thumbnail ?? "",
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

  try {
    // The same endpoint resolves story links, so the story URL goes straight
    // through. It returns the poster's whole active tray, not just the linked
    // story — the response carries no ids to narrow it by, so we show the tray.
    const media = await fetchInstagramMedia(url);

    const items: MediaItem[] = media
      .filter((m: any) => m?.url)
      .map((m: any, i: number) => ({
        id: `${username}_story_${i}`,
        type: m.type === "video" ? "video" : "image",
        thumbnail: m.thumbnail || (m.type !== "video" ? m.url : ""),
        downloadUrl: m.url,
        title: `Story ${i + 1}`,
      })) as MediaItem[];

    if (items.length === 0) {
      return res
        .status(404)
        .json({ error: "No downloadable media found in this story." });
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
    const message = err?.message ?? "Internal server error";
    console.error("[instagram/stories]", message);

    if (/exceeded the (monthly quota|rate limit)/i.test(message)) {
      return res
        .status(429)
        .json({ error: "Download limit reached. Please try again later." });
    }
    if (TRANSIENT_ERROR.test(message)) {
      return res.status(503).json({
        error: "Instagram is busy right now. Please try again in a moment.",
      });
    }
    return res.status(502).json({
      error: "Story not found. It may have expired or the account is private.",
    });
  }
});

export default router;
