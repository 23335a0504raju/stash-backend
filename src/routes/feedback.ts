import { Router, type Request, type Response } from "express";
import nodemailer from "nodemailer";

const router = Router();

const EMAIL_FROM = process.env.EMAIL_FROM ?? "";
const EMAIL_PASS = process.env.EMAIL_PASS ?? "";
const EMAIL_TO   = process.env.EMAIL_TO   ?? "";

/**
 * POST /api/feedback
 * Body: { rating: number, category: string, message: string, email?: string }
 * Emails feedback to EMAIL_TO using Gmail SMTP (nodemailer).
 *
 * Required env vars in stash-backend/.env:
 *   EMAIL_FROM=yourgmail@gmail.com
 *   EMAIL_PASS=xxxx xxxx xxxx xxxx   ← Google App Password (16 chars)
 *   EMAIL_TO=yourpersonal@email.com
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

  if (!EMAIL_FROM || !EMAIL_PASS || !EMAIL_TO) {
    console.warn("[feedback] EMAIL_FROM / EMAIL_PASS / EMAIL_TO not set in .env — feedback NOT emailed.");
    // Still 200 so the UI doesn't show an error; feedback is just not emailed yet.
    return res.json({ ok: true, note: "Email not configured on server" });
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_FROM, pass: EMAIL_PASS },
  });

  const stars = "⭐".repeat(Math.max(1, Math.min(5, rating)));
  const categoryLabel = (category ?? "feedback").toUpperCase();
  const fromLine = email?.trim() ? `<b>From:</b> ${email}` : "<b>From:</b> anonymous";

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

  try {
    await transporter.sendMail({
      from: `"Stash Feedback" <${EMAIL_FROM}>`,
      to: EMAIL_TO,
      subject: `[Stash] ${stars} ${categoryLabel} — ${email?.trim() || "anonymous"}`,
      html,
      text: `Rating: ${rating}/5\nCategory: ${category}\nFrom: ${email || "anonymous"}\n\n${message}`,
    });
    console.log(`[feedback] Email sent — ${rating}★ ${category} from ${email || "anon"}`);
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("[feedback] Email send failed:", err.message);
    return res.status(500).json({
      error: "Failed to send email. Check EMAIL_FROM / EMAIL_PASS / EMAIL_TO in .env",
    });
  }
});

export default router;
