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
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,
  BYPASS_AUTH = "false",
  ALLOWED_DOMAIN,
  ALLOWED_DOMAINS,
  ALLOWED_EMAILS,
  API_SECRET,
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

// ✅ עדכון כאן — תומך גם ב־Authorization: Bearer
app.use((req, res, next) => {
  if (!API_SECRET) return next();

  const gotHeader = req.headers["x-api-secret"];
  const authHeader = req.headers["authorization"];
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  const passed = gotHeader === API_SECRET || bearer === API_SECRET;

  if (!passed) {
    return res.status(401).json({
      error: "Unauthorized",
      hint: "Missing or incorrect API_SECRET (x-api-secret or Authorization: Bearer)",
    });
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
    const promptFromBody = (req.body?.prompt || "").toString().trim();
    const promptFromHeader = (req.headers["x-gpt-user-message"] || "").toString().trim();
    const prompt = promptFromBody || promptFromHeader;

    if (!rawEmail) return res.status(400).json({ error: "email is required" });
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    const bypass = BYPASS_AUTH.toLowerCase() === "true";

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
        try {
          if (db) {
            await db.collection("security_logs").add({
              type: "forbidden_domain",
              email: rawEmail,
              emailDomain,
              allowedDomains,
              domainOk,
              listOk,
              ts: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        } catch (_) {}
        return res.status(403).json({ error: "Email not authorized (domain/list)" });
      }
    }

    if (!bypass) {
      if (!admin.apps.length) {
        return res.status(500).json({ error: "Firebase not initialized" });
      }
      try {
        const user = await admin.auth().getUserByEmail(rawEmail);
        const rolesEnv = (
          (process.env.ALLOWED_ROLES || process.env.REQUIRED_ROLE || "")
        )
          .split(",")
          .map(s => s.trim().toLowerCase())
          .filter(Boolean);

        if (rolesEnv.length) {
          const userRole = ((user.customClaims && user.customClaims.role) || "").toLowerCase();
          const roleOk = rolesEnv.includes(userRole);
          if (!roleOk) {
            try {
              if (db) {
                await db.collection("security_logs").add({
                  type: "forbidden_role",
                  email: rawEmail,
                  role: userRole || null,
                  allowedRoles: rolesEnv,
                  ts: admin.firestore.FieldValue.serverTimestamp(),
                });
              }
            } catch (_) {}
            return res.status(403).json({ error: "Role not authorized" });
          }
        }
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

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    });

    const answer =
      completion?.choices?.[0]?.message?.content?.trim() || "";

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
