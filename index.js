import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import admin from "firebase-admin";
import OpenAI from "openai";
import multer from "multer";
import pdfParse from "pdf-parse";
import { initRAG, getRAGContext, uploadDocumentToRAG } from "./rag.js";

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
  API_SECRET_ALLOW_BODY = "false",
  USE_RAG = "true"
} = process.env;

function normalizePrivateKey(raw) {
  let k = (raw ?? "").toString();

  // מסיר ציטוטים עוטפים אם הודבקו בטעות
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1);
  }

  // ממיר תווי \n/\\r לטורי שורה אמיתיים ומאחד סוגי שורות
  k = k.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
  k = k.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // מנקה רווחים בתחילת/סוף כל שורה
  k = k.split("\n").map(s => s.trim()).join("\n");

  // מבטיח כותרת/סיומת מדויקות ומסיר שורות ריקות כפולות
  k = k.replace(/^[-\s]*BEGIN\s+PRIVATE\s+KEY[-\s]*\n?/i, "-----BEGIN PRIVATE KEY-----\n");
  k = k.replace(/\n?[-\s]*END\s+PRIVATE\s+KEY[-\s]*$/i, "\n-----END PRIVATE KEY-----");
  k = k.replace(/\n{2,}/g, "\n");

  // שורה מסיימת כנדרש ע"י PEM
  if (!k.endsWith("\n")) k += "\n";
  return k;
}

const corsOptions = {
  origin: "https://lecturers-gpt-auth.web.app",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "authorization", "x-api-secret", "x-gpt-user-message"],
  credentials: true
};

const app = express();

// CORS middleware - מוסיף headers מפורשים
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://lecturers-gpt-auth.web.app");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, authorization, x-api-secret, x-gpt-user-message");
  res.header("Access-Control-Allow-Credentials", "true");
  
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

// הגדרת multer להעלאת קבצים
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"), false);
    }
  },
});

if (!OPENAI_API_KEY) console.warn("[WARN] Missing OPENAI_API_KEY");
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY)
  console.warn("[WARN] Missing Firebase ENV");

let firebaseApp;
try {
  const pk = normalizePrivateKey(FIREBASE_PRIVATE_KEY);
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
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// אתחול RAG
let ragEnabled = false;
if (USE_RAG.toLowerCase() === "true") {
  ragEnabled = initRAG(OPENAI_API_KEY, db);
  if (ragEnabled) {
    console.log("[OK] RAG enabled with Firestore");
  } else {
    console.warn("[WARN] RAG disabled - missing OpenAI API key or Firestore");
  }
}

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

app.get("/", (_req, res) => {
  res.json({ ok: true, status: "Lecturers GPT server is running" });
});

app.post("/api/ask", async (req, res) => {
  try {
    const rawEmail = (req.body?.email || "").trim().toLowerCase();
    const promptFromBody = (req.body?.prompt || "").trim();
    const promptFromHeader = (req.headers["x-gpt-user-message"] || "").trim();
    const prompt = promptFromBody || promptFromHeader;

    if (!rawEmail) return res.status(400).json({ error: "email is required" });
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    const bypass = BYPASS_AUTH.toLowerCase() === "true";

    if (!bypass) {
      const emailDomain = emailDomainOf(rawEmail);
      const allowedDomains = splitCsvLower(ALLOWED_DOMAINS || ALLOWED_DOMAIN || "");
      const allowedEmails = splitCsvLower(ALLOWED_EMAILS);
      
      const domainOk = allowedDomains.length
        ? allowedDomains.some(d => emailDomain === d || emailDomain.endsWith("." + d))
        : true;
      const listOk = allowedEmails.length ? allowedEmails.includes(rawEmail) : true;

      // אם המייל ברשימת ALLOWED_EMAILS, נדלג על בדיקת Firebase Auth
      const emailInWhitelist = allowedEmails.length && allowedEmails.includes(rawEmail);

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

      // בדיקת Firebase Auth רק אם המייל לא ברשימת ALLOWED_EMAILS
      if (!emailInWhitelist) {
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
    }

    const { first_login } = await checkAndMarkFirstLogin(rawEmail);

    // שאילתה ב-RAG אם מופעל
    let ragContext = null;
    if (ragEnabled) {
      try {
        ragContext = await getRAGContext(prompt, 3);
      } catch (e) {
        console.error("[RAG Query Error]", e);
        // ממשיכים גם אם RAG נכשל
      }
    }

    // בניית ה-prompt עם context מה-RAG
    let systemPrompt = "אתה עוזר סטטיסטיקה לסטודנטים. ענה על השאלות בצורה ברורה ומקצועית.";
    let userMessage = prompt;

    if (ragContext && ragContext.context) {
      systemPrompt = `אתה עוזר סטטיסטיקה לסטודנטים. השתמש במידע הבא מחומרי הקורס כדי לענות על השאלות בצורה מדויקת ומקצועית.

חומרי הקורס:
${ragContext.context}

אם המידע בחומרי הקורס לא רלוונטי לשאלה, השתמש בידע הכללי שלך.`;

      userMessage = `שאלה: ${prompt}`;
    }

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      temperature: 0.2
    });

    const answer = completion?.choices?.[0]?.message?.content?.trim() || "";

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
      first_login,
      rag_sources: ragContext?.sources || null
    });

  } catch (e) {
    console.error("[/api/ask error]", e);
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

// פונקציה עזר לבדיקת הרשאות
function checkUploadAuth(rawEmail, bypass) {
  if (bypass) return true;
  
  const emailDomain = emailDomainOf(rawEmail);
  const allowedDomains = splitCsvLower(ALLOWED_DOMAINS || ALLOWED_DOMAIN || "");
  const allowedEmails = splitCsvLower(ALLOWED_EMAILS);
  const emailInWhitelist = allowedEmails.length && allowedEmails.includes(rawEmail);
  const domainOk = allowedDomains.length
    ? allowedDomains.some(d => emailDomain === d || emailDomain.endsWith("." + d))
    : true;

  return emailInWhitelist || domainOk;
}

// Endpoint להעלאת חומרי קורס ל-RAG (טקסט או PDF)
app.post("/api/upload-course-material", upload.single("pdf"), async (req, res) => {
  try {
    const rawEmail = (req.body?.email || "").trim().toLowerCase();
    let text = (req.body?.text || "").trim();
    let source = (req.body?.source || "unknown").trim();
    const courseName = (req.body?.course_name || "statistics").trim();

    if (!rawEmail) return res.status(400).json({ error: "email is required" });
    if (!ragEnabled) return res.status(503).json({ error: "RAG is not enabled" });

    // בדיקת הרשאות
    const bypass = BYPASS_AUTH.toLowerCase() === "true";
    if (!checkUploadAuth(rawEmail, bypass)) {
      return res.status(403).json({ error: "Email not authorized" });
    }

    // עיבוד PDF אם הועלה קובץ
    if (req.file && req.file.mimetype === "application/pdf") {
      try {
        const pdfData = await pdfParse(req.file.buffer);
        text = pdfData.text;
        if (!source || source === "unknown") {
          source = req.file.originalname || "uploaded.pdf";
        }
        console.log(`[PDF] Extracted ${text.length} characters from PDF: ${source}`);
      } catch (pdfError) {
        console.error("[PDF Parse Error]", pdfError);
        return res.status(400).json({ error: "Failed to parse PDF", details: String(pdfError) });
      }
    }

    // בדיקה שיש טקסט לעיבוד
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: "text is required (or upload a PDF file)" });
    }

    // העלאת הטקסט ל-RAG
    const result = await uploadDocumentToRAG(text, {
      source,
      course_name: courseName,
      uploaded_by: rawEmail,
      uploaded_at: new Date().toISOString(),
      file_type: req.file ? "pdf" : "text",
    });

    // לוג ב-Firestore
    if (db) {
      await db.collection("course_materials").add({
        email: rawEmail,
        source,
        course_name: courseName,
        text_length: text.length,
        chunks_count: result.chunksCount,
        file_type: req.file ? "pdf" : "text",
        ts: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return res.json({ 
      success: true, 
      chunks_count: result.chunksCount,
      message: `Uploaded ${result.chunksCount} chunks to RAG database`,
      source: source,
      file_type: req.file ? "pdf" : "text"
    });

  } catch (e) {
    console.error("[/api/upload-course-material error]", e);
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[OK] Server listening on port ${PORT}`);
});