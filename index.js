// index.js
// --------
// שרת ביניים ל-GPTs: אימות מייל בפיירבייס, קריאה ל-OpenAI, ולוגים ל-Firestore.

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import admin from "firebase-admin";
import OpenAI from "openai";

// ---------- ENV ----------
const {
  PORT = 3000,
  // OpenAI
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",

  // Firebase Admin (אותו פרויקט של Authentication עם המשתמשים!)
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,

  // Gating + דיבוג
  BYPASS_AUTH = "false",            // "true" רק לבדיקה
  ALLOWED_DOMAIN,                   // לדוגמה: "ariel.ac.il"
  ALLOWED_DOMAINS,
  ALLOWED_EMAILS,                   // לדוגמה: "a@b.com,c@d.com"
  API_SECRET                        // אם נגדיר, השרת ידרוש Header x-api-secret זהה
} = process.env;

// ---------- BASIC VALIDATION ----------
if (!OPENAI_API_KEY) {
  console.warn("[WARN] OPENAI_API_KEY is missing. /api/ask will fail until you set it.");
}
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  console.warn("[WARN] Firebase Admin ENV is missing. Auth checks will fail.");
}

// ---------- FIREBASE ADMIN INIT ----------
let firebaseApp;
try {
  // Render/ENV מדביקים private_key עם \n כתווים, מחזירים לשורות אמיתיות:
  const pk = FIREBASE_PRIVATE_KEY
    ? FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined;

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: pk,
    }),
  });
  console.log("[OK] Firebase Admin initialized for project:", FIREBASE_PROJECT_ID);
} catch (e) {
  console.error("[Firebase Admin init error]", e);
}

// ---------- FIRESTORE (אופציונלי) ----------
const db = admin.apps.length ? admin.firestore() : null;

// ---------- OPENAI ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- APP ----------
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));

// הגנה אופציונלית עם סיקרט: פועלת רק אם API_SECRET הוגדר
app.use((req, res, next) => {
  if (!API_SECRET) return next();
  const got = req.headers["x-api-secret"];
  if (!got || got !== API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
});

// בריאות
app.get("/", (_req, res) => {
  res.json({ ok: true, status: "Lecturers GPT server is up" });
});

// הנתיב המרכזי
app.post("/api/ask", async (req, res) => {
  try {
    const rawEmail = (req.body?.email || "").toString().trim().toLowerCase();

    // prompt מה-Body או מה-Header (Fallback):
    const promptFromBody = (req.body?.prompt || "").toString().trim();
    const promptFromHeader = (req.headers["x-gpt-user-message"] || "").toString().trim();
    const prompt = promptFromBody || promptFromHeader;

    if (!rawEmail) {
      return res.status(400).json({ error: "email is required" });
    }
    if (!prompt) {
      return res.status(400).json({ error: "prompt is required" });
    }

    // --- אימות / ניתוב ---
    const bypass = BYPASS_AUTH.toLowerCase() === "true";

    // 1) סינון דומיין / רשימה מפורשת
    if (!bypass) {
      const emailDomain = rawEmail.split("@")[1] || "";
      const allowedDomains = (
        (ALLOWED_DOMAINS || ALLOWED_DOMAIN || "")
      )
        .split(",")
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);

      const domainOk = allowedDomains.length
        ? allowedDomains.some(d => emailDomain === d || emailDomain.endsWith("." + d))
        : true;

      const listOk = ALLOWED_EMAILS
        ? ALLOWED_EMAILS.split(",").map(s => s.trim().toLowerCase()).includes(rawEmail)
        : true;

      if (!domainOk && !listOk) {
        // לוג אבטחה best-effort
        try {
          if (db) {
            await db.collection("security_logs").add({
              type: "blocked_email",
              email: rawEmail,
              reason: "not in allowed domain/emails",
              ts: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        } catch (_) {}
        return res.status(403).json({ error: "Email not authorized (domain/list)" });
      }
    }

    // 2) אימות קיום משתמש ב-Firebase Authentication
    if (!bypass) {
      if (!admin.apps.length) {
        return res.status(500).json({ error: "Firebase not initialized" });
      }
      try {
        await admin.auth().getUserByEmail(rawEmail);
      } catch (err) {
        try {
          if (db) {
            await db.collection("security_logs").add({
              type: "auth_not_found",
              email: rawEmail,
              ts: admin.firestore.FieldValue.serverTimestamp(),
              err: String(err),
            });
          }
        } catch (_) {}
        return res.status(403).json({ error: "Email not authorized" });
      }
    }

    // --- קריאה ל-OpenAI ---
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    });

    const answer =
      completion?.choices?.[0]?.message?.content?.trim() || "";

    // --- לוג שימוש (best-effort) ---
    try {
      if (db) {
        await db.collection("usage_logs").add({
          email: rawEmail,
          model: completion?.model || OPENAI_MODEL,
          tokens_prompt: completion?.usage?.prompt_tokens ?? null,
          tokens_completion: completion?.usage?.completion_tokens ?? null,
          tokens_total: completion?.usage?.total_tokens ?? null,
          ts: admin.firestore.FieldValue.serverTimestamp(),
          meta: req.body?.meta || null
        });
      }
    } catch (_) {}

    return res.json({
      answer,
      usage: completion?.usage || null,
      model: completion?.model || OPENAI_MODEL
    });
  } catch (e) {
    console.error("[/api/ask error]", e);
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

// הפעלה
app.listen(PORT, () => {
  console.log(`[OK] Server listening on port ${PORT}`);
});
