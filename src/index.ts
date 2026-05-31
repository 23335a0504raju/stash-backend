import "dotenv/config";
import express from "express";
import cors from "cors";
import instagramRouter from "./routes/instagram";
import youtubeRouter from "./routes/youtube";
import feedbackRouter from "./routes/feedback";

const app = express();
const PORT = parseInt(process.env.PORT ?? "4000");

// ─── Middleware ───────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      // Always allow any localhost / 127.0.0.1 origin in dev
      if (
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:") ||
        origin.startsWith("exp://")
      ) {
        return callback(null, true);
      }
      // Check explicit allow-list for production origins
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0", timestamp: new Date().toISOString() });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/instagram", instagramRouter);
app.use("/api/youtube", youtubeRouter);
app.use("/api/feedback", feedbackRouter);

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n🚀 Stash Backend running at http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Instagram API: POST http://localhost:${PORT}/api/instagram/preview`);
  console.log(`   YouTube API:   POST http://localhost:${PORT}/api/youtube/preview`);
  console.log(`   Feedback API:  POST http://localhost:${PORT}/api/feedback`);
  if (!process.env.RAPIDAPI_KEY || process.env.RAPIDAPI_KEY === "your_rapidapi_key_here") {
    console.warn("\n⚠️  RAPIDAPI_KEY is not set. Add it to stash-backend/.env\n");
  }
});

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────
// Ensures port 4000 is released before ts-node-dev spawns the new process.
// Without this, Windows holds the port open → EADDRINUSE on every hot-reload.
function shutdown(signal: string) {
  console.log(`\n[${signal}] Closing server gracefully…`);
  server.close(() => {
    console.log("Server closed. Port released.");
    process.exit(0);
  });
  // Hard-kill after 3s in case connections are hanging
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

