import express from "express";
import crypto from "crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GATEWAY_API_KEY;

if (!API_KEY) {
  console.error("Missing env var: GATEWAY_API_KEY");
  process.exit(1);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function requireApiKey(req, res, next) {
  const key = req.header("x-api-key");
  if (!safeEqual(key, API_KEY)) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

// Namecheap defaults (preconfigured)
function cfg(overrides = {}) {
  return {
    imapHost: "mail.privateemail.com",
    imapPort: overrides.imapPort ?? 993,
    imapSecure: overrides.imapSecure ?? true, // SSL/TLS
    smtpHost: overrides.smtpHost ?? "mail.privateemail.com",
    smtpPort: overrides.smtpPort ?? 465,
    smtpSecure: overrides.smtpSecure ?? true // SSL/TLS
  };
}

app.get("/health", (_req, res) => res.json({ ok: true }));

async function testImap({ email, password, advanced }) {
  const c = cfg(advanced || {});
  const client = new ImapFlow({
    host: c.imapHost,
    port: c.imapPort,
    secure: c.imapSecure,
    auth: { user: email, pass: password },
    logger: false
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    lock.release();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    try { await client.logout(); } catch {}
  }
}

async function testSmtp({ email, password, advanced, smtpHostOverride }) {
  const c = cfg({ ...(advanced || {}), smtpHost: smtpHostOverride ?? undefined });
  const transport = nodemailer.createTransport({
    host: c.smtpHost,
    port: c.smtpPort,
    secure: c.smtpSecure,
    auth: { user: email, pass: password }
  });
  try {
    await transport.verify();
    return { ok: true, smtpHost: c.smtpHost };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), smtpHost: c.smtpHost };
  }
}

app.post("/test", requireApiKey, async (req, res) => {
  const { email, password, advanced } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: "Missing email/password" });

  const imap = await testImap({ email, password, advanced });

  let smtp = await testSmtp({ email, password, advanced });

  // SMTP fallback host
  if (!smtp.ok) {
    const fallback = await testSmtp({ email, password, advanced, smtpHostOverride: "smtp.privateemail.com" });
    if (fallback.ok) smtp = fallback;
  }

  res.json({ ok: imap.ok && smtp.ok, imap, smtp });
});

app.post("/sync", requireApiKey, async (req, res) => {
  const { email, password, cursor, backfillDays = 14, limit = 50, advanced } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: "Missing email/password" });

  const c = cfg(advanced || {});
  const client = new ImapFlow({
    host: c.imapHost,
    port: c.imapPort,
    secure: c.imapSecure,
    auth: { user: email, pass: password },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      let uids = [];
      if (cursor) {
        uids = await client.search({ uid: `${Number(cursor) + 1}:*` });
      } else {
        const since = new Date(Date.now() - backfillDays * 24 * 60 * 60 * 1000);
        uids = await client.search({ since });
      }

      uids.sort((a, b) => b - a);
      uids = uids.slice(0, Number(limit));
      uids.sort((a, b) => a - b);

      const messages = [];
      let maxUid = cursor ? Number(cursor) : 0;

      for await (const msg of client.fetch(uids, { uid: true, envelope: true, source: true, flags: true })) {
        maxUid = Math.max(maxUid, msg.uid);
        const parsed = await simpleParser(msg.source);

        const subject = parsed.subject || msg.envelope?.subject || "(no subject)";
        const fromEmail =
          parsed.from?.value?.[0]?.address ||
          msg.envelope?.from?.[0]?.address ||
          "";

        const snippet = (parsed.text || subject || "").replace(/\s+/g, " ").trim().slice(0, 240);
        const bodyText = (parsed.text || "").slice(0, 20000);
        const bodyHtml = (parsed.html || "").toString().slice(0, 20000);

        const messageId = parsed.messageId || "";
        const inReplyTo = parsed.inReplyTo || "";
        const references = Array.isArray(parsed.references) ? parsed.references : (parsed.references ? [parsed.references] : []);

        const externalThreadKey = crypto
          .createHash("sha256")
          .update((references.join(" ") || inReplyTo || messageId || subject) + "|" + fromEmail)
          .digest("hex");

        messages.push({
          externalThreadKey,
          messageId,
          inReplyTo,
          references,
          subject,
          fromEmail,
          date: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
          flags: msg.flags || [],
          snippet,
          bodyText,
          bodyHtml
        });
      }

      res.json({ ok: true, cursor: maxUid, messages });
    } finally {
      lock.release();
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    try { await client.logout(); } catch {}
  }
});

app.post("/send", requireApiKey, async (req, res) => {
  const { fromEmail, password, to, cc, subject, bodyText, bodyHtml, headers = {}, advanced } = req.body || {};
  if (!fromEmail || !password || !to || !subject || (!bodyText && !bodyHtml)) {
    return res.status(400).json({ ok: false, error: "Missing required fields" });
  }

  async function trySend(host) {
    const c = cfg({ ...(advanced || {}), smtpHost: host });
    const transport = nodemailer.createTransport({
      host: c.smtpHost,
      port: c.smtpPort,
      secure: c.smtpSecure,
      auth: { user: fromEmail, pass: password }
    });

    const info = await transport.sendMail({
      from: fromEmail,
      to,
      cc,
      subject,
      text: bodyText,
      html: bodyHtml,
      headers
    });

    return { ok: true, messageId: info.messageId, usedHost: c.smtpHost };
  }

  try {
    try {
      return res.json(await trySend("mail.privateemail.com"));
    } catch {
      return res.json(await trySend("smtp.privateemail.com"));
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`DERSTY Email Gateway running on ${PORT}`));
