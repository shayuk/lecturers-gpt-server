// index.js
// --------
// שרת ביניים ל-GPTs: אימות מייל בפיירבייס, קריאה ל-OpenAI, ולוגים ל-Firestore.
// נוספה תמיכה ב-first_login: דגל שמוחזר true בפעם הראשונה שמשתמש מאומת נכנס.

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
  API_SECRET,                       // אם נגדיר, השרת ידרוש Header x-api-secret זהה
  API_SECRET_ALLOW_BODY = "false"
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

// ---------- FIRESTORE ----------
const db = admin.apps.length ? admin.firestore() : null;

// ---------- OPENAI ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- APP ----------
const app = express();

// ✅ CORS מוגדר בצורה מפורשת, כולל OPTIONS
const corsOptions = {
  // אפשר להחליף אח"כ לכתובת הפרודקשן, למשל:
  // origin: "https://galibot-ui.web.app",
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "authorization", "x-api-secret"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // לטפל בכל בקשות ה-OPTIONS

app.use(bodyParser.json({ limit: "2mb" }));

// הגנה אופציונלית עם סיקרט: פועלת רק אם API_SECRET הוגדר
app.use((req, res, next) => {
  if (!API_SECRET) return next();

  // ⚠ חשוב: לא לחסום בקשות OPTIONS (preflight)
  if (req.method === "OPTIONS") {
    return next();
  }

  const gotHeader = req.headers["x-api-secret"];
  const authHeader = (req.headers["authorization"] || "").toString();
  const bearerPrefix = "bearer ";
  const ah = authHeader.trim();
  const bearer = ah.toLowerCase().startsWith(bearerPrefix)
    ? ah.slice(bearerPrefix.length)
    : "";
  const allowBody = API_SECRET_ALLOW_BODY.toLowerCase() === "true";
  const bodyToken = allowBody ? (req.body?.api_secret || "") : "";
  const queryToken = allowBody ? (req.query?.api_secret || "") : "";
  const token = (gotHeader || bearer || bodyToken || queryToken || "").toString().trim();
  if (!token || token !== API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
});

// בריאות
app.get("/", (_req, res) => {
  res.json({ ok: true, status: "Lecturers GPT server is up" });
});

// --------- עזר: אימות מייל מותר ----------
function splitCsvLower(v) {
  return (v || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}
function emailDomainOf(email) {
  const at = email.indexOf("@");
  return at > -1 ? email.slice(at + 1).toLowerCase() : "";
}

// --------- עזר: first_login ----------
async function checkAndMarkFirstLogin(rawEmail) {
  if (!db) return { first_login: false };
  const email = rawEmail.toLowerCase();
  const ref = db.collection("user_profiles").doc(email);
  const snap = await ref.get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  if (!snap.exists) {
    await ref.set({
      email,
      created_at: now,
      last_login_at: now,
      first_login_seen: false
    });
    return { first_login: true };
  } else {
    await ref.update({ last_login_at: now });
    return { first_login: false };
  }
}

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
      const emailDomain = emailDomainOf(rawEmail);
      const allowedDomains = splitCsvLower(ALLOWED_DOMAINS || ALLOWED_DOMAIN || "");
      const domainOk = allowedDomains.length
        ? allowedDomains.some(d => emailDomain === d || emailDomain.endsWith("." + d))
        : true;

      const allowedEmails = splitCsvLower(ALLOWED_EMAILS);
      const listOk = allowedEmails.length ? allowedEmails.includes(rawEmail) : true;

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

    // 2) אימות קיום משתמש ב-Firebase Authentication
    if (!bypass) {
      if (!admin.apps.length) {
        return res.status(500).json({ error: "Firebase not initialized" });
      }
      try {
        const user = await admin.auth().getUserByEmail(rawEmail);
        const rolesEnv = splitCsvLower(process.env.ALLOWED_ROLES || process.env.REQUIRED_ROLE || "");
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

    // --- בדיקת first_login (חדש) ---
    const { first_login } = await checkAndMarkFirstLogin(rawEmail);

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
          first_login,
          ts: admin.firestore.FieldValue.serverTimestamp(),
          meta: req.body?.meta || null
        });
      }
    } catch (_) {}

    return res.json({
      answer,
      usage: completion?.usage || null,
      model: completion?.model || OPENAI_MODEL,
      first_login
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
