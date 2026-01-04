// rag.js - מערכת RAG לשאילתה בחומרי הקורס (עם Firestore)
import OpenAI from "openai";

let openaiEmbeddings = null;
let firestoreDb = null;

// Cache לשאילתות RAG - מפחית קריאות ל-Firestore
const RAG_CACHE_TTL = 60000; // 60 שניות
const ragCache = new Map(); // { cacheKey: { data, timestamp } }

// יצירת מפתח cache לפי queryText ו-course_name
function getCacheKey(queryText, courseName) {
  return `${courseName || 'all'}_${queryText.substring(0, 50)}`;
}

// בדיקה אם יש cache תקף
function getCachedResult(cacheKey) {
  const cached = ragCache.get(cacheKey);
  if (!cached) return null;
  
  const age = Date.now() - cached.timestamp;
  if (age > RAG_CACHE_TTL) {
    ragCache.delete(cacheKey);
    return null;
  }
  
  return cached.data;
}

// שמירה ב-cache
function setCachedResult(cacheKey, data) {
  ragCache.set(cacheKey, {
    data: data,
    timestamp: Date.now()
  });
  
  // ניקוי cache ישן מדי פעם (אם יש יותר מ-100 entries)
  if (ragCache.size > 100) {
    const now = Date.now();
    for (const [key, value] of ragCache.entries()) {
      if (now - value.timestamp > RAG_CACHE_TTL) {
        ragCache.delete(key);
      }
    }
  }
}

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
export async function queryRAG(queryText, topK = 3, courseName = null, maxDocs = 200, timeoutMs = null, abortSignal = null) {
  if (!firestoreDb || !openaiEmbeddings) {
    return { chunks: [], sources: [], _metrics: { status: "disabled", rag_total_ms: 0 } };
  }

  const ragStartTime = Date.now();
  let retrievedCount = 0;
  let processedCount = 0;
  let returnedCount = 0;

  try {
    // בדיקת cache
    const cacheKey = getCacheKey(queryText, courseName);
    const cached = getCachedResult(cacheKey);
    if (cached) {
      const ragTotalMs = Date.now() - ragStartTime;
      console.log(`[RAG] Cache hit for query: "${queryText.substring(0, 50)}..." (course: ${courseName || 'all'})`);
      return { 
        ...cached, 
        _metrics: { 
          status: "cache_hit", 
          maxDocs, 
          retrieved_count: 0, 
          processed_count: 0, 
          returned_count: cached.chunks?.length || 0, 
          rag_total_ms: ragTotalMs 
        } 
      };
    }
    
    // If timeout is specified, wrap entire RAG pipeline in Promise.race
    if (timeoutMs && timeoutMs > 0) {
      // Create timeout promise that rejects immediately when timeout expires
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error("RAG_TIMEOUT"));
        }, timeoutMs);
      });

      // Wrap entire RAG work in Promise.race
      try {
        const result = await Promise.race([
          performRAGWork(queryText, topK, courseName, maxDocs, abortSignal, ragStartTime),
          timeoutPromise
        ]);
        return result;
      } catch (raceError) {
        // If timeout triggered, return timeout result immediately
        if (raceError.message === "RAG_TIMEOUT" || abortSignal?.aborted) {
          const ragTotalMs = Date.now() - ragStartTime;
          return { 
            chunks: [], 
            sources: [], 
            _metrics: { 
              status: "timeout", 
              maxDocs, 
              retrieved_count: retrievedCount, 
              processed_count: processedCount, 
              returned_count: 0, 
              rag_total_ms: ragTotalMs 
            } 
          };
        }
        throw raceError;
      }
    } else {
      // No timeout - proceed normally
      return await performRAGWork(queryText, topK, courseName, maxDocs, abortSignal, ragStartTime);
    }
  } catch (e) {
    const ragTotalMs = Date.now() - ragStartTime;
    // Don't log if aborted (timeout already handled)
    if (abortSignal?.aborted) {
      return { 
        chunks: [], 
        sources: [], 
        _metrics: { 
          status: "timeout", 
          maxDocs, 
          retrieved_count: retrievedCount, 
          processed_count: processedCount, 
          returned_count: 0, 
          rag_total_ms: ragTotalMs 
        } 
      };
    }
    console.error("[RAG Query Error]", e);
    // אם זו שגיאת quota, נחזיר מערך ריק כדי לא לחסום את התגובה
    if (e.code === 8 || e.message?.includes("Quota exceeded") || e.message?.includes("RESOURCE_EXHAUSTED")) {
      console.warn("[RAG] Firestore quota exceeded - returning empty results to avoid blocking response");
      return { 
        chunks: [], 
        sources: [], 
        _metrics: { 
          status: "quota_exceeded", 
          maxDocs, 
          retrieved_count: retrievedCount, 
          processed_count: processedCount, 
          returned_count: 0, 
          rag_total_ms: ragTotalMs 
        } 
      };
    }
    return { 
      chunks: [], 
      sources: [], 
      _metrics: { 
        status: "error", 
        maxDocs, 
        retrieved_count: retrievedCount, 
        processed_count: processedCount, 
        returned_count: 0, 
        rag_total_ms: ragTotalMs,
        error: e.message 
      } 
    };
  }
}

// Internal function that performs the actual RAG work (wrapped by Promise.race for timeout)
async function performRAGWork(queryText, topK, courseName, maxDocs, abortSignal, ragStartTime) {
  let retrievedCount = 0;
  let processedCount = 0;
  let returnedCount = 0;
  const cacheKey = getCacheKey(queryText, courseName);
  
  // Guard: check abort before starting
  if (abortSignal?.aborted) {
    throw new Error("RAG_TIMEOUT");
  }
  
  console.log(`[RAG] Querying for: "${queryText.substring(0, 50)}..." (course: ${courseName || 'all'}, maxDocs: ${maxDocs})`);
  
  // יצירת embedding לשאילתה
  const queryEmbedding = await createEmbedding(queryText);
  
  // Guard: check abort after embedding creation
  if (abortSignal?.aborted) {
    throw new Error("RAG_TIMEOUT");
  }
  
  if (!abortSignal?.aborted) {
    console.log(`[RAG] Created query embedding, dimension: ${queryEmbedding.length}`);
  }

  // שאילתה ממוקדת לפי course_name אם קיים, אחרת limit בלבד
  let query = firestoreDb.collection("rag_chunks");
  
  if (courseName) {
    // סינון לפי course_name - מפחית דרמטית את מספר ה-reads
    query = query.where("course_name", "==", courseName);
  }
  
  // הגבלה למספר מקסימלי של מסמכים
  query = query.limit(maxDocs);
  
  // Guard: check abort before Firestore query
  if (abortSignal?.aborted) {
    throw new Error("RAG_TIMEOUT");
  }
  
  const chunksSnapshot = await query.get();
  
  // Guard: check abort immediately after Firestore query
  if (abortSignal?.aborted) {
    throw new Error("RAG_TIMEOUT");
  }
  
  retrievedCount = chunksSnapshot.size;
  
  // Guard: only log if not aborted
  if (!abortSignal?.aborted) {
    console.log(`[RAG] Found ${retrievedCount} chunks in database${courseName ? ` (filtered by course: ${courseName})` : ''}`);
  }
  
  if (chunksSnapshot.empty) {
    const ragTotalMs = Date.now() - ragStartTime;
    if (!abortSignal?.aborted) {
      console.warn("[RAG] No chunks found in database");
    }
    return { 
      chunks: [], 
      sources: [], 
      _metrics: { 
        status: "no_chunks", 
        maxDocs, 
        retrieved_count: 0, 
        processed_count: 0, 
        returned_count: 0, 
        rag_total_ms: ragTotalMs 
      } 
    };
  }

  // חישוב similarity לכל chunk
  const similarities = [];
  let skippedCount = 0;
  
  // המרה ל-array כדי לשפר ביצועים
  const chunksArray = chunksSnapshot.docs;
  
  // חישוב similarity במקביל בקבוצות קטנות כדי לשפר ביצועים
  const BATCH_SIZE = 50; // מעבד 50 chunks בכל פעם
  for (let batchStart = 0; batchStart < chunksArray.length; batchStart += BATCH_SIZE) {
    // Guard: check abort before each batch
    if (abortSignal?.aborted) {
      break;
    }

    const batchEnd = Math.min(batchStart + BATCH_SIZE, chunksArray.length);
    const batch = chunksArray.slice(batchStart, batchEnd);
    
    // עיבוד ה-batch במקביל
    const batchPromises = batch.map(async (doc) => {
      // Guard: check abort before processing each doc
      if (abortSignal?.aborted) {
        return null;
      }
      
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
    
    // Guard: check abort after batch processing
    if (abortSignal?.aborted) {
      break;
    }
    
    const validResults = batchResults.filter(r => r !== null);
    similarities.push(...validResults);
    processedCount += validResults.length;
  }

  // Guard: only log if not aborted
  if (!abortSignal?.aborted) {
    console.log(`[RAG] Processed ${processedCount} chunks, skipped ${skippedCount}`);
  }

  // Guard: check abort before sorting
  if (abortSignal?.aborted) {
    throw new Error("RAG_TIMEOUT");
  }

  // מיון לפי similarity וקבלת ה-topK
  similarities.sort((a, b) => b.similarity - a.similarity);
  const topResults = similarities.slice(0, topK);
  
  // Guard: only log if not aborted
  if (!abortSignal?.aborted) {
    console.log(`[RAG] Top ${topResults.length} results, similarity range: ${topResults.length > 0 ? `${topResults[topResults.length - 1].similarity.toFixed(3)} - ${topResults[0].similarity.toFixed(3)}` : 'none'}`);
  }

  // עיבוד התוצאות - הורדנו את ה-filter ל-0.1 במקום 0.3
  const chunks = [];
  const sources = [];
  const seenSources = new Set(); // למניעת כפילויות של מקורות

  for (const result of topResults) {
    // Guard: check abort during result processing
    if (abortSignal?.aborted) {
      break;
    }
    
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

  returnedCount = chunks.length;
  
  // Guard: only log if not aborted
  if (!abortSignal?.aborted) {
    console.log(`[RAG] Returning ${returnedCount} chunks after filtering (similarity > 0.05), ${sources.length} unique sources`);
  }
  
  const ragTotalMs = Date.now() - ragStartTime;
  const result = { 
    chunks, 
    sources, 
    _metrics: { 
      status: "success", 
      maxDocs, 
      retrieved_count: retrievedCount, 
      processed_count: processedCount, 
      returned_count: returnedCount, 
      rag_total_ms: ragTotalMs 
    } 
  };
  
  // Guard: only cache if not aborted
  if (!abortSignal?.aborted) {
    setCachedResult(cacheKey, { chunks, sources });
  }
  
  return result;
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
export async function getRAGContext(queryText, topK = 3, courseName = null, maxDocs = 200, timeoutMs = null, abortSignal = null) {
  const ragResult = await queryRAG(queryText, topK, courseName, maxDocs, timeoutMs, abortSignal);
  const { chunks, sources, _metrics } = ragResult;

  if (chunks.length === 0) {
    return {
      context: null,
      sources: [],
      chunksCount: 0,
      _metrics
    };
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
    _metrics
  };
}

