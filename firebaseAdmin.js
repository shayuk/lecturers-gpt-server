import admin from "firebase-admin";

const rawKey = process.env.FIREBASE_PRIVATE_KEY || "";
const normalizedKey = rawKey.replace(/\\n/g, "\n").replace(/\r/g, "").trim();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: normalizedKey,
    }),
  });
}

export const auth = admin.auth();
export const db = admin.firestore();
