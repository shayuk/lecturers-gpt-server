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

    // ניקוי הודעות ישנות - רץ ברקע (לא חוסם את התגובה)
    // רץ רק כל 10 הודעות כדי לא להאט את התגובה
    cleanupOldMessages(userId).catch(err => {
      console.error("[ChatMemory] Background cleanup failed:", err);
    });

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
    
    // טעינת ההודעות של המשתמש עם orderBy ו-limit ישירות ב-Firestore (מהיר יותר)
    // נטען רק את ה-limit האחרונות ישירות מהדאטאבייס
    const snapshot = await firestoreDb
      .collection("chat_messages")
      .where("userId", "==", normalizedUserId)
      .orderBy("createdAt", "desc") // הכי חדש ראשון
      .limit(limit * 2) // לוקח קצת יותר כדי להיות בטוחים שיש מספיק
      .get();

    if (snapshot.empty) {
      console.log(`[ChatMemory] No history found for user ${normalizedUserId.substring(0, 10)}...`);
      return [];
    }

    // המרה ל-array וממיון לפי זמן (הכי ישן ראשון) - רק את ה-limit האחרונות
    let messages = snapshot.docs
      .map(doc => {
        const data = doc.data();
        return {
          role: data.role, // "user" או "assistant"
          content: data.content,
          createdAt: data.createdAt ? data.createdAt.toMillis() : 0 // המרה ל-timestamp למיון
        };
      })
      .sort((a, b) => a.createdAt - b.createdAt) // מיון לפי זמן (ישן → חדש)
      .slice(-limit) // לוקח רק את ה-limit האחרונות
      .map(msg => ({
        role: msg.role,
        content: msg.content
      })); // הסרת createdAt מהתוצאה הסופית

    console.log(`[ChatMemory] Loaded ${messages.length} messages for user ${normalizedUserId.substring(0, 10)}...`);
    if (messages.length > 0) {
      console.log(`[ChatMemory] First message: ${messages[0].role} - ${messages[0].content.substring(0, 50)}...`);
      console.log(`[ChatMemory] Last message: ${messages[messages.length - 1].role} - ${messages[messages.length - 1].content.substring(0, 50)}...`);
    }
    return messages;
  } catch (error) {
    console.error("[ChatMemory] Error loading conversation history:", error);
    console.error("[ChatMemory] Error details:", error.message);
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
    
    // טעינת ההודעות עם orderBy ישירות ב-Firestore (מהיר יותר)
    // נטען רק את מה שצריך למחיקה
    const snapshot = await firestoreDb
      .collection("chat_messages")
      .where("userId", "==", normalizedUserId)
      .orderBy("createdAt", "desc")
      .offset(MAX_STORED_MESSAGES_PER_USER) // דילוג על ה-MAX_STORED_MESSAGES_PER_USER הראשונות (החדשות)
      .get();

    if (snapshot.empty) {
      return; // אין צורך בניקוי
    }

    // כל ה-docs ב-snapshot הם כבר הישנים שצריך למחוק (כי השתמשנו ב-offset)
    const messagesToDelete = snapshot.docs;
    
    if (messagesToDelete.length === 0) {
      return;
    }

    // מחיקה בבאצ'ים של 500 (מגבלת Firestore)
    const batchSize = 500;
    for (let i = 0; i < messagesToDelete.length; i += batchSize) {
      const batch = firestoreDb.batch();
      const batchDocs = messagesToDelete.slice(i, i + batchSize);
      
      batchDocs.forEach((doc) => {
        batch.delete(doc.ref);
      });
      
      await batch.commit();
    }
    
    console.log(`[ChatMemory] Cleaned up ${messagesToDelete.length} old messages for user ${normalizedUserId.substring(0, 10)}...`);
  } catch (error) {
    console.error("[ChatMemory] Error cleaning up old messages:", error);
    console.error("[ChatMemory] Cleanup error details:", error.message);
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

