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
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, status: "Lecturers GPT server is up" });
});

app.post("/api/ask", async (req, res) => {
  try {
    const { email, prompt, meta } = req.body || {};
    if (!email || !prompt) {
      return res.status(400).json({ error: "email and prompt are required" });
    }

    // 1) Verify email exists in Firebase Auth
    try {
      await auth.getUserByEmail(email);
    } catch (e) {
      return res.status(403).json({ 
        error: "הגישה מוגבלת למרצים מורשים. כתובת המייל שהוזנה אינה נמצאת ברשימת המורשים. ניתן לפנות לרשות לחדשנות בהוראה של אוניברסיטת אריאל לפרטים נוספים בכתובת: teachinginnovation@ariel.ac.il" 
      });
    }

    // 2) Ask OpenAI
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: "You are a helpful university lecturers assistant." },
        { role: "user", content: prompt },
      ],
    });

    const answer = completion.choices?.[0]?.message?.content ?? "";
    const usage = completion.usage || {};

    // 3) Log usage
    const log = {
      email,
      timestamp: new Date().toISOString(),
      tokens: usage,
      model: MODEL,
      meta: meta || null,
      promptPreview: String(prompt).slice(0, 200),
    };
    await db.collection("usage_logs").add(log);

    res.json({ answer, usage, model: MODEL });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", details: String(err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
