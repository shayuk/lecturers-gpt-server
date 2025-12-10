import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import admin from "firebase-admin";
import OpenAI from "openai";

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;

const {
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
  API_SECRET_ALLOW_BODY = "false"
} = process.env;

// ---------- CORS ----------
const corsOptions = {
  origin: "https://lecturers-gpt-auth.web.app", // התאמה ל-Firebase שלך
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "authorization", "x-api-secret"]
};

const app = express();
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(bodyParser.json({ limit: "2mb" }));

// ---------- WARNINGS ----------
if (!OPENAI_API_KEY) console.warn("[WARN] Missing OPENAI_API_KEY");
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY)
  console.warn("[WARN] Missing Firebase ENV");

// ---------- FIREBASE ----------
let firebaseApp;
try {
  const pk = FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: pk,
    }),
  });
  console.log("[OK] Firebase initialized:", FIREBASE_PROJECT_ID);
} catch (e) {
  console.error("[Firebase Init Error]", e);
}
const db = admin.apps.length ? admin.firestore() : null;

// ---------- OPENAI ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- HELPERS ----------
function splitCsvLower(v) {
  return (v || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}
function emailDomainOf(email) {
  const at = email.indexOf("@");
  return at > -1 ? email.slice(at + 1).toLowerCase() : "";
}
async function checkAndMarkFirstLogin(rawEmail) {
  if (!db) return { first_login: false };
  const email = rawEmail.toLowerCase();
  const ref = db.collection("user_profiles").doc(email);
  const snap = await ref.get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  if (!snap.exists) {
    await ref.set({ email, created_at: now, last_login_at: now, first_login_seen: false });
    return { first_login: true };
  } else {
    await ref.update({ last_login_at: now });
    return { first_login: false };
  }
}

// ---------- HEALTH CHECK ----------
app.get("/", (_req, res) => {
  res.json({ ok: true, status: "Lecturers GPT server is running" });
});

// ---------- MAIN ROUTE ----------
app.post("/api/ask", async (req, res) => {
  try {
    const rawEmail = (req.body?.email || "").trim().toLowerCase();
    const promptFromBody = (req.body?.prompt || "").trim();
    const promptFromHeader = (req.headers["x-gpt-user-message"] || "").trim();
    const prompt = promptFromBody || promptFromHeader;

    if (!rawEmail) return res.status(400).json({ error: "email is required" });
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    const bypass = BYPASS_AUTH.toLowerCase() === "true";

    // ----- Domain check -----
    if (!bypass) {
      const emailDomain = emailDomainOf(rawEmail);
      const allowedDomains = splitCsvLower(ALLOWED_DOMAINS || ALLOWED_DOMAIN || "");
      const domainOk = allowedDomains.length
        ? allowedDomains.some(d => emailDomain === d || emailDomain.endsWith("." + d))
        : true;

      const allowedEmails = splitCsvLower(ALLOWED_EMAILS);
      const listOk = allowedEmails.length ? allowedEmails.includes(rawEmail) : true;

      if (!domainOk && !listOk) {
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
        return res.status(403).json({ error: "Email not authorized (domain/list)" });
      }
    }

    // ----- Firebase Auth Check -----
    if (!bypass) {
      if (!admin.apps.length) return res.status(500).json({ error: "Firebase not initialized" });
      try {
        const user = await admin.auth().getUserByEmail(rawEmail);
        const rolesEnv = splitCsvLower(process.env.ALLOWED_ROLES || process.env.REQUIRED_ROLE || "");
        const userRole = ((user.customClaims && user.customClaims.role) || "").toLowerCase();
        if (rolesEnv.length && !rolesEnv.includes(userRole)) {
          if (db) {
            await db.collection("security_logs").add({
              type: "forbidden_role",
              email: rawEmail,
              role: userRole || null,
              allowedRoles: rolesEnv,
              ts: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
          return res.status(403).json({ error: "Role not authorized" });
        }
      } catch (err) {
        if (db) {
          await db.collection("security_logs").add({
            type: "auth_not_found",
            email: rawEmail,
            ts: admin.firestore.FieldValue.serverTimestamp(),
            err: String(err),
          });
        }
        return res.status(403).json({ error: "Email not authorized" });
      }
    }

    const { first_login } = await checkAndMarkFirstLogin(rawEmail);

    // ----- OpenAI call -----
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    });

    const answer = completion?.choices?.[0]?.message?.content?.trim() || "";

    // ----- Logging -----
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

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`[OK] Server listening on port ${PORT}`);
});
