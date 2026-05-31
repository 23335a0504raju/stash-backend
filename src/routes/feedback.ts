import { Router, type Request, type Response } from "express";
import nodemailer from "nodemailer";

const router = Router();

// ─── Resend (HTTP API — preferred in production) ────────────────────────────────
// Render's free tier BLOCKS outbound SMTP (ports 25/465/587), so nodemailer's
// connection to smtp.gmail.com hangs forever and feedback never sends. Resend
// delivers over HTTPS (443), which is not blocked. Set these in the Render env:
//   RESEND_API_KEY=re_xxx
//   RESEND_FROM="Stash Feedback <feedback@yourdomain.com>"  (or onboarding@resend.dev to test)
//   EMAIL_TO=youremail@gmail.com
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_FROM =
  process.env.RESEND_FROM ?? "Stash Feedback <onboarding@resend.dev>";

// ─── Gmail SMTP (fallback — works locally, NOT on Render free tier) ──────────────
const EMAIL_FROM = process.env.EMAIL_FROM ?? "";
const EMAIL_PASS = process.env.EMAIL_PASS ?? "";
const EMAIL_TO   = process.env.EMAIL_TO   ?? "";

/**
 * POST /api/feedback
 * Body: { rating: number, category: string, message: string, email?: string }
 *
 * Delivery: prefers Resend's HTTP API (works on Render); falls back to Gmail SMTP
 * for local dev. SMTP is given short timeouts so it fails fast instead of hanging
 * the request (and the app's "Sending…" button) when the port is blocked.
 */
router.post("/", async (req: Request, res: Response) => {
  const { rating, category, message, email } = req.body as {
    rating?: number;
    category?: string;
    message?: string;
    email?: string;
  };

  if (!message?.trim()) {
    return res.status(400).json({ error: "message is required" });
  }
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "rating must be 1–5" });
  }

  const stars = "⭐".repeat(Math.max(1, Math.min(5, rating)));
  const categoryLabel = (category ?? "feedback").toUpperCase();
  const recipient = EMAIL_TO;

  const subject = `[Stash] ${stars} ${categoryLabel} — ${email?.trim() || "anonymous"}`;
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#f8f4ff;border-radius:12px">
      <h2 style="color:#6B21A8;margin:0 0 16px">📬 New Stash Feedback</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
        <tr><td style="padding:6px 0;color:#555;width:120px">Rating</td><td><b>${stars} (${rating}/5)</b></td></tr>
        <tr><td style="padding:6px 0;color:#555">Category</td><td><b>${category ?? "—"}</b></td></tr>
        <tr><td style="padding:6px 0;color:#555">User email</td><td>${email?.trim() || "<i>not provided</i>"}</td></tr>
      </table>
      <div style="background:#fff;border-radius:8px;padding:16px;white-space:pre-wrap;font-size:15px;line-height:1.6">${message}</div>
      <p style="margin-top:16px;font-size:12px;color:#999">Sent from Stash app</p>
    </div>
  `;
  const text = `Rating: ${rating}/5\nCategory: ${category}\nFrom: ${email || "anonymous"}\n\n${message}`;

  // ─── Path 1: Resend HTTP API (preferred) ──────────────────────────────────────
  if (RESEND_API_KEY && recipient) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: RESEND_FROM,
          to: [recipient],
          reply_to: email?.trim() || undefined,
          subject,
          html,
          text,
        }),
        // Hard cap so a stuck request can never hang the app's "Sending…" spinner.
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        console.error(`[feedback] Resend failed ${r.status}: ${body}`);
        return res
          .status(502)
          .json({ error: "Couldn't send feedback right now. Please try again." });
      }
      console.log(`[feedback] Sent via Resend — ${rating}★ ${category} from ${email || "anon"}`);
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[feedback] Resend error:", err?.message);
      return res
        .status(502)
        .json({ error: "Couldn't send feedback right now. Please try again." });
    }
  }

  // ─── Path 2: Gmail SMTP fallback (local dev) ───────────────────────────────────
  if (EMAIL_FROM && EMAIL_PASS && recipient) {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL_FROM, pass: EMAIL_PASS },
      // Fail fast instead of hanging if SMTP egress is blocked (e.g. Render free tier).
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    try {
      await transporter.sendMail({
        from: `"Stash Feedback" <${EMAIL_FROM}>`,
        to: recipient,
        replyTo: email?.trim() || undefined,
        subject,
        html,
        text,
      });
      console.log(`[feedback] Sent via SMTP — ${rating}★ ${category} from ${email || "anon"}`);
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[feedback] SMTP send failed:", err?.message);
      return res.status(502).json({
        error:
          "Couldn't send feedback right now. (SMTP may be blocked on this host — set RESEND_API_KEY.)",
      });
    }
  }

  // ─── No delivery configured ────────────────────────────────────────────────────
  console.warn(
    "[feedback] No email delivery configured (set RESEND_API_KEY + EMAIL_TO, or EMAIL_FROM/PASS/TO) — feedback NOT emailed.",
  );
  // Still 200 so the UI doesn't error; feedback is just not emailed yet.
  return res.json({ ok: true, note: "Email not configured on server" });
});

export default router;
