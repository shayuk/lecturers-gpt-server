// topicState.js - Topic State Machine + Enforcement for Galibot
// מטרת הקובץ: לאפשר "אבחון קודם להסבר" בצורה אמינה (stateful) ולחסום תשובות ארוכות בהודעה הראשונה של נושא חדש.

import admin from "firebase-admin";

// ניתן לשנות שם קולקציה דרך ENV בלי לשבור לאחור
const STATE_COLLECTION = process.env.GALIBOT_STATE_COLLECTION || "galibot_user_state_v1";

/**
 * מזהי נושאים (מינימלי, אך מספיק כדי לייצב התנהגות).
 * הערה: אפשר להרחיב בהמשך בלי לשנות לוגיקה.
 */
export const TOPIC_HEBREW = {
  mean: "ממוצע",
  median: "חציון",
  mode: "שכיח",
  std: "סטיית תקן",
  variance: "שונות",
  z: "ציון תקן (Z)",
  t: "מבחן t",
  correlation: "מתאם",
  regression: "רגרסיה",
  sampling_distribution: "התפלגות דגימה",
  confidence_interval: "רווח סמך",
  hypothesis_testing: "בדיקת השערות",
  anova: "ANOVA (אנובה)",
  chi_square: "חי-בריבוע",
  cronbach_alpha: "אלפא של קרונבאך",
  unknown: "הנושא",
};

const TOPIC_RULES = [
  { id: "mean", patterns: [/\bmean\b/i, /ממוצע/] },
  { id: "median", patterns: [/\bmedian\b/i, /חציון/] },
  { id: "mode", patterns: [/\bmode\b/i, /שכיח/] },
  { id: "std", patterns: [/standard\s*deviation/i, /סטי(י|י)ת\s*תקן/, /סטיית\s*תקן/] },
  { id: "variance", patterns: [/\bvariance\b/i, /שונות/] },
  { id: "z", patterns: [/z[-\s]?score/i, /\bZ\b/, /ציון\s*תקן/] },
  { id: "t", patterns: [/t[-\s]?test/i, /מבחן\s*t/, /\bt\b/i] },
  { id: "correlation", patterns: [/correlation/i, /קורלציה/, /מתאם/] },
  { id: "regression", patterns: [/regression/i, /רגרס(יה|ייה)/] },
  { id: "sampling_distribution", patterns: [/sampling\s*distribution/i, /התפלגות\s*דגימה/] },
  { id: "confidence_interval", patterns: [/confidence\s*interval/i, /רווח\s*סמך/] },
  { id: "hypothesis_testing", patterns: [/hypothesis\s*test/i, /בדיקת\s*השערות/, /מבחן\s*השערות/] },
  { id: "anova", patterns: [/\banova\b/i, /אנובה/] },
  { id: "chi_square", patterns: [/chi[-\s]?square/i, /חי[-\s]?בריבוע/, /כי[-\s]?בריבוע/] },
  { id: "cronbach_alpha", patterns: [/cronbach/i, /אלפא/i, /קרונבאך/, /מהימנות/] },
];

function normalizeEmail(rawEmail) {
  return (rawEmail || "").toLowerCase().trim();
}

export function detectTopic(userText) {
  const text = (userText || "").trim();
  for (const rule of TOPIC_RULES) {
    if (rule.patterns.some((p) => p.test(text))) return rule.id;
  }
  return "unknown";
}

export function isFastPassRequest(userText) {
  const t = (userText || "").toLowerCase();
  // טריגרים שהוגדרו בפרומפט
  return (
    t.includes("final:") ||
    t.includes("answer:") ||
    t.includes("full:") ||
    t.includes("פתור:") ||
    t.includes("תן לי פתרון מלא")
  );
}

export function defaultUserState(email) {
  return {
    email: normalizeEmail(email),
    currentTopic: null, // string topic id
    phase: "IDLE", // IDLE | DIAGNOSE | TEACH
    diagnosedTopics: {}, // { [topicId]: true }
    updatedAt: Date.now(),
  };
}

export async function loadUserState(db, email) {
  if (!db) return defaultUserState(email);

  const key = normalizeEmail(email);
  try {
    const ref = db.collection(STATE_COLLECTION).doc(key);
    const snap = await ref.get();
    if (!snap.exists) return defaultUserState(email);

    const data = snap.data() || {};
    return {
      email: key,
      currentTopic: data.currentTopic ?? null,
      phase: data.phase || "IDLE",
      diagnosedTopics: data.diagnosedTopics || {},
      updatedAt: Date.now(),
    };
  } catch (e) {
    console.warn("[GalibotState] loadUserState failed:", e?.message || e);
    // אם זו שגיאת quota, נחזיר מצב ברירת מחדל כדי לא לחסום את התגובה
    if (e.code === 8 || e.message?.includes("Quota exceeded") || e.message?.includes("RESOURCE_EXHAUSTED")) {
      console.warn("[GalibotState] Firestore quota exceeded - using default state");
    }
    return defaultUserState(email);
  }
}

export async function saveUserState(db, state) {
  if (!db || !state?.email) return false;

  try {
    const ref = db.collection(STATE_COLLECTION).doc(normalizeEmail(state.email));
    await ref.set(
      {
        email: normalizeEmail(state.email),
        currentTopic: state.currentTopic ?? null,
        phase: state.phase || "IDLE",
        diagnosedTopics: state.diagnosedTopics || {},
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  } catch (e) {
    console.warn("[GalibotState] saveUserState failed:", e?.message || e);
    // אם זו שגיאת quota, נדלג על השמירה (לא קריטי)
    if (e.code === 8 || e.message?.includes("Quota exceeded") || e.message?.includes("RESOURCE_EXHAUSTED")) {
      console.warn("[GalibotState] Firestore quota exceeded - skipping state save");
    }
    return false;
  }
}

function countSentencesHeuristically(text) {
  // פיצול גס לפי סימני סוף משפט נפוצים
  return (text || "")
    .replace(/\n+/g, " ")
    .split(/[.!?…]|\u05C3/) // כולל סוף פסוק עברי
    .map((s) => s.trim())
    .filter(Boolean).length;
}

function hasForbiddenDiagnosisContent(text) {
  const forbidden = [
    /\$\$/,
    /\$(?!\s)/, // כל דולר יחיד (לרוב נוסחה)
    /\\frac|\\mu|\\sigma|\\sum|\\sqrt|\\int/, // LaTeX
    /=/, // כמעט תמיד נוסחאות/השוואות ארוכות
    /1️⃣|2️⃣|3️⃣|\b1\.|\b2\.|\b3\.|\-\s/, // מספור/רשימות
    /הגדרה|דוגמה|נוסחה|נוסחאות|משוואה|מאפיינים/, // מילות "הסבר"
    /חומרים|קורפוס|RAG|Dr\.?\s*Galit|גלית\s*מדר|מדר/, // לא רוצים בהודעת אבחון
  ];
  return forbidden.some((rx) => rx.test(text || ""));
}

export function isValidDiagnosisOnlyOutput(output) {
  const text = (output || "").trim();
  if (!text) return false;
  if (text.length > 320) return false;
  if (countSentencesHeuristically(text) > 2) return false;
  if (!text.includes("?")) return false;
  // רצוי לא יותר מ-2 סימני שאלה (1-2 שאלות)
  const qCount = (text.match(/\?/g) || []).length;
  if (qCount > 2) return false;
  if (hasForbiddenDiagnosisContent(text)) return false;
  return true;
}

export function forcedDiagnosticTemplate(topicId) {
  const topicName = TOPIC_HEBREW[topicId] || TOPIC_HEBREW.unknown;

  if (topicId === "unknown") {
    return "שאלה מצוינת 🙂 על איזה נושא בסטטיסטיקה אתה רוצה ללמוד? ומה אתה כבר יודע עליו?";
  }

  return `שאלה מצוינת 🙂 לפני שנתחיל—מה אתה כבר יודע על ${topicName}? יצא לך להשתמש בזה בעבר?`;
}

export function applyDiagnosisEnforcement(systemPrompt) {
  // אכיפה קשיחה בצד שרת (בתוך system), כדי לצמצם סיכוי ל"dump".
  return (
    (systemPrompt || "") +
    `\n\n` +
    `🚨 BACKEND ENFORCEMENT (HARD) 🚨\n` +
    `This turn is DIAGNOSIS-ONLY.\n` +
    `You MUST output ONLY 1–2 diagnostic questions in Hebrew.\n` +
    `NO explanations, NO definitions, NO examples, NO formulas, NO lists.\n` +
    `Max 2 sentences, max 2 question marks.\n` +
    `Do NOT mention corpus/materials/RAG/server.\n`
  );
}

// פונקציה לזיהוי אם המשתמש עונה על שאלה רב-בררתית
function isAnswerToMultipleChoice(prompt) {
  const text = (prompt || "").trim();
  // מזהה תשובות כמו "A)", "B)", "C)", "D)", "A", "B", "C", "D"
  // או תשובות שמתחילות עם אות ואז סוגריים או נקודה
  const answerPattern = /^[A-D][\)\.]\s*/i;
  // או תשובה שמכילה רק אות אחת (A, B, C, D)
  const singleLetterPattern = /^[A-D]$/i;
  // או תשובה שמתחילה עם אות ואז טקסט (כמו "A) התפלגות...")
  const answerWithTextPattern = /^[A-D][\)\.]\s+.+/i;
  
  return answerPattern.test(text) || singleLetterPattern.test(text) || answerWithTextPattern.test(text);
}

export function decideTurn(prompt, state) {
  const explicitTopic = detectTopic(prompt);
  const wantsFastPass = isFastPassRequest(prompt);
  const isAnswer = isAnswerToMultipleChoice(prompt);

  const currentTopic = state?.currentTopic || null;
  const diagnosedTopics = state?.diagnosedTopics || {};
  const phase = state?.phase || "IDLE";

  const hasActiveTopic = !!currentTopic;
  const topicChanged = explicitTopic !== "unknown" && explicitTopic !== currentTopic;

  const activeTopic = explicitTopic !== "unknown" ? explicitTopic : (currentTopic || "unknown");

  // מתי חייבים אבחון?
  let diagnosisOnly = false;

  if (!wantsFastPass) {
    // אם המשתמש עונה על שאלה (A, B, C, D), זה לא אבחון - זה תשובה לשאלה קיימת
    if (isAnswer && phase === "DIAGNOSE") {
      // המשתמש עונה על שאלת אבחון - עוברים למצב TEACH
      diagnosisOnly = false;
    } else if (activeTopic === "unknown" && !hasActiveTopic) {
      // אין לנו מושג מה הנושא — קודם מאבחנים
      diagnosisOnly = true;
    } else if (topicChanged) {
      // עברו לנושא אחר — אם לא בוצע אבחון לנושא הזה בעבר, מבצעים
      diagnosisOnly = !diagnosedTopics[explicitTopic];
    } else if (!hasActiveTopic && explicitTopic !== "unknown") {
      // תחילת שיחה על נושא מזוהה
      diagnosisOnly = !diagnosedTopics[explicitTopic];
    } else if (phase === "IDLE" && activeTopic !== "unknown") {
      // שמירה על כלל "אבחון קודם" גם אם מצב לא התעדכן טוב
      diagnosisOnly = !diagnosedTopics[activeTopic];
    }
  }

  // עדכון state (נחסוך לוגיקה כפולה בשרת)
  const nextState = {
    ...defaultUserState(state?.email || ""),
    ...state,
    currentTopic: activeTopic === "unknown" ? currentTopic : activeTopic,
    phase: diagnosisOnly ? "DIAGNOSE" : (activeTopic === "unknown" ? "IDLE" : "TEACH"),
    diagnosedTopics: { ...diagnosedTopics },
    updatedAt: Date.now(),
  };

  // אם אנחנו שואלים שאלות אבחון לנושא מזוהה — מסמנים שכבר "נכנסנו" לנושא
  if (diagnosisOnly && activeTopic !== "unknown") {
    nextState.diagnosedTopics[activeTopic] = true;
  }
  
  // אם המשתמש עונה על שאלה (A/B/C/D) במצב DIAGNOSE, עוברים למצב TEACH
  if (isAnswer && phase === "DIAGNOSE" && activeTopic !== "unknown") {
    nextState.phase = "TEACH";
    nextState.diagnosedTopics[activeTopic] = true; // מסמנים שכבר בוצע אבחון
  }

  // רמז ל-RAG: אם המשתמש עונה על אבחון בלי לציין את שם הנושא, נוסיף אותו לשאילתת החיפוש
  const ragQuery = (activeTopic !== "unknown" && explicitTopic === "unknown")
    ? `${TOPIC_HEBREW[activeTopic] || ""} ${prompt}`.trim()
    : prompt;

  return {
    explicitTopic,
    activeTopic,
    wantsFastPass,
    diagnosisOnly,
    ragQuery,
    nextState,
  };
}
