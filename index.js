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
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

// הגדרת multer להעלאת קבצים
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 50 * 1024 * 1024, // 50MB per file
    files: 3 // מקסימום 3 קבצים בכל בקשה
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"), false);
    }
  },
});

// Error handler ל-multer - צריך להיות middleware נפרד
const handleMulterError = (err, req, res, next) => {
  if (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File too large. Maximum size is 50MB per file" });
      }
      if (err.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({ error: "Too many files. Maximum is 3 files per request" });
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({ error: "Unexpected file field. Use 'pdf' field name" });
      }
      return res.status(400).json({ error: "File upload error", details: err.message });
    }
    // שגיאת fileFilter
    if (err.message && err.message.includes("Only PDF files")) {
      return res.status(400).json({ error: "Only PDF files are allowed" });
    }
    return res.status(400).json({ error: err.message || "File upload error" });
  }
  next();
};

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

// הגנה מפני בקשות כפולות - מטפל רק בבקשה אחת לכל קובץ בכל זמן
const processingFiles = new Set();

// אתחול RAG
let ragEnabled = false;
try {
  if (USE_RAG.toLowerCase() === "true") {
    ragEnabled = initRAG(OPENAI_API_KEY, db);
    if (ragEnabled) {
      console.log("[OK] RAG enabled with Firestore");
    } else {
      console.warn("[WARN] RAG disabled - missing OpenAI API key or Firestore");
    }
  }
} catch (ragInitError) {
  console.error("[RAG Init Error]", ragInitError);
  console.warn("[WARN] Continuing without RAG due to initialization error");
  ragEnabled = false;
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

    // שאילתה ב-RAG אם מופעל (עם timeout)
    let ragContext = null;
    if (ragEnabled) {
      const ragStartTime = Date.now();
      try {
        console.log(`[Ask] Querying RAG for prompt: "${prompt.substring(0, 50)}..."`);
        
        // Promise עם timeout של 20 שניות - מספיק זמן לשאילתה
        const ragPromise = getRAGContext(prompt, 5);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("RAG query timeout")), 20000)
        );
        
        ragContext = await Promise.race([ragPromise, timeoutPromise]);
        
        const duration = ((Date.now() - ragStartTime) / 1000).toFixed(2);
        
        if (ragContext && ragContext.context) {
          console.log(`[Ask] RAG found ${ragContext.chunksCount} relevant chunks in ${duration}s`);
        } else {
          console.log(`[Ask] RAG returned no context after ${duration}s`);
        }
      } catch (e) {
        const duration = ((Date.now() - ragStartTime) / 1000).toFixed(2);
        if (e.message === "RAG query timeout") {
          console.warn(`[RAG] Query timed out after ${duration}s - continuing without RAG context`);
        } else {
          console.error(`[RAG Query Error] after ${duration}s:`, e.message);
        }
        // ממשיכים גם אם RAG נכשל - הבוט יעבוד בלי RAG
        ragContext = null;
      }
    } else {
      console.log("[Ask] RAG is disabled");
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

// Endpoint להעלאת חומרי קורס ל-RAG (טקסט או PDF - תמיכה בכמה קבצים)
// מקסימום 3 קבצים בכל בקשה כדי למנוע עומס זיכרון
app.post("/api/upload-course-material", upload.array("pdf", 3), handleMulterError, async (req, res) => {
  try {
    console.log("[Upload] Request received", {
      hasFiles: !!req.files,
      filesCount: req.files?.length || 0,
      hasText: !!req.body?.text,
      email: req.body?.email,
    });

    const rawEmail = (req.body?.email || "").trim().toLowerCase();
    let text = (req.body?.text || "").trim();
    const courseName = (req.body?.course_name || "statistics").trim();

    if (!rawEmail) return res.status(400).json({ error: "email is required" });
    if (!ragEnabled) return res.status(503).json({ error: "RAG is not enabled" });

    // בדיקת הרשאות
    const bypass = BYPASS_AUTH.toLowerCase() === "true";
    if (!checkUploadAuth(rawEmail, bypass)) {
      return res.status(403).json({ error: "Email not authorized" });
    }

    const results = [];
    const errors = [];

    // עיבוד קבצי PDF אם הועלו
    if (req.files && req.files.length > 0) {
      // הגבלה: מקסימום 3 קבצים בכל בקשה
      if (req.files.length > 3) {
        return res.status(400).json({ 
          error: "Too many files. Maximum is 3 files per request. Please upload files in smaller batches." 
        });
      }

      for (const file of req.files) {
        const fileKey = `${rawEmail}_${file.originalname}_${file.size}`;
        
        // בדיקה אם הקובץ כבר בעיבוד
        if (processingFiles.has(fileKey)) {
          errors.push({ 
            file: file.originalname, 
            error: "File is already being processed. Please wait." 
          });
          continue;
        }

        try {
          if (file.mimetype !== "application/pdf") {
            errors.push({ file: file.originalname, error: "Not a PDF file" });
            continue;
          }

          // סימון שהקובץ בעיבוד
          processingFiles.add(fileKey);

          const pdfData = await pdfParse(file.buffer);
          const pdfText = pdfData.text.trim();
          
          // ניקוי ה-buffer מהזיכרון אחרי עיבוד
          file.buffer = null;
          
          if (!pdfText || pdfText.length === 0) {
            processingFiles.delete(fileKey);
            errors.push({ file: file.originalname, error: "PDF is empty or could not extract text" });
            continue;
          }

          const source = file.originalname || "uploaded.pdf";
          console.log(`[PDF] Extracted ${pdfText.length} characters from PDF: ${source}`);
          console.log(`[Upload] Starting RAG upload for ${source}...`);

          // העלאת הטקסט ל-RAG
          const uploadStartTime = Date.now();
          const result = await uploadDocumentToRAG(pdfText, {
            source,
            course_name: courseName,
            uploaded_by: rawEmail,
            uploaded_at: new Date().toISOString(),
            file_type: "pdf",
          });
          const uploadDuration = ((Date.now() - uploadStartTime) / 1000).toFixed(2);
          console.log(`[Upload] Completed RAG upload for ${source} in ${uploadDuration}s`);

          // הסרת הקובץ מרשימת הקבצים בעיבוד
          processingFiles.delete(fileKey);

          // לוג ב-Firestore
          if (db) {
            await db.collection("course_materials").add({
              email: rawEmail,
              source,
              course_name: courseName,
              text_length: pdfText.length,
              chunks_count: result.chunksCount,
              file_type: "pdf",
              ts: admin.firestore.FieldValue.serverTimestamp(),
            });
          }

          results.push({
            file: source,
            chunks_count: result.chunksCount,
            text_length: pdfText.length,
            success: true,
          });

        } catch (fileError) {
          console.error(`[PDF Parse Error] ${file.originalname}:`, fileError);
          processingFiles.delete(fileKey); // הסרה גם במקרה של שגיאה
          errors.push({ 
            file: file.originalname || "unknown", 
            error: String(fileError) 
          });
        }
      }
    }

    // עיבוד טקסט ישיר אם נשלח (ללא קבצים)
    if ((!req.files || req.files.length === 0) && text) {
      const source = (req.body?.source || "text_input").trim();
      
      const result = await uploadDocumentToRAG(text, {
        source,
        course_name: courseName,
        uploaded_by: rawEmail,
        uploaded_at: new Date().toISOString(),
        file_type: "text",
      });

      // לוג ב-Firestore
      if (db) {
        await db.collection("course_materials").add({
          email: rawEmail,
          source,
          course_name: courseName,
          text_length: text.length,
          chunks_count: result.chunksCount,
          file_type: "text",
          ts: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      results.push({
        source: source,
        chunks_count: result.chunksCount,
        text_length: text.length,
        success: true,
      });
    }

    // בדיקה שיש לפחות תוצאה אחת מוצלחת
    if (results.length === 0 && errors.length === 0) {
      return res.status(400).json({ error: "No files or text provided" });
    }

    const totalChunks = results.reduce((sum, r) => sum + r.chunks_count, 0);

    return res.json({
      success: true,
      total_chunks: totalChunks,
      files_processed: results.length,
      files_failed: errors.length,
      results: results,
      errors: errors.length > 0 ? errors : undefined,
      message: `Processed ${results.length} file(s), uploaded ${totalChunks} chunks to RAG database`,
    });

  } catch (e) {
    console.error("[/api/upload-course-material error]", e);
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

// Error handler כללי למניעת קריסת השרת
app.use((err, req, res, next) => {
  console.error("[Global Error Handler]", err);
  if (!res.headersSent) {
    res.status(500).json({ 
      error: "Internal server error", 
      details: process.env.NODE_ENV === "development" ? String(err) : undefined 
    });
  }
});

// Unhandled promise rejection handler
process.on("unhandledRejection", (reason, promise) => {
  console.error("[Unhandled Rejection]", reason);
});

// Uncaught exception handler
process.on("uncaughtException", (error) => {
  console.error("[Uncaught Exception]", error);
  // לא נסגור את השרת, רק נרישום את השגיאה
});

app.listen(PORT, () => {
  console.log(`[OK] Server listening on port ${PORT}`);
});