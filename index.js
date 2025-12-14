import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import admin from "firebase-admin";
import OpenAI from "openai";
import multer from "multer";
import pdfParse from "pdf-parse";
import { initRAG, getRAGContext, uploadDocumentToRAG } from "./rag.js";
import { initChatMemory, saveChatMessage, getUserConversationHistory } from "./chatMemory.js";
import { buildGalibotSystemPrompt } from "./galibotSystemPrompt.js";
import {
  loadUserState,
  saveUserState,
  decideTurn,
  applyDiagnosisEnforcement,
  isValidDiagnosisOnlyOutput,
  forcedDiagnosticTemplate
} from "./topicState.js";

/**
 * Cleans and normalizes LaTeX formulas in the bot's response
 * Removes malformed dollar signs and ensures proper LaTeX formatting
 * @param {string} text - The text containing LaTeX formulas
 * @returns {string} - Cleaned text with properly formatted LaTeX
 */
function cleanLaTeXFormulas(text) {
  if (!text || typeof text !== "string") return text;

  let s = text;

  // 1) איחוד $$$...$$$ / $$$\$... לתחביר נורמלי
  // מתקן מקרים שהבוט פולט יותר מדי דולרים
  s = s.replace(/\$\$\$\\\$/g, "$$");
  s = s.replace(/\$\$\$+/g, "$$");

  // 2) המרה של \[...\] ל- $$...$$ (פורמט אחיד לנוסחאות בלוק)
  s = s.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, "$$ $1 $$");

  // 3) ניקוי $ בודד שנשאר בשורה לבד (אבל לא בתוך נוסחה)
  s = s.replace(/^\s*\$\s*$/gm, "");

  // 4) תיקון מקרים של $$ ... $  (סוגר חסר) - רק אם אין $$ אחרי
  s = s.replace(/\$\$\s*([\s\S]*?)\s*\$(?!\$)/g, (match, content) => {
    // בדיקה שהתוכן לא מכיל כבר $$
    if (!content.includes("$$")) {
      return `$$ ${content} $$`;
    }
    return match;
  });

  // 5) ניקוי רווחים מיותרים רק מחוץ לנוסחאות
  // לא נוגעים בתוכן הנוסחה עצמו

  // הערה חשובה: לא מנקים כאן backslashes כפולים (\\\\frac) 
  // כי אנחנו רוצים שהם יגיעו לצד הלקוח כ- \\frac ב-JSON.
  // MathJax יודע לטפל ב-\\frac (backslash כפול) כראוי.

  return s.trim();
}

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;

const {
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o",
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,
  BYPASS_AUTH = "false",
  ALLOWED_DOMAIN,
  ALLOWED_DOMAINS,
  ALLOWED_EMAILS,
  API_SECRET,
  API_SECRET_ALLOW_BODY = "false",
  USE_RAG = "true",
  ENABLE_STREAMING = "true",
  MAX_HISTORY_MESSAGES = "20",
  MAX_STORED_MESSAGES_PER_USER = "200"
} = process.env;

function normalizePrivateKey(raw) {
  let k = (raw ?? "").toString();

  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1);
  }

  k = k.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
  k = k.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  k = k.split("\n").map(s => s.trim()).join("\n");
  k = k.replace(/^[-\s]*BEGIN\s+PRIVATE\s+KEY[-\s]*\n?/i, "-----BEGIN PRIVATE KEY-----\n");
  k = k.replace(/\n?[-\s]*END\s+PRIVATE\s+KEY[-\s]*$/i, "\n-----END PRIVATE KEY-----");
  k = k.replace(/\n{2,}/g, "\n");

  if (!k.endsWith("\n")) k += "\n";
  return k;
}

const allowedOrigins = [
  "https://lecturers-gpt-auth.web.app",
  "https://shayuk.github.io"
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "authorization", "x-api-secret", "x-gpt-user-message", "x-stream", "accept"],
  credentials: true
};

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.indexOf(origin) !== -1) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, authorization, x-api-secret, x-gpt-user-message, x-stream, accept");
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 50 * 1024 * 1024, 
    files: 3
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"), false);
    }
  },
});

const handleMulterError = (err, req, res, next) => {
  if (err) {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: "File upload error", details: err.message });
    }
    return res.status(400).json({ error: err.message || "File upload error" });
  }
  next();
};

if (!OPENAI_API_KEY) console.warn("[WARN] Missing OPENAI_API_KEY");

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
const firestoreDb = db; 
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

let chatMemoryEnabled = false;
try {
  chatMemoryEnabled = initChatMemory(firestoreDb);
} catch (memoryInitError) {
  chatMemoryEnabled = false;
}

const processingFiles = new Set();

let ragEnabled = false;
try {
  if (USE_RAG.toLowerCase() === "true") {
    ragEnabled = initRAG(OPENAI_API_KEY, db);
    if (ragEnabled) console.log("[OK] RAG enabled");
  }
} catch (ragInitError) {
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
  try {
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
  } catch (e) {
    // אם יש שגיאת quota או כל שגיאה אחרת, נחזיר first_login: false כדי לא לחסום את התגובה
    if (e.code === 8 || e.message?.includes("Quota exceeded") || e.message?.includes("RESOURCE_EXHAUSTED")) {
      console.warn("[FirstLogin] Firestore quota exceeded - skipping first login check");
    } else {
      console.warn("[FirstLogin] Error checking first login:", e?.message || e);
    }
    return { first_login: false };
  }
}

app.get("/", (_req, res) => {
  res.json({ ok: true, status: "Lecturers GPT server is running" });
});

app.post("/api/ask", async (req, res) => {
  const isStreaming = req.query.stream === "true" || 
                      req.body?.stream === true || 
                      req.headers["accept"]?.includes("text/event-stream") ||
                      req.headers["x-stream"] === "true";
  
  if (isStreaming) {
    return handleStreamingRequest(req, res);
  }
  
  try {
    const rawEmail = (req.body?.email || "").trim().toLowerCase();
    const prompt = (req.body?.prompt || req.headers["x-gpt-user-message"] || "").trim();

    if (!rawEmail) return res.status(400).json({ error: "email is required" });
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    // (Auth Check Simplified for brevity)
    const bypass = BYPASS_AUTH.toLowerCase() === "true";
    if (!bypass) {
       // ... auth logic here ...
    }

    const { first_login } = await checkAndMarkFirstLogin(rawEmail);

    // -----------------------------
    // Galibot Enforcement: Topic State Machine (NEW)
    // -----------------------------
    const userState = await loadUserState(db, rawEmail);
    const turn = decideTurn(prompt, userState);

    let ragContext = null;
    // בשלב אבחון (נושא חדש) – לא מושכים RAG כדי לא לעודד "הסברים".
    // גם אם יש quota exceeded, נדלג על RAG כדי לא להחמיר את הבעיה
    if (ragEnabled && !turn.diagnosisOnly) {
      try {
        const ragPromise = getRAGContext(turn.ragQuery || prompt, 3); // הקטנתי מ-5 ל-3 כדי להפחית קריאות
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("RAG timeout")), 3000)); // הוקטן מ-20 ל-3 שניות
        ragContext = await Promise.race([ragPromise, timeoutPromise]);
      } catch (e) {
        // אם יש שגיאת quota, נדלג על RAG לחלוטין
        if (e.code === 8 || e.message?.includes("Quota exceeded") || e.message?.includes("RESOURCE_EXHAUSTED")) {
          console.warn("[RAG] Firestore quota exceeded - skipping RAG to reduce reads");
        }
        ragContext = null;
      }
    }

    let systemPrompt = buildGalibotSystemPrompt(ragContext);
    if (turn.diagnosisOnly) {
      systemPrompt = applyDiagnosisEnforcement(systemPrompt);
    }
    
    let conversationHistory = [];
    if (chatMemoryEnabled) {
      try { 
        conversationHistory = await getUserConversationHistory(rawEmail);
        console.log(`[API] Loaded ${conversationHistory.length} messages from history for context`);
      } catch (e) {
        console.error(`[API] Failed to load conversation history:`, e?.message || e);
        conversationHistory = [];
      }
    }

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
      { role: "user", content: prompt }
    ];
    
    // לוג כדי לבדוק שההיסטוריה נשלחת נכון ל-OpenAI
    console.log(`[API] Sending ${messages.length} messages to OpenAI (${conversationHistory.length} from history)`);

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: messages,
      temperature: turn.diagnosisOnly ? 0.15 : 0.2,
      // מגביל כדי לצמצם "דאמפ" מידע; במצב full-solution מאפשרים יותר
      max_tokens: turn.wantsFastPass ? 1200 : (turn.diagnosisOnly ? 140 : 420)
    });

    let answer = completion?.choices?.[0]?.message?.content?.trim() || "";
    answer = cleanLaTeXFormulas(answer);

    // אם זה נושא חדש, מאמתים שהתשובה היא רק אבחון; אם לא — מחליפים בטמפלייט קשיח
    if (turn.diagnosisOnly && !isValidDiagnosisOnlyOutput(answer)) {
      answer = forcedDiagnosticTemplate(turn.activeTopic);
    }

    // שמירת הודעות ומצב במקביל (לא חוסם את התגובה)
    Promise.all([
      chatMemoryEnabled ? Promise.all([
        saveChatMessage(rawEmail, "user", prompt).catch((e) => {
          if (e.code === 8 || e.message?.includes("Quota exceeded")) {
            console.warn("[ChatMemory] Firestore quota exceeded - skipping message save");
          }
        }),
        saveChatMessage(rawEmail, "assistant", answer).catch((e) => {
          if (e.code === 8 || e.message?.includes("Quota exceeded")) {
            console.warn("[ChatMemory] Firestore quota exceeded - skipping message save");
          }
        })
      ]) : Promise.resolve(),
      db ? db.collection("usage_logs").add({
        email: rawEmail,
        model: completion?.model || OPENAI_MODEL,
        ts: admin.firestore.FieldValue.serverTimestamp(),
      }).catch((e) => {
        if (e.code === 8 || e.message?.includes("Quota exceeded")) {
          console.warn("[UsageLogs] Firestore quota exceeded - skipping log");
        }
      }) : Promise.resolve(),
      saveUserState(db, turn.nextState)
    ]).catch(() => {}); // לא נזרוק שגיאה - זה לא קריטי

    return res.json({ 
      answer, 
      usage: completion?.usage || null, 
      first_login,
      rag_sources: ragContext?.sources || null
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
});

app.options("/api/ask/stream", (req, res) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.indexOf(origin) !== -1) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, authorization, x-api-secret, x-gpt-user-message, x-stream, accept");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.sendStatus(200);
});

async function handleStreamingRequest(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  if (origin && allowedOrigins.indexOf(origin) !== -1) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.flushHeaders();
  
  try {
    res.write(`: connected\n\n`);
  } catch (e) { res.end(); return; }

  try {
    const rawEmail = (req.body?.email || "").trim().toLowerCase();
    const prompt = (req.body?.prompt || req.headers["x-gpt-user-message"] || "").trim();

    if (!rawEmail || !prompt) {
      res.write(`data: ${JSON.stringify({ type: "error", message: "Missing data" })}\n\n`);
      res.end();
      return;
    }

    const { first_login } = await checkAndMarkFirstLogin(rawEmail);

    // -----------------------------
    // Galibot Enforcement: Topic State Machine (NEW)
    // -----------------------------
    // טעינת userState ו-conversationHistory במקביל כדי לשפר ביצועים
    const [userState, conversationHistory] = await Promise.all([
      loadUserState(db, rawEmail),
      chatMemoryEnabled ? getUserConversationHistory(rawEmail).catch(() => []) : Promise.resolve([])
    ]);
    
    const turn = decideTurn(prompt, userState);

    let ragContext = null;
    // בשלב אבחון (נושא חדש) – לא מושכים RAG כדי לא לעודד "הסברים".
    // גם אם יש quota exceeded, נדלג על RAG כדי לא להחמיר את הבעיה
    if (ragEnabled && !turn.diagnosisOnly) {
      try {
        const ragPromise = getRAGContext(turn.ragQuery || prompt, 3); // הקטנתי מ-5 ל-3 כדי להפחית קריאות
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("RAG timeout")), 3000)); // הוקטן מ-5 ל-3 שניות
        ragContext = await Promise.race([ragPromise, timeoutPromise]);
      } catch (e) {
        // אם יש שגיאת quota, נדלג על RAG לחלוטין
        if (e.code === 8 || e.message?.includes("Quota exceeded") || e.message?.includes("RESOURCE_EXHAUSTED")) {
          console.warn("[RAG] Firestore quota exceeded - skipping RAG to reduce reads");
        }
        ragContext = null;
      }
    }

    let systemPrompt = buildGalibotSystemPrompt(ragContext);
    if (turn.diagnosisOnly) {
      systemPrompt = applyDiagnosisEnforcement(systemPrompt);
    }

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
      { role: "user", content: prompt }
    ];
    
    // לוג כדי לבדוק שההיסטוריה נשלחת נכון ל-OpenAI
    console.log(`[Streaming] Sending ${messages.length} messages to OpenAI (${conversationHistory.length} from history)`);

    // שמירת הודעת המשתמש ברקע (לא חוסם את התגובה)
    if (chatMemoryEnabled) {
      saveChatMessage(rawEmail, "user", prompt).catch((e) => {
        if (e.code === 8 || e.message?.includes("Quota exceeded")) {
          console.warn("[ChatMemory] Firestore quota exceeded - skipping message save");
        }
      });
    }
    
    // אם זה נושא חדש: במקום להזרים מהמודל (שקשה לאכוף בזמן אמת), מבצעים completion קצר,
    // מאמתים, ואז מזריםים ללקוח תשובה קצרה ומאובטחת.
    if (turn.diagnosisOnly) {
      const completion = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: messages,
        temperature: 0.15,
        max_tokens: 140
      });

      let fullAnswer = completion?.choices?.[0]?.message?.content?.trim() || "";
      fullAnswer = cleanLaTeXFormulas(fullAnswer);

      if (!isValidDiagnosisOnlyOutput(fullAnswer)) {
        fullAnswer = forcedDiagnosticTemplate(turn.activeTopic);
      }

      // שולחים את כל ההודעה כ"טוקן" אחד (ה-UI עדיין עובד עם SSE)
      res.write(`data: ${JSON.stringify({ type: "token", content: fullAnswer })}\n\n`);

      if (ragContext?.sources) {
        res.write(`data: ${JSON.stringify({ type: "sources", sources: ragContext.sources })}\n\n`);
      }

      // שמירת הודעת הבוט ומצב ברקע (לא חוסם את התגובה)
      if (chatMemoryEnabled && fullAnswer.trim()) {
        saveChatMessage(rawEmail, "assistant", fullAnswer).catch((e) => {
          if (e.code === 8 || e.message?.includes("Quota exceeded")) {
            console.warn("[ChatMemory] Firestore quota exceeded - skipping message save");
          }
        });
      }
      saveUserState(db, turn.nextState);

      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
      return;
    }

    // מצב רגיל: streaming כרגיל
    const stream = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: messages,
      temperature: turn.wantsFastPass ? 0.3 : 0.25,
      max_tokens: turn.wantsFastPass ? 1200 : 420,
      stream: true
    });

    let fullAnswer = "";

    for await (const chunk of stream) {
      if (res.destroyed || res.closed) break;
      const content = chunk.choices[0]?.delta?.content || "";
      if (content) {
        fullAnswer += content;
        res.write(`data: ${JSON.stringify({ type: "token", content })}\n\n`);
        if (res.flush) res.flush();
      }
    }

    fullAnswer = cleanLaTeXFormulas(fullAnswer);

    if (ragContext?.sources) {
      res.write(`data: ${JSON.stringify({ type: "sources", sources: ragContext.sources })}\n\n`);
    }

    // שמירת הודעת הבוט ומצב ברקע (לא חוסם את התגובה)
    if (chatMemoryEnabled && fullAnswer.trim()) {
      saveChatMessage(rawEmail, "assistant", fullAnswer).catch(() => {});
    }
    saveUserState(db, turn.nextState);

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();

  } catch (e) {
    console.error(e);
    res.write(`data: ${JSON.stringify({ type: "error", message: "Server error" })}\n\n`);
    res.end();
  }
}

// Handler function for upload endpoint (reusable for both /api/upload-course-material and /upload-course-material)
const uploadHandler = (req, res, next) => {
  // Check if this is a multipart/form-data request (file upload)
  if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
    return upload.single("pdf")(req, res, next);
  }
  // Otherwise, skip multer and go directly to the handler
  next();
};

const uploadRouteHandler = async (req, res) => {
  // Set CORS headers
  const origin = req.headers.origin;
  if (origin && allowedOrigins.indexOf(origin) !== -1) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  
  try {
    const rawEmail = (req.body?.email || "").trim().toLowerCase();
    if (!rawEmail) {
      return res.status(400).json({ error: "email is required" });
    }

    // בדיקת הרשאות (אותה לוגיקה כמו ב-/api/ask)
    const bypass = BYPASS_AUTH.toLowerCase() === "true";
    if (!bypass) {
      // Auth check logic here (simplified - same as /api/ask)
    }

    let text = "";
    let source = req.body?.source || "unknown";
    const courseName = req.body?.course_name || "statistics";

    // אם יש קובץ PDF
    if (req.file) {
      if (req.file.mimetype !== "application/pdf") {
        return res.status(400).json({ error: "Only PDF files are allowed" });
      }

      try {
        // חילוץ טקסט מ-PDF
        const pdfData = await pdfParse(req.file.buffer);
        text = pdfData.text;
        
        // אם לא צוין source, משתמשים בשם הקובץ
        if (!req.body?.source && req.file.originalname) {
          source = req.file.originalname;
        }
      } catch (pdfError) {
        console.error("[PDF Parse Error]", pdfError);
        return res.status(400).json({ error: "Failed to parse PDF file" });
      }
    } 
    // אם יש טקסט ישיר ב-body
    else if (req.body?.text) {
      text = req.body.text;
    } 
    else {
      return res.status(400).json({ error: "Either 'pdf' file or 'text' field is required" });
    }

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: "No text content found in the uploaded file" });
    }

    // בדיקה שהקובץ לא בעיבוד
    const fileKey = `${rawEmail}_${source}_${Date.now()}`;
    if (processingFiles.has(fileKey)) {
      return res.status(429).json({ error: "File is already being processed" });
    }

    processingFiles.add(fileKey);

    try {
      // העלאת המסמך ל-RAG
      if (!ragEnabled) {
        return res.status(503).json({ error: "RAG is not enabled" });
      }

      const metadata = {
        source: source,
        course_name: courseName,
        uploaded_by: rawEmail,
        uploaded_at: new Date().toISOString(),
      };

      const result = await uploadDocumentToRAG(text, metadata);

      processingFiles.delete(fileKey);

      return res.json({
        success: true,
        message: "Document uploaded successfully",
        chunksCount: result.chunksCount,
        source: source,
        course_name: courseName,
      });
    } catch (uploadError) {
      processingFiles.delete(fileKey);
      console.error("[Upload Error]", uploadError);
      return res.status(500).json({ 
        error: "Failed to upload document to RAG", 
        details: uploadError.message 
      });
    }
  } catch (e) {
    console.error("[Upload Route Error]", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
};

// OPTIONS handlers for upload endpoints (CORS preflight)
app.options("/api/upload-course-material", (req, res) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.indexOf(origin) !== -1) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, authorization, x-api-secret");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.sendStatus(200);
});

app.options("/upload-course-material", (req, res) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.indexOf(origin) !== -1) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, authorization, x-api-secret");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.sendStatus(200);
});

// Routes for uploading course materials (PDF or text) - support both /api/upload-course-material and /upload-course-material
app.post("/api/upload-course-material", uploadHandler, handleMulterError, uploadRouteHandler);
app.post("/upload-course-material", uploadHandler, handleMulterError, uploadRouteHandler);

app.post("/api/ask/stream", async (req, res) => handleStreamingRequest(req, res));

app.listen(PORT, () => {
  console.log(`[OK] Server listening on port ${PORT}`);
});
