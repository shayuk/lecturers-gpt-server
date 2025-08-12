import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { OpenAI } from "openai";
import { auth, db } from "./firebaseAdmin.js";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, status: "Lecturers GPT server is up" });
});

app.post("/api/ask", async (req, res) => {
  try {
    const { email, prompt, meta } = req.body || {};

    // 0) Basic required fields
    if (!email || !prompt) {
      return res.status(400).json({ error: "email and prompt are required" });
    }

    // 1) Normalize email (trim + lowercase)
    const normalizedEmail = String(email).trim().toLowerCase();

    // 2) Enforce organizational domain
    const allowedDomains = ["ariel.ac.il"];
    const emailDomain = normalizedEmail.split("@").pop();
    if (!allowedDomains.includes(emailDomain)) {
      return res.status(403).json({
        error:
          "הגישה מוגבלת למרצים מורשים עם דומיין אוניברסיטאי. אם יש בעיה בהרשאה, ניתן לפנות לרשות לחדשנות בהוראה של אוניברסיטת אריאל בכתובת: teachinginnovation@ariel.ac.il"
      });
    }

    // 3) Block attempts to reveal internal instructions/actions
    const forbiddenKeywords = [
      "instructions", "system prompt", "internal instructions",
      "actions", "openapi", "schema", "setup", "configuration", "internal policy",
      "הנחיות", "פרומפט מערכת", "הוראות פנימיות",
      "אקשן", "אקשנס", "סקימה", "סכימה", "קונפיגורציה", "פרטים על האקשן"
    ];
    const p = String(prompt || "").toLowerCase();
    if (forbiddenKeywords.some(k => p.includes(k))) {
      // Security log (best-effort)
      try {
        await db.collection("security_logs").add({
          type: "prompt_exfiltration_attempt",
          email: normalizedEmail,
          timestamp: new Date().toISOString(),
          promptPreview: String(prompt).slice(0, 200)
        });
      } catch (e) {
        console.warn("security_logs write failed:", e?.message || e);
      }

      return res.json({
        answer:
          "מצטער אך איני יכול לספק מידע זה. לפרטים נוספים ניתן לפנות לרשות לחדשנות בהוראה של אוניברסיטת אריאל בכתובת: teachinginnovation@ariel.ac.il"
      });
    }

    // 4) Verify the user exists in Firebase Auth
    try {
      await auth.getUserByEmail(normalizedEmail);
    } catch (e) {
      console.error("getUserByEmail failed:", e?.code, e?.message);
      return res.status(403).json({
        error:
          "הגישה מוגבלת למרצים מורשים. כתובת המייל שהוזנה אינה נמצאת ברשימת המורשים. ניתן לפנות לרשות לחדשנות בהוראה של אוניברסיטת אריאל לפרטים נוספים בכתובת: teachinginnovation@ariel.ac.il"
      });
    }

    // 5) Ask OpenAI
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: "You are a helpful university lecturers assistant." },
        { role: "user", content: prompt }
      ]
    });

    const answer = completion.choices?.[0]?.message?.content ?? "";
    const usage = completion.usage || {};

    // 6) Log usage (best-effort)
    try {
      await db.collection("usage_logs").add({
        email: normalizedEmail,
        timestamp: new Date().toISOString(),
        tokens: usage,
        model: MODEL,
        meta: meta || null,
        promptPreview: String(prompt).slice(0, 200)
      });
    } catch (e) {
      console.warn("usage_logs write failed:", e?.message || e);
    }

    // 7) Add a small contact banner to every answer (optional but handy)
    const banner = "*(לשאלות: teachinginnovation@ariel.ac.il)*\n\n";
    const finalAnswer = banner + answer;

    res.json({ answer: finalAnswer, usage, model: MODEL });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", details: String(err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
