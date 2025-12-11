// chatMemory.js - מערכת זיכרון לשיחות צ'אט עם Firestore
import admin from "firebase-admin";

let firestoreDb = null;
const MAX_HISTORY_MESSAGES = parseInt(process.env.MAX_HISTORY_MESSAGES || "20", 10);
const MAX_STORED_MESSAGES_PER_USER = parseInt(process.env.MAX_STORED_MESSAGES_PER_USER || "200", 10);

/**
 * אתחול מערכת הזיכרון
 * @param {Firestore} firestoreInstance - מופע Firestore
 */
export function initChatMemory(firestoreInstance) {
  firestoreDb = firestoreInstance;
  if (firestoreDb) {
    console.log(`[ChatMemory] Initialized with Firestore. Max history: ${MAX_HISTORY_MESSAGES}, Max stored: ${MAX_STORED_MESSAGES_PER_USER}`);
    return true;
  } else {
    console.warn("[ChatMemory] Firestore not available - memory will be disabled");
    return false;
  }
}

/**
 * שמירת הודעת צ'אט ב-Firestore
 * @param {string} userId - מזהה משתמש (email)
 * @param {string} role - תפקיד ההודעה: "user" או "assistant"
 * @param {string} content - תוכן ההודעה
 * @param {object} metadata - מטא-דאטה אופציונלי (sessionId, topic, etc.)
 * @returns {Promise<string>} - ID של ההודעה שנשמרה
 */
export async function saveChatMessage(userId, role, content, metadata = {}) {
  if (!firestoreDb) {
    console.warn("[ChatMemory] Cannot save message - Firestore not initialized");
    return null;
  }

  if (!userId || !role || !content) {
    console.warn("[ChatMemory] Missing required fields for saving message");
    return null;
  }

  try {
    const messageData = {
      userId: userId.toLowerCase().trim(),
      role: role, // "user" או "assistant"
      content: content.trim(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      ...metadata
    };

    const docRef = await firestoreDb.collection("chat_messages").add(messageData);
    console.log(`[ChatMemory] Saved ${role} message for user ${userId.substring(0, 10)}... (ID: ${docRef.id})`);

    // ניקוי הודעות ישנות - שמירה רק על ה-MAX_STORED_MESSAGES_PER_USER האחרונות
    await cleanupOldMessages(userId);

    return docRef.id;
  } catch (error) {
    console.error("[ChatMemory] Error saving message:", error);
    return null;
  }
}

/**
 * טעינת היסטוריית השיחה של משתמש
 * @param {string} userId - מזהה משתמש (email)
 * @param {number} limit - מספר ההודעות האחרונות לטעון (default: MAX_HISTORY_MESSAGES)
 * @returns {Promise<Array>} - מערך של הודעות בפורמט OpenAI messages
 */
export async function getUserConversationHistory(userId, limit = MAX_HISTORY_MESSAGES) {
  if (!firestoreDb) {
    console.warn("[ChatMemory] Cannot load history - Firestore not initialized");
    return [];
  }

  if (!userId) {
    console.warn("[ChatMemory] Missing userId for loading history");
    return [];
  }

  try {
    const normalizedUserId = userId.toLowerCase().trim();
    
    // טעינת ההודעות האחרונות של המשתמש, ממוינות לפי זמן (הכי ישן ראשון)
    const snapshot = await firestoreDb
      .collection("chat_messages")
      .where("userId", "==", normalizedUserId)
      .orderBy("createdAt", "asc")
      .limit(MAX_STORED_MESSAGES_PER_USER) // נטען יותר כדי לסנן אחר כך
      .get();

    if (snapshot.empty) {
      console.log(`[ChatMemory] No history found for user ${normalizedUserId.substring(0, 10)}...`);
      return [];
    }

    // המרה ל-array וממיון לפי זמן (הכי ישן ראשון)
    let messages = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        role: data.role, // "user" או "assistant"
        content: data.content
      };
    });

    // לוקח רק את ה-limit האחרונות (אם יש יותר מ-limit)
    if (messages.length > limit) {
      messages = messages.slice(-limit);
    }

    console.log(`[ChatMemory] Loaded ${messages.length} messages for user ${normalizedUserId.substring(0, 10)}...`);
    return messages;
  } catch (error) {
    console.error("[ChatMemory] Error loading conversation history:", error);
    return [];
  }
}

/**
 * ניקוי הודעות ישנות - שמירה רק על ה-MAX_STORED_MESSAGES_PER_USER האחרונות
 * @param {string} userId - מזהה משתמש (email)
 */
async function cleanupOldMessages(userId) {
  if (!firestoreDb) return;

  try {
    const normalizedUserId = userId.toLowerCase().trim();
    
    // טעינת כל ההודעות של המשתמש
    const snapshot = await firestoreDb
      .collection("chat_messages")
      .where("userId", "==", normalizedUserId)
      .orderBy("createdAt", "desc")
      .get();

    if (snapshot.size <= MAX_STORED_MESSAGES_PER_USER) {
      return; // אין צורך בניקוי
    }

    // מחיקת ההודעות הישנות ביותר (מעבר ל-MAX_STORED_MESSAGES_PER_USER)
    const messagesToDelete = snapshot.docs.slice(MAX_STORED_MESSAGES_PER_USER);
    const batch = firestoreDb.batch();
    
    messagesToDelete.forEach(doc => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    console.log(`[ChatMemory] Cleaned up ${messagesToDelete.length} old messages for user ${normalizedUserId.substring(0, 10)}...`);
  } catch (error) {
    console.error("[ChatMemory] Error cleaning up old messages:", error);
    // לא נזרוק שגיאה - זה לא קריטי
  }
}

/**
 * מחיקת כל ההיסטוריה של משתמש (לצורך privacy/GDPR)
 * @param {string} userId - מזהה משתמש (email)
 */
export async function deleteUserHistory(userId) {
  if (!firestoreDb) {
    console.warn("[ChatMemory] Cannot delete history - Firestore not initialized");
    return false;
  }

  try {
    const normalizedUserId = userId.toLowerCase().trim();
    
    const snapshot = await firestoreDb
      .collection("chat_messages")
      .where("userId", "==", normalizedUserId)
      .get();

    if (snapshot.empty) {
      return true; // אין מה למחוק
    }

    const batch = firestoreDb.batch();
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    console.log(`[ChatMemory] Deleted ${snapshot.size} messages for user ${normalizedUserId.substring(0, 10)}...`);
    return true;
  } catch (error) {
    console.error("[ChatMemory] Error deleting user history:", error);
    return false;
  }
}

