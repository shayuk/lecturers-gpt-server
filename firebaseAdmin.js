// firebaseAdmin.js
import admin from "firebase-admin";

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

const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
}

export const auth = admin.auth();
export const db = admin.firestore();
