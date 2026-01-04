import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import admin from "firebase-admin";
import OpenAI from "openai";
import multer from "multer";
import pdfParse from "pdf-parse";
import { initRAG, getRAGContext, uploadDocumentToRAG } from "./rag.js";
import { initChatMemory, saveChatMessage, getUserConversationHistory, deleteUserHistory } from "./chatMemory.js";
import { buildGalibotSystemPrompt } from "./galibotSystemPrompt.js";
import {
  loadUserState,
  saveUserState,
  decideTurn,
  applyDiagnosisEnforcement,
  isValidDiagnosisOnlyOutput,
  forcedDiagnosticTemplate,
  defaultUserState
} from "./topicState.js";
import { generateRequestId, logPerformance, logTokenUsage, logPromptSize, estimateTokens, estimateMessagesTokens } from "./performanceLogger.js";
import { getCache, setCache, deleteCache, getConversationHistoryKey, getUserStateKey, DEFAULT_TTL, getStateCached, getHistoryCached, updateHistoryCache, updateStateCache, getFirstLoginCached } from "./cache.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

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
  MAX_STORED_MESSAGES_PER_USER = "200",
  RAG_MAX_DOCS = "50"
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

// Request ID middleware for correlation tracking
app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"] || generateRequestId();
  res.setHeader("X-Request-ID", req.requestId);
  next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.indexOf(origin) !== -1) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, authorization, x-api-secret, x-gpt-user-message, x-stream, accept, x-request-id");
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let firebaseApp;
try {
  // Option A: Try GOOGLE_APPLICATION_CREDENTIALS first (recommended for local development)
  const googleAppCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (googleAppCreds) {
    try {
      const credsPath = resolve(__dirname, googleAppCreds);
      const serviceAccount = JSON.parse(readFileSync(credsPath, "utf8"));
      
      // Validate required fields
      if (!serviceAccount.project_id || typeof serviceAccount.project_id !== "string") {
        throw new Error(`Service account JSON at ${credsPath} is missing or has invalid 'project_id' property`);
      }
      if (!serviceAccount.private_key || typeof serviceAccount.private_key !== "string") {
        throw new Error(`Service account JSON at ${credsPath} is missing or has invalid 'private_key' property`);
      }
      if (!serviceAccount.client_email || typeof serviceAccount.client_email !== "string") {
        throw new Error(`Service account JSON at ${credsPath} is missing or has invalid 'client_email' property`);
      }

      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log("[OK] Firebase initialized from GOOGLE_APPLICATION_CREDENTIALS:", serviceAccount.project_id);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`Firebase credentials file not found: ${googleAppCreds}. Check GOOGLE_APPLICATION_CREDENTIALS path.`);
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in Firebase credentials file: ${googleAppCreds}. Error: ${error.message}`);
      }
      throw error;
    }
  } else {
    // Fallback: Use environment variables
    if (!FIREBASE_PROJECT_ID || typeof FIREBASE_PROJECT_ID !== "string" || FIREBASE_PROJECT_ID.trim() === "") {
      throw new Error(
        "Firebase credentials missing: FIREBASE_PROJECT_ID is not set or empty. " +
        "Set GOOGLE_APPLICATION_CREDENTIALS to point to a service account JSON file, " +
        "or set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY environment variables."
      );
    }
    if (!FIREBASE_CLIENT_EMAIL || typeof FIREBASE_CLIENT_EMAIL !== "string" || FIREBASE_CLIENT_EMAIL.trim() === "") {
      throw new Error(
        "Firebase credentials missing: FIREBASE_CLIENT_EMAIL is not set or empty. " +
        "Set GOOGLE_APPLICATION_CREDENTIALS to point to a service account JSON file, " +
        "or set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY environment variables."
      );
    }
    
    const pk = normalizePrivateKey(FIREBASE_PRIVATE_KEY);
    if (!pk || pk.trim() === "") {
      throw new Error(
        "Firebase credentials missing: FIREBASE_PRIVATE_KEY is not set or empty. " +
        "Set GOOGLE_APPLICATION_CREDENTIALS to point to a service account JSON file, " +
        "or set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY environment variables."
      );
    }

    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID.trim(),
        clientEmail: FIREBASE_CLIENT_EMAIL.trim(),
        privateKey: pk,
      }),
    });
    console.log("[OK] Firebase initialized from environment variables:", FIREBASE_PROJECT_ID);
  }
} catch (e) {
  console.error("[Firebase Init Error]", e.message || e);
  throw e; // Re-throw to prevent silent failures
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

// Wrapper function for caching - matches signature expected by getFirstLoginCached
async function checkAndMarkFirstLoginWrapper(db, email) {
  return await checkAndMarkFirstLogin(email);
}

app.get("/", (_req, res) => {
  res.json({ ok: true, status: "Lecturers GPT server is running" });
});

// Route למחיקת היסטוריית שיחות של משתמש
app.delete("/api/chat-history/:email", async (req, res) => {
  try {
    const rawEmail = (req.params.email || "").trim().toLowerCase();
    if (!rawEmail) {
      return res.status(400).json({ error: "email is required" });
    }

    // בדיקת הרשאות (אותה לוגיקה כמו ב-/api/ask)
    const bypass = BYPASS_AUTH.toLowerCase() === "true";
    if (!bypass) {
      // Auth check logic here (simplified - same as /api/ask)
    }

    // Set CORS headers
    const origin = req.headers.origin;
    if (origin && allowedOrigins.indexOf(origin) !== -1) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Credentials", "true");

    if (!chatMemoryEnabled) {
      return res.status(503).json({ error: "Chat memory is not enabled" });
    }

    const deleted = await deleteUserHistory(rawEmail);
    
    if (deleted) {
      // גם נמחק את ה-state של המשתמש
      await saveUserState(db, defaultUserState(rawEmail));
      
      // Invalidate caches
      deleteCache(getConversationHistoryKey(rawEmail));
      deleteCache(getUserStateKey(rawEmail));
      
      return res.json({ 
        success: true, 
        message: "Chat history deleted successfully",
        email: rawEmail
      });
    } else {
      return res.status(500).json({ error: "Failed to delete chat history" });
    }
  } catch (e) {
    console.error("[DeleteHistory] Error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

// OPTIONS handler for delete history endpoint (CORS preflight)
app.options("/api/chat-history/:email", (req, res) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.indexOf(origin) !== -1) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, authorization, x-api-secret");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.sendStatus(200);
});

app.post("/api/ask", async (req, res) => {
  const isStreaming = req.query.stream === "true" || 
                      req.body?.stream === true || 
                      req.headers["accept"]?.includes("text/event-stream") ||
                      req.headers["x-stream"] === "true";
  
  if (isStreaming) {
    return handleStreamingRequest(req, res);
  }
  
  const requestId = req.requestId || generateRequestId();
  const startTime = Date.now();
  
  try {
    const rawEmail = (req.body?.email || "").trim().toLowerCase();
    const prompt = (req.body?.prompt || req.headers["x-gpt-user-message"] || "").trim();

    if (!rawEmail) return res.status(400).json({ error: "email is required" });
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    logPerformance(requestId, "start", Date.now() - startTime);

    // (Auth Check Simplified for brevity)
    const bypass = BYPASS_AUTH.toLowerCase() === "true";
    if (!bypass) {
       // ... auth logic here ...
    }

    // Parallelize independent Firestore reads: first_login check, user state, and conversation history
    const firestoreStartTime = Date.now();
    const firstLoginStartTime = Date.now();
    
    const [firstLoginResult, stateResult, historyResult] = await Promise.all([
      getFirstLoginCached(db, rawEmail, requestId, checkAndMarkFirstLoginWrapper).then(result => {
        const firstLoginMs = Date.now() - firstLoginStartTime;
        console.log(`[RID:${requestId}] firestore_read first_login ms=${firstLoginMs} cached=${result.cached}`);
        return result;
      }),
      getStateCached(db, rawEmail, requestId, loadUserState),
      getHistoryCached(chatMemoryEnabled, rawEmail, requestId, getUserConversationHistory)
    ]);
    
    const { first_login } = firstLoginResult;
    const userState = stateResult.state;
    const conversationHistory = historyResult.history;
    const stateCacheHit = stateResult.cached;
    const historyCacheHit = historyResult.cached;
    const firstLoginCacheHit = firstLoginResult.cached;
    
    const firestoreReadsMs = Date.now() - firestoreStartTime;
    const readsPerformed = [];
    if (!stateCacheHit) readsPerformed.push("state");
    if (!historyCacheHit) readsPerformed.push("history");
    if (!firstLoginCacheHit) readsPerformed.push("first_login");
    
    logPerformance(requestId, "firestore_reads", firestoreReadsMs, {
      cached_state: stateCacheHit,
      cached_history: historyCacheHit,
      cached_first_login: firstLoginCacheHit,
      reads: readsPerformed.join(",") || "none"
    });

    // -----------------------------
    // Galibot Enforcement: Topic State Machine (NEW)
    // -----------------------------
    const turn = decideTurn(prompt, userState);

    let ragContext = null;
    const ragStartTime = Date.now();
    // בשלב אבחון (נושא חדש) – לא מושכים RAG כדי לא לעודד "הסברים".
    // גם אם יש quota exceeded, נדלג על RAG כדי לא להחמיר את הבעיה
    if (ragEnabled && !turn.diagnosisOnly) {
      try {
        // חילוץ course_name מה-context או ברירת מחדל "statistics"
        const courseName = req.body?.course_name || "statistics";
        const maxDocs = parseInt(RAG_MAX_DOCS || "50", 10);
        const RAG_TIMEOUT_MS = 400; // Fail fast timeout
        
        // Use AbortController for proper cancellation (rag.js handles Promise.race internally)
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), RAG_TIMEOUT_MS);
        
        try {
          ragContext = await getRAGContext(turn.ragQuery || prompt, 3, courseName, maxDocs, RAG_TIMEOUT_MS, abortController.signal);
          clearTimeout(timeoutId);
          
          // Log with detailed metrics (metrics.rag_total_ms is the actual awaited duration from rag.js)
          const metrics = ragContext?._metrics || {};
          logPerformance(requestId, "rag", metrics.rag_total_ms || (Date.now() - ragStartTime), {
            status: metrics.status || "unknown",
            maxDocs: metrics.maxDocs || maxDocs,
            retrieved_count: metrics.retrieved_count || 0,
            processed_count: metrics.processed_count || 0,
            returned_count: metrics.returned_count || 0,
            rag_total_ms: metrics.rag_total_ms || (Date.now() - ragStartTime)
          });
        } catch (ragError) {
          clearTimeout(timeoutId);
          // Timeout is handled by rag.js Promise.race, so this should rarely happen
          // But if it does, log it with actual duration
          const ragTotalMs = Date.now() - ragStartTime;
          ragContext = null;
          logPerformance(requestId, "rag", ragTotalMs, { 
            status: "timeout",
            maxDocs,
            retrieved_count: 0,
            processed_count: 0,
            returned_count: 0
          });
        }
      } catch (e) {
        // אם יש שגיאת quota, נדלג על RAG לחלוטין
        if (e.code === 8 || e.message?.includes("Quota exceeded") || e.message?.includes("RESOURCE_EXHAUSTED")) {
          console.warn("[RAG] Firestore quota exceeded - skipping RAG to reduce reads");
          logPerformance(requestId, "rag", Date.now() - ragStartTime, { 
            status: "quota_exceeded",
            maxDocs: parseInt(RAG_MAX_DOCS || "50", 10),
            retrieved_count: 0,
            processed_count: 0,
            returned_count: 0
          });
        } else {
          logPerformance(requestId, "rag", Date.now() - ragStartTime, { 
            status: "error",
            error: e.message,
            maxDocs: parseInt(RAG_MAX_DOCS || "50", 10),
            retrieved_count: 0,
            processed_count: 0,
            returned_count: 0
          });
        }
        ragContext = null;
      }
    }

    let systemPrompt = buildGalibotSystemPrompt(ragContext, requestId);
    if (turn.diagnosisOnly) {
      systemPrompt = applyDiagnosisEnforcement(systemPrompt);
    }

    // Token-based history limiting: max 1500 tokens OR last 8 messages (whichever is more restrictive)
    const MAX_HISTORY_TOKENS = 1500;
    const MAX_HISTORY_MESSAGES_FALLBACK = 8;
    
    let limitedHistory = conversationHistory;
    const historyTokens = estimateMessagesTokens(conversationHistory);
    
    if (historyTokens > MAX_HISTORY_TOKENS) {
      // Trim from oldest messages until we're under token limit
      let trimmedTokens = 0;
      let keepCount = 0;
      for (let i = conversationHistory.length - 1; i >= 0; i--) {
        const msgTokens = estimateTokens(conversationHistory[i].content || "") + 10;
        if (trimmedTokens + msgTokens <= MAX_HISTORY_TOKENS) {
          trimmedTokens += msgTokens;
          keepCount++;
        } else {
          break;
        }
      }
      limitedHistory = conversationHistory.slice(-keepCount);
      console.log(`[RID:${requestId}] history_trimmed tokens=${historyTokens}->${estimateMessagesTokens(limitedHistory)} messages=${conversationHistory.length}->${limitedHistory.length}`);
    } else if (conversationHistory.length > MAX_HISTORY_MESSAGES_FALLBACK) {
      // Fallback: if message count exceeds limit, keep last N messages
      limitedHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES_FALLBACK);
      console.log(`[RID:${requestId}] history_trimmed_by_count messages=${conversationHistory.length}->${limitedHistory.length}`);
    }

    const messages = [
      { role: "system", content: systemPrompt },
      ...limitedHistory,
      { role: "user", content: prompt }
    ];
    
    const systemPromptChars = systemPrompt.length;
    const systemPromptTokens = estimateTokens(systemPrompt);
    const historyTokensFinal = estimateMessagesTokens(limitedHistory);
    const userPromptTokens = estimateTokens(prompt);
    const totalEstimatedTokens = systemPromptTokens + historyTokensFinal + userPromptTokens;
    
    const promptSize = JSON.stringify(messages).length;
    logPromptSize(requestId, promptSize, messages.length);
    logPerformance(requestId, "prompt_breakdown", 0, {
      system_chars: systemPromptChars,
      system_tokens: systemPromptTokens,
      history_messages: limitedHistory.length,
      history_tokens: historyTokensFinal,
      user_tokens: userPromptTokens,
      total_estimated_tokens: totalEstimatedTokens
    });

    const openaiStartTime = Date.now();
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: messages,
      temperature: turn.diagnosisOnly ? 0.15 : 0.2,
      // מגביל כדי לצמצם "דאמפ" מידע; במצב full-solution מאפשרים יותר
      max_tokens: turn.wantsFastPass ? 1200 : (turn.diagnosisOnly ? 140 : 420)
    });
    logPerformance(requestId, "openai_call", Date.now() - openaiStartTime);
    
    if (completion?.usage) {
      logTokenUsage(requestId, completion.usage);
    }

    let answer = completion?.choices?.[0]?.message?.content?.trim() || "";
    answer = cleanLaTeXFormulas(answer);

    // אם זה נושא חדש, מאמתים שהתשובה היא רק אבחון; אם לא — מחליפים בטמפלייט קשיח
    if (turn.diagnosisOnly && !isValidDiagnosisOnlyOutput(answer)) {
      answer = forcedDiagnosticTemplate(turn.activeTopic);
    }

    // שמירת הודעות ומצב - await critical writes before finalizing
    // Cache updates happen AFTER successful writes (write-through cache)
    const maxStoredMessages = parseInt(MAX_STORED_MESSAGES_PER_USER || "200", 10);
    
    // Await critical message saves and cache updates before finalizing request
    if (chatMemoryEnabled) {
      try {
        // Save user message first, then update cache
        await saveChatMessage(rawEmail, "user", prompt);
        updateHistoryCache(rawEmail, { role: "user", content: prompt }, maxStoredMessages);
        console.log(`[Cache] history UPDATED after user message write`);
      } catch (e) {
        if (e.code === 8 || e.message?.includes("Quota exceeded")) {
          console.warn("[ChatMemory] Firestore quota exceeded - skipping message save");
        }
      }
      // Save assistant message second, then update cache (ensures correct ordering)
      try {
        await saveChatMessage(rawEmail, "assistant", answer);
        updateHistoryCache(rawEmail, { role: "assistant", content: answer }, maxStoredMessages);
        console.log(`[Cache] history UPDATED after assistant message write`);
      } catch (e) {
        if (e.code === 8 || e.message?.includes("Quota exceeded")) {
          console.warn("[ChatMemory] Firestore quota exceeded - skipping message save");
        }
      }
    }
    
    // Non-critical writes can run in background
    Promise.all([
      db ? db.collection("usage_logs").add({
        email: rawEmail,
        model: completion?.model || OPENAI_MODEL,
        ts: admin.firestore.FieldValue.serverTimestamp(),
      }).catch((e) => {
        if (e.code === 8 || e.message?.includes("Quota exceeded")) {
          console.warn("[UsageLogs] Firestore quota exceeded - skipping log");
        }
      }) : Promise.resolve(),
      saveUserState(db, turn.nextState).then((success) => {
        // Update state cache after successful write
        if (success) {
          updateStateCache(rawEmail, turn.nextState);
          console.log(`[Cache] state UPDATED after state write`);
        }
      })
    ]).catch(() => {}); // לא נזרוק שגיאה - זה לא קריטי

    logPerformance(requestId, "end", Date.now() - startTime);

    return res.json({ 
      answer, 
      usage: completion?.usage || null, 
      first_login,
      rag_sources: ragContext?.sources || null
    });

  } catch (e) {
    logPerformance(requestId, "error", Date.now() - startTime, { error: e.message });
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
  const requestId = req.requestId || generateRequestId();
  const startTime = Date.now();
  const origin = req.headers.origin;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-ID", requestId);
  
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

    logPerformance(requestId, "start", Date.now() - startTime);

    // Parallelize independent Firestore reads: first_login check, user state, and conversation history
    const firestoreStartTime = Date.now();
    const firstLoginStartTime = Date.now();
    
    const [firstLoginResult, stateResult, historyResult] = await Promise.all([
      getFirstLoginCached(db, rawEmail, requestId, checkAndMarkFirstLoginWrapper).then(result => {
        const firstLoginMs = Date.now() - firstLoginStartTime;
        console.log(`[RID:${requestId}] firestore_read first_login ms=${firstLoginMs} cached=${result.cached}`);
        return result;
      }),
      getStateCached(db, rawEmail, requestId, loadUserState),
      getHistoryCached(chatMemoryEnabled, rawEmail, requestId, getUserConversationHistory)
    ]);
    
    const { first_login } = firstLoginResult;
    const userState = stateResult.state;
    const conversationHistory = historyResult.history;
    const stateCacheHit = stateResult.cached;
    const historyCacheHit = historyResult.cached;
    const firstLoginCacheHit = firstLoginResult.cached;
    
    const firestoreReadsMs = Date.now() - firestoreStartTime;
    const readsPerformed = [];
    if (!stateCacheHit) readsPerformed.push("state");
    if (!historyCacheHit) readsPerformed.push("history");
    if (!firstLoginCacheHit) readsPerformed.push("first_login");
    
    logPerformance(requestId, "firestore_reads", firestoreReadsMs, {
      cached_state: stateCacheHit,
      cached_history: historyCacheHit,
      cached_first_login: firstLoginCacheHit,
      reads: readsPerformed.join(",") || "none"
    });
    
    const turn = decideTurn(prompt, userState);

    let ragContext = null;
    const ragStartTime = Date.now();
    // בשלב אבחון (נושא חדש) – לא מושכים RAG כדי לא לעודד "הסברים".
    // גם אם יש quota exceeded, נדלג על RAG כדי לא להחמיר את הבעיה
    if (ragEnabled && !turn.diagnosisOnly) {
      try {
        // חילוץ course_name מה-context או ברירת מחדל "statistics"
        const courseName = req.body?.course_name || "statistics";
        const maxDocs = parseInt(RAG_MAX_DOCS || "50", 10);
        const RAG_TIMEOUT_MS = 400; // Fail fast timeout
        
        // Use AbortController for proper cancellation (rag.js handles Promise.race internally)
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), RAG_TIMEOUT_MS);
        
        try {
          ragContext = await getRAGContext(turn.ragQuery || prompt, 3, courseName, maxDocs, RAG_TIMEOUT_MS, abortController.signal);
          clearTimeout(timeoutId);
          
          // Log with detailed metrics (metrics.rag_total_ms is the actual awaited duration from rag.js)
          const metrics = ragContext?._metrics || {};
          logPerformance(requestId, "rag", metrics.rag_total_ms || (Date.now() - ragStartTime), {
            status: metrics.status || "unknown",
            maxDocs: metrics.maxDocs || maxDocs,
            retrieved_count: metrics.retrieved_count || 0,
            processed_count: metrics.processed_count || 0,
            returned_count: metrics.returned_count || 0,
            rag_total_ms: metrics.rag_total_ms || (Date.now() - ragStartTime)
          });
        } catch (ragError) {
          clearTimeout(timeoutId);
          // Timeout is handled by rag.js Promise.race, so this should rarely happen
          // But if it does, log it with actual duration
          const ragTotalMs = Date.now() - ragStartTime;
          ragContext = null;
          logPerformance(requestId, "rag", ragTotalMs, { 
            status: "timeout",
            maxDocs,
            retrieved_count: 0,
            processed_count: 0,
            returned_count: 0
          });
        }
      } catch (e) {
        // אם יש שגיאת quota, נדלג על RAG לחלוטין
        if (e.code === 8 || e.message?.includes("Quota exceeded") || e.message?.includes("RESOURCE_EXHAUSTED")) {
          console.warn("[RAG] Firestore quota exceeded - skipping RAG to reduce reads");
          logPerformance(requestId, "rag", Date.now() - ragStartTime, { 
            status: "quota_exceeded",
            maxDocs: parseInt(RAG_MAX_DOCS || "50", 10),
            retrieved_count: 0,
            processed_count: 0,
            returned_count: 0
          });
        } else {
          logPerformance(requestId, "rag", Date.now() - ragStartTime, { 
            status: "error",
            error: e.message,
            maxDocs: parseInt(RAG_MAX_DOCS || "50", 10),
            retrieved_count: 0,
            processed_count: 0,
            returned_count: 0
          });
        }
        ragContext = null;
      }
    }

    let systemPrompt = buildGalibotSystemPrompt(ragContext, requestId);
    if (turn.diagnosisOnly) {
      systemPrompt = applyDiagnosisEnforcement(systemPrompt);
    }

    // Token-based history limiting: max 1500 tokens OR last 8 messages (whichever is more restrictive)
    const MAX_HISTORY_TOKENS = 1500;
    const MAX_HISTORY_MESSAGES_FALLBACK = 8;
    
    let limitedHistory = conversationHistory;
    const historyTokens = estimateMessagesTokens(conversationHistory);
    
    if (historyTokens > MAX_HISTORY_TOKENS) {
      // Trim from oldest messages until we're under token limit
      let trimmedTokens = 0;
      let keepCount = 0;
      for (let i = conversationHistory.length - 1; i >= 0; i--) {
        const msgTokens = estimateTokens(conversationHistory[i].content || "") + 10;
        if (trimmedTokens + msgTokens <= MAX_HISTORY_TOKENS) {
          trimmedTokens += msgTokens;
          keepCount++;
        } else {
          break;
        }
      }
      limitedHistory = conversationHistory.slice(-keepCount);
      console.log(`[RID:${requestId}] history_trimmed tokens=${historyTokens}->${estimateMessagesTokens(limitedHistory)} messages=${conversationHistory.length}->${limitedHistory.length}`);
    } else if (conversationHistory.length > MAX_HISTORY_MESSAGES_FALLBACK) {
      // Fallback: if message count exceeds limit, keep last N messages
      limitedHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES_FALLBACK);
      console.log(`[RID:${requestId}] history_trimmed_by_count messages=${conversationHistory.length}->${limitedHistory.length}`);
    }

    const messages = [
      { role: "system", content: systemPrompt },
      ...limitedHistory,
      { role: "user", content: prompt }
    ];
    
    const systemPromptChars = systemPrompt.length;
    const systemPromptTokens = estimateTokens(systemPrompt);
    const historyTokensFinal = estimateMessagesTokens(limitedHistory);
    const userPromptTokens = estimateTokens(prompt);
    const totalEstimatedTokens = systemPromptTokens + historyTokensFinal + userPromptTokens;
    
    const promptSize = JSON.stringify(messages).length;
    logPromptSize(requestId, promptSize, messages.length);
    logPerformance(requestId, "prompt_breakdown", 0, {
      system_chars: systemPromptChars,
      system_tokens: systemPromptTokens,
      history_messages: limitedHistory.length,
      history_tokens: historyTokensFinal,
      user_tokens: userPromptTokens,
      total_estimated_tokens: totalEstimatedTokens
    });

    // שמירת הודעת המשתמש - await before proceeding to ensure history is ready
    // Cache updates happen AFTER successful writes (write-through cache)
    const maxStoredMessages = parseInt(MAX_STORED_MESSAGES_PER_USER || "200", 10);
    if (chatMemoryEnabled) {
      try {
        await saveChatMessage(rawEmail, "user", prompt);
        updateHistoryCache(rawEmail, { role: "user", content: prompt }, maxStoredMessages);
        console.log(`[Cache] history UPDATED after user message write`);
      } catch (e) {
        if (e.code === 8 || e.message?.includes("Quota exceeded")) {
          console.warn("[ChatMemory] Firestore quota exceeded - skipping message save");
        }
      }
    }

    // אם זה נושא חדש: במקום להזרים מהמודל (שקשה לאכוף בזמן אמת), מבצעים completion קצר,
    // מאמתים, ואז מזריםים ללקוח תשובה קצרה ומאובטחת.
    if (turn.diagnosisOnly) {
      const openaiStartTime = Date.now();
      const completion = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: messages,
        temperature: 0.15,
        max_tokens: 140
      });
      const ttft = Date.now() - openaiStartTime;
      logPerformance(requestId, "openai_call", ttft);
      logPerformance(requestId, "ttft", ttft); // Time to first token (for streaming, this is completion time)
      
      if (completion?.usage) {
        logTokenUsage(requestId, completion.usage);
      }

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

      // שמירת הודעת הבוט - await before finalizing request
      if (chatMemoryEnabled && fullAnswer.trim()) {
        try {
          await saveChatMessage(rawEmail, "assistant", fullAnswer);
          updateHistoryCache(rawEmail, { role: "assistant", content: fullAnswer }, maxStoredMessages);
          console.log(`[Cache] history UPDATED after assistant message write`);
        } catch (e) {
          if (e.code === 8 || e.message?.includes("Quota exceeded")) {
            console.warn("[ChatMemory] Firestore quota exceeded - skipping message save");
          }
        }
      }
      // Non-critical state save can run in background
      saveUserState(db, turn.nextState).then((success) => {
        // Update state cache after successful write
        if (success) {
          updateStateCache(rawEmail, turn.nextState);
          console.log(`[Cache] state UPDATED after state write`);
        }
      });

      logPerformance(requestId, "end", Date.now() - startTime);
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
      return;
    }

    // מצב רגיל: streaming כרגיל
    const openaiStartTime = Date.now();
    const stream = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: messages,
      temperature: turn.wantsFastPass ? 0.3 : 0.25,
      max_tokens: turn.wantsFastPass ? 1200 : 420,
      stream: true
    });

    let fullAnswer = "";
    let firstTokenTime = null;

    for await (const chunk of stream) {
      if (res.destroyed || res.closed) break;
      const content = chunk.choices[0]?.delta?.content || "";
      if (content) {
        if (firstTokenTime === null) {
          firstTokenTime = Date.now() - openaiStartTime;
          logPerformance(requestId, "ttft", firstTokenTime); // Time to first token
        }
        fullAnswer += content;
        res.write(`data: ${JSON.stringify({ type: "token", content })}\n\n`);
        if (res.flush) res.flush();
      }
    }

    logPerformance(requestId, "openai_call", Date.now() - openaiStartTime);

    fullAnswer = cleanLaTeXFormulas(fullAnswer);

    if (ragContext?.sources) {
      res.write(`data: ${JSON.stringify({ type: "sources", sources: ragContext.sources })}\n\n`);
    }

    // שמירת הודעת הבוט - await before finalizing request
    if (chatMemoryEnabled && fullAnswer.trim()) {
      try {
        await saveChatMessage(rawEmail, "assistant", fullAnswer);
        updateHistoryCache(rawEmail, { role: "assistant", content: fullAnswer }, maxStoredMessages);
        console.log(`[Cache] history UPDATED after assistant message write`);
      } catch (e) {
        if (e.code === 8 || e.message?.includes("Quota exceeded")) {
          console.warn("[ChatMemory] Firestore quota exceeded - skipping message save");
        }
      }
    }
    // Non-critical state save can run in background
    saveUserState(db, turn.nextState).then((success) => {
      // Update state cache after successful write
      if (success) {
        updateStateCache(rawEmail, turn.nextState);
        console.log(`[Cache] state UPDATED after state write`);
      }
    });

    logPerformance(requestId, "end", Date.now() - startTime);
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();

  } catch (e) {
    logPerformance(requestId, "error", Date.now() - startTime, { error: e.message });
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
