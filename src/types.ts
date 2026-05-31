// ─── Shared Types ──────────────────────────────────────────────────────────────
// Used by both routes. Keep in sync with frontend types.

export interface MediaItem {
  id: string;
  type: "video" | "image";
  thumbnail: string;
  downloadUrl: string;
  title: string;
  sizeMb?: number;
  duration?: string;
}

export interface YoutubeQuality {
  label: string;
  itag: number;
  downloadUrl: string;
}

export interface PreviewResult {
  platform: "instagram" | "youtube";
  author: string;
  title: string;
  thumbnail: string;
  items: MediaItem[];
  qualities?: YoutubeQuality[];
}

export interface ApiError {
  error: string;
}
