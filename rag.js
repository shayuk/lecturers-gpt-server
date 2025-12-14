// rag.js - מערכת RAG לשאילתה בחומרי הקורס (עם Firestore)
import OpenAI from "openai";

let openaiEmbeddings = null;
let firestoreDb = null;

// אתחול RAG עם Firestore
export function initRAG(openaiApiKey, firestoreInstance) {
  if (!openaiApiKey) {
    console.warn("[RAG] Missing OPENAI_API_KEY - RAG will be disabled");
    return false;
  }

  openaiEmbeddings = new OpenAI({ apiKey: openaiApiKey });
  firestoreDb = firestoreInstance;

  if (firestoreDb) {
    console.log("[OK] RAG initialized with Firestore");
    return true;
  } else {
    console.warn("[RAG] Firestore not available - RAG will be disabled");
    return false;
  }
}

// יצירת embeddings לטקסט
async function createEmbedding(text) {
  if (!openaiEmbeddings) {
    throw new Error("OpenAI embeddings not initialized");
  }

  try {
    const response = await openaiEmbeddings.embeddings.create({
      model: "text-embedding-3-small", // או text-embedding-ada-002
      input: text,
    });
    return response.data[0].embedding;
  } catch (e) {
    console.error("[Embedding Error]", e);
    throw e;
  }
}

// חישוב cosine similarity בין שני וקטורים
function cosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// שאילתה ב-RAG - מחזיר את הטקסטים הרלוונטיים ביותר
export async function queryRAG(queryText, topK = 3) {
  if (!firestoreDb || !openaiEmbeddings) {
    return { chunks: [], sources: [] };
  }

  try {
    console.log(`[RAG] Querying for: "${queryText.substring(0, 50)}..."`);
    
    // יצירת embedding לשאילתה
    const queryEmbedding = await createEmbedding(queryText);
    console.log(`[RAG] Created query embedding, dimension: ${queryEmbedding.length}`);

    // קבלת כל ה-chunks מ-Firestore עם הגבלה קטנה יותר (200 במקום 500) כדי לשפר ביצועים
    const chunksSnapshot = await firestoreDb.collection("rag_chunks").limit(200).get();
    console.log(`[RAG] Found ${chunksSnapshot.size} chunks in database`);
    
    if (chunksSnapshot.empty) {
      console.warn("[RAG] No chunks found in database");
      return { chunks: [], sources: [] };
    }

    // חישוב similarity לכל chunk (עם הגבלת זמן קצרה יותר)
    const similarities = [];
    const startTime = Date.now();
    const MAX_PROCESSING_TIME = 5000; // 5 שניות מקסימום (הוקטן מ-20)
    let processedCount = 0;
    let skippedCount = 0;
    
    // המרה ל-array כדי לשפר ביצועים
    const chunksArray = chunksSnapshot.docs;
    
    // חישוב similarity במקביל בקבוצות קטנות כדי לשפר ביצועים
    const BATCH_SIZE = 50; // מעבד 50 chunks בכל פעם
    for (let batchStart = 0; batchStart < chunksArray.length; batchStart += BATCH_SIZE) {
      // בדיקת timeout
      if (Date.now() - startTime > MAX_PROCESSING_TIME) {
        console.warn(`[RAG] Query timeout after ${processedCount} chunks - stopping similarity calculation`);
        break;
      }

      const batchEnd = Math.min(batchStart + BATCH_SIZE, chunksArray.length);
      const batch = chunksArray.slice(batchStart, batchEnd);
      
      // עיבוד ה-batch במקביל
      const batchPromises = batch.map(async (doc) => {
        const data = doc.data();
        const chunkEmbedding = data.embedding;
        
        if (!chunkEmbedding || !Array.isArray(chunkEmbedding)) {
          skippedCount++;
          return null;
        }
        
        // בדיקת dimension
        if (chunkEmbedding.length !== queryEmbedding.length) {
          skippedCount++;
          return null;
        }
        
        try {
          const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);
          return {
            id: doc.id,
            text: data.text || "",
            source: data.source || "unknown",
            course_name: data.course_name || "",
            similarity: similarity,
            metadata: data.metadata || {},
          };
        } catch (simError) {
          skippedCount++;
          return null;
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      const validResults = batchResults.filter(r => r !== null);
      similarities.push(...validResults);
      processedCount += validResults.length;
    }

    console.log(`[RAG] Processed ${processedCount} chunks, skipped ${skippedCount}`);

    // מיון לפי similarity וקבלת ה-topK
    similarities.sort((a, b) => b.similarity - a.similarity);
    const topResults = similarities.slice(0, topK);
    
    console.log(`[RAG] Top ${topResults.length} results, similarity range: ${topResults.length > 0 ? `${topResults[topResults.length - 1].similarity.toFixed(3)} - ${topResults[0].similarity.toFixed(3)}` : 'none'}`);

    // עיבוד התוצאות - הורדנו את ה-filter ל-0.1 במקום 0.3
    const chunks = [];
    const sources = [];
    const seenSources = new Set(); // למניעת כפילויות של מקורות

    for (const result of topResults) {
      // הורדנו את ה-filter ל-0.05 כדי לקבל יותר תוצאות
      if (result.text && result.similarity > 0.05) {
        chunks.push(result.text);
        
        // הוספת source רק אם לא ראינו אותו קודם (לפי שם קובץ)
        const sourceName = result.source || "unknown";
        const normalizedSource = sourceName.split('/').pop().split('\\').pop();
        
        if (!seenSources.has(normalizedSource)) {
          seenSources.add(normalizedSource);
          sources.push({
            source: result.source,
            score: result.similarity,
            course_name: result.course_name,
            metadata: result.metadata,
          });
        }
      }
    }

    console.log(`[RAG] Returning ${chunks.length} chunks after filtering (similarity > 0.05), ${sources.length} unique sources`);
    return { chunks, sources };
  } catch (e) {
    console.error("[RAG Query Error]", e);
    // אם זו שגיאת quota, נחזיר מערך ריק כדי לא לחסום את התגובה
    if (e.code === 8 || e.message?.includes("Quota exceeded") || e.message?.includes("RESOURCE_EXHAUSTED")) {
      console.warn("[RAG] Firestore quota exceeded - returning empty results to avoid blocking response");
    }
    return { chunks: [], sources: [] };
  }
}

// העלאת מסמך ל-RAG (chunking + embeddings)
export async function uploadDocumentToRAG(text, metadata = {}) {
  if (!firestoreDb || !openaiEmbeddings) {
    throw new Error("RAG not initialized");
  }

  try {
    // חלוקה לקטעים (chunks)
    const chunks = splitTextIntoChunks(text, 500, 100); // 500 תווים, 100 overlap
    console.log(`[RAG] Split text into ${chunks.length} chunks`);

    let uploadedCount = 0;

    // עיבוד chunks בקבוצות קטנות כדי לחסוך זיכרון
    const BATCH_SIZE = 3; // מעבד 3 chunks בכל פעם (הוקטן כדי לחסוך זיכרון)
    
    for (let batchStart = 0; batchStart < chunks.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, chunks.length);
      const batch = chunks.slice(batchStart, batchEnd);
      
      // עיבוד כל ה-batch ברצף (לא במקביל) כדי לחסוך זיכרון
      for (let batchIndex = 0; batchIndex < batch.length; batchIndex++) {
        const chunk = batch[batchIndex];
        const i = batchStart + batchIndex;
        
        try {
          const embedding = await createEmbedding(chunk);
          
          // שמירה ב-Firestore
          await firestoreDb.collection("rag_chunks").add({
            text: chunk,
            embedding: embedding,
            chunk_index: i,
            source: metadata.source || "unknown",
            course_name: metadata.course_name || "statistics",
            uploaded_by: metadata.uploaded_by || "",
            uploaded_at: metadata.uploaded_at || new Date().toISOString(),
            metadata: {
              ...metadata,
              total_chunks: chunks.length,
            },
          });

          uploadedCount++;
          
          // ניקוי זיכרון - מנסה לשחרר את ה-embedding מהזיכרון
          if (global.gc) {
            global.gc();
          }
        } catch (chunkError) {
          console.error(`[RAG] Error processing chunk ${i + 1}:`, chunkError);
          // ממשיכים עם ה-chunk הבא
        }
      }
      
      // Log progress כל batch
      console.log(`[RAG] Progress: ${batchEnd}/${chunks.length} chunks uploaded`);
      
      // המתנה בין batches כדי לא להעמיס על ה-API ולאפשר garbage collection
      if (batchEnd < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay
      }
    }

    console.log(`[RAG] Uploaded ${uploadedCount} chunks to Firestore`);
    return { chunksCount: uploadedCount };
  } catch (e) {
    console.error("[RAG Upload Error]", e);
    throw e;
  }
}

// פונקציה לחלוקת טקסט לקטעים
function splitTextIntoChunks(text, chunkSize = 500, overlap = 100) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    let chunk = text.slice(start, end);

    // מנסה לחתוך במשפט שלם אם אפשר
    if (end < text.length) {
      const lastPeriod = chunk.lastIndexOf(".");
      const lastNewline = chunk.lastIndexOf("\n");
      const cutPoint = Math.max(lastPeriod, lastNewline);

      if (cutPoint > chunkSize * 0.5) {
        chunk = chunk.slice(0, cutPoint + 1);
        start += cutPoint + 1 - overlap;
      } else {
        start += chunkSize - overlap;
      }
    } else {
      start = text.length;
    }

    chunks.push(chunk.trim());
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

// שאילתה משולבת - מחזירה context מוכן ל-LLM
export async function getRAGContext(queryText, topK = 3) {
  const { chunks, sources } = await queryRAG(queryText, topK);

  if (chunks.length === 0) {
    return null;
  }

  // בניית context string
  const context = chunks
    .map((chunk, i) => {
      const source = sources[i];
      return `[מקור ${i + 1}${source.source ? `: ${source.source}` : ""}]\n${chunk}`;
    })
    .join("\n\n---\n\n");

  return {
    context,
    sources,
    chunksCount: chunks.length,
  };
}

