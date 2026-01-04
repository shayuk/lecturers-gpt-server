# Performance Analysis & Improvement Plan
## Lecturers GPT Server - Performance Engineering Report

**Date:** 2024  
**Environment:** Node.js 18+, Express.js, Firebase Firestore, OpenAI API  
**Hosting:** Render.com  
**Analysis Type:** Read-only architecture review

---

## 1) Repo/Architecture Map

### Tech Stack
- **Runtime:** Node.js (ES modules)
- **Web Framework:** Express.js 4.19.2
- **Database:** Firebase Firestore (RAG chunks, chat messages, user state, usage logs)
- **LLM Provider:** OpenAI API (gpt-4o model, text-embedding-3-small)
- **Streaming:** Server-Sent Events (SSE)
- **File Upload:** Multer (memory storage, PDF parsing)

### Request Flow Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ CLIENT (Frontend)                                               │
│ - React/HTML UI                                                 │
│ - SSE client for streaming                                      │
└────────────────────┬────────────────────────────────────────────┘
                     │ HTTP POST /api/ask or /api/ask/stream
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ EXPRESS SERVER (index.js)                                       │
│ 1. CORS middleware                                               │
│ 2. Body parser (50MB limit)                                     │
│ 3. Auth check (email validation)                                │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ DATA LOADING PHASE (Sequential)                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ checkAndMarkFirstLogin()                                     │ │
│ │ └─ Firestore: user_profiles collection (1 read)            │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ loadUserState()                                              │ │
│ │ └─ Firestore: galibot_user_state_v1 (1 read)              │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ getUserConversationHistory()                                 │ │
│ │ └─ Firestore: chat_messages (1 query, up to 20 docs)       │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ getRAGContext() [if enabled & !diagnosisOnly]               │ │
│ │ ├─ createEmbedding() → OpenAI API (1 call)                 │ │
│ │ ├─ Firestore: rag_chunks query (up to 200 docs)           │ │
│ │ └─ Cosine similarity calc (up to 200 vectors, 5s timeout) │ │
│ └─────────────────────────────────────────────────────────────┘ │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ PROMPT BUILDING                                                 │
│ └─ buildGalibotSystemPrompt() + RAG context (~400 lines)      │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ OPENAI API CALL                                                 │
│ └─ chat.completions.create()                                    │
│    ├─ Non-streaming: await full response                        │
│    └─ Streaming: for await (chunk) → SSE events                │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ RESPONSE & BACKGROUND SAVES                                     │
│ ├─ cleanLaTeXFormulas()                                         │
│ ├─ saveChatMessage() × 2 (user + assistant) [async]           │
│ ├─ saveUserState() [async]                                      │
│ └─ usage_logs.add() [async]                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Where Time is Spent (Suspected)

1. **Firestore Sequential Reads** (~200-500ms total)
   - `checkAndMarkFirstLogin`: ~50-100ms
   - `loadUserState`: ~50-100ms
   - `getUserConversationHistory`: ~100-200ms (20 docs)
   - **Total:** Sequential blocking, no parallelization

2. **RAG Processing** (~500-3000ms)
   - Embedding creation: ~200-500ms (OpenAI API)
   - Firestore query: ~100-300ms (up to 200 docs)
   - Cosine similarity: ~200-2000ms (up to 200 vectors, 5s timeout)
   - **Total:** Can be 3s+ in worst case

3. **OpenAI API Call** (~1000-5000ms)
   - Network latency: ~100-300ms
   - Model processing: ~1000-4000ms (depends on prompt size, model)
   - **Total:** Largest contributor to latency

4. **Prompt Size** (~500-2000 tokens)
   - System prompt: ~400 lines (~800-1000 tokens)
   - RAG context: ~500-1500 tokens (3 chunks)
   - Conversation history: ~500-2000 tokens (20 messages)
   - **Total:** Large prompts = slower responses + higher costs

5. **Background Writes** (non-blocking but adds load)
   - 3-4 Firestore writes per request
   - Can contribute to quota exhaustion

---

## 2) Bottleneck Hypotheses (Ranked by Impact)

| Rank | Bottleneck | Impact | Evidence | Location |
|------|------------|--------|----------|----------|
| 1 | **Sequential Firestore reads** | High | 3 sequential awaits in non-streaming path | `index.js:324-361` |
| 2 | **Large system prompt** | High | ~400 lines sent every request (~1000 tokens) | `galibotSystemPrompt.js:7-409` |
| 3 | **RAG similarity calculation** | Medium-High | Up to 200 vectors, blocking, 5s timeout | `rag.js:143-201` |
| 4 | **No caching for conversation history** | Medium | Loaded every request, no TTL cache | `chatMemory.js:85-150` |
| 5 | **No caching for user state** | Medium | Loaded every request | `topicState.js:84-108` |
| 6 | **Large conversation history** | Medium | Up to 20 messages sent to OpenAI (~2000 tokens) | `index.js:361` |
| 7 | **RAG embedding API call** | Medium | Called every request (60s cache exists but limited) | `rag.js:68-83` |
| 8 | **No connection pooling/reuse** | Low-Medium | OpenAI client recreated, no keep-alive | `index.js:187` |
| 9 | **Synchronous PDF parsing** | Low | Blocks upload endpoint | `index.js:659` |
| 10 | **No request correlation IDs** | Low | Hard to trace requests in logs | All files |

---

## 3) Instrumentation Plan

### Logging Strategy

| Metric | Where to Log | Format | Purpose |
|--------|--------------|--------|----------|
| **Request Start** | `index.js:301` (non-streaming), `index.js:448` (streaming) | `[PERF] req_start request_id={id} email={email} endpoint={path}` | Track total request time |
| **Auth Check End** | After `checkAndMarkFirstLogin` | `[PERF] auth_end request_id={id} duration_ms={ms}` | Measure auth overhead |
| **User State Load** | After `loadUserState` | `[PERF] state_load request_id={id} duration_ms={ms}` | Track Firestore read latency |
| **History Load** | After `getUserConversationHistory` | `[PERF] history_load request_id={id} duration_ms={ms} msg_count={n}` | Track conversation loading |
| **RAG Start** | Before `getRAGContext` | `[PERF] rag_start request_id={id}` | Mark RAG phase |
| **RAG Embedding** | After `createEmbedding` | `[PERF] rag_embedding request_id={id} duration_ms={ms}` | Track embedding API latency |
| **RAG Query** | After Firestore query | `[PERF] rag_query request_id={id} duration_ms={ms} docs_found={n}` | Track Firestore query time |
| **RAG Similarity** | After similarity calc | `[PERF] rag_similarity request_id={id} duration_ms={ms} processed={n}` | Track CPU-bound similarity |
| **Prompt Build** | After `buildGalibotSystemPrompt` | `[PERF] prompt_build request_id={id} token_count={n}` | Track prompt size |
| **OpenAI Call Start** | Before `chat.completions.create` | `[PERF] openai_start request_id={id}` | Mark LLM call |
| **First Token Time (TTFT)** | First chunk received | `[PERF] ttft request_id={id} duration_ms={ms}` | Time to first token |
| **OpenAI Call End** | After completion | `[PERF] openai_end request_id={id} duration_ms={ms} tokens_in={n} tokens_out={n}` | Total LLM latency |
| **Response Sent** | Before `res.json()` or `res.end()` | `[PERF] response_sent request_id={id} total_ms={ms}` | Total request time |
| **Background Save** | After async saves | `[PERF] bg_save request_id={id} type={type} duration_ms={ms}` | Track non-blocking writes |

### Request Correlation

**Implementation:**
- Generate UUID v4 at request start: `const requestId = crypto.randomUUID()`
- Pass through all async functions
- Include in all log statements
- Add to response headers: `X-Request-ID`

**Files to modify:**
- `index.js`: Add middleware to generate requestId, pass to handlers
- `rag.js`: Accept requestId parameter, include in logs
- `chatMemory.js`: Accept requestId parameter, include in logs
- `topicState.js`: Accept requestId parameter, include in logs

### Metrics to Track in Render Logs

| Metric | Calculation | Target (p95) | Target (p99) |
|--------|-------------|--------------|--------------|
| **Total Request Time** | `response_sent - req_start` | < 3s | < 5s |
| **Time to First Token (TTFT)** | `ttft - openai_start` | < 1s | < 2s |
| **RAG Latency** | `rag_similarity - rag_start` | < 1s | < 2s |
| **OpenAI Latency** | `openai_end - openai_start` | < 2s | < 4s |
| **Firestore Read Latency** | Sum of state_load + history_load | < 300ms | < 500ms |
| **Prompt Token Count** | From `prompt_build` log | < 3000 | < 4000 |

**Log Parsing Script (proposed):**
```bash
# Extract p95/p99 from Render logs
grep "\[PERF\]" logs.txt | \
  awk '/total_ms=/ {match($0, /total_ms=([0-9]+)/, arr); print arr[1]}' | \
  sort -n | \
  awk '{data[NR]=$1} END {print "p95:", data[int(NR*0.95)], "p99:", data[int(NR*0.99)]}'
```

---

## 4) Performance Improvement Backlog

### A) Low Risk / High Impact (Do First)

#### A1. Parallelize Firestore Reads
**Why:** Currently sequential: `checkAndMarkFirstLogin` → `loadUserState` → `getUserConversationHistory`. Can run in parallel.
**Where:** `index.js:324-361` (non-streaming), `index.js:480-483` (streaming - already parallel!)
**Risk:** Low (streaming path already does this)
**Impact:** Save ~200-400ms per request
**Verification:** Compare `total_ms` before/after, should see ~30% reduction in data loading phase
**Implementation:** Wrap in `Promise.all()`:
```javascript
const [firstLogin, userState, conversationHistory] = await Promise.all([
  checkAndMarkFirstLogin(rawEmail),
  loadUserState(db, rawEmail),
  chatMemoryEnabled ? getUserConversationHistory(rawEmail).catch(() => []) : []
]);
```

#### A2. Cache Conversation History (In-Memory with TTL)
**Why:** Conversation history loaded every request, rarely changes within short window.
**Where:** `chatMemory.js:85-150`
**Risk:** Low (add cache layer, fallback to Firestore on miss)
**Impact:** Save ~100-200ms per request for repeat queries
**Verification:** Log cache hit rate, measure `history_load` duration (should be < 1ms on hit)
**Implementation:** 
- Add `Map` cache: `{ email_timestamp: { data, expires } }`
- TTL: 30 seconds (configurable)
- Invalidate on `saveChatMessage`

#### A3. Cache User State (In-Memory with TTL)
**Why:** User state loaded every request, changes infrequently.
**Where:** `topicState.js:84-108`
**Risk:** Low (add cache layer, fallback to Firestore)
**Impact:** Save ~50-100ms per request
**Verification:** Log cache hit rate, measure `state_load` duration
**Implementation:**
- Add `Map` cache: `{ email: { state, expires } }`
- TTL: 60 seconds
- Invalidate on `saveUserState`

#### A4. Reduce System Prompt Size
**Why:** ~400 lines (~1000 tokens) sent every request. Extract static parts, use shorter version.
**Where:** `galibotSystemPrompt.js:7-409`
**Risk:** Low-Medium (need to preserve behavior, test thoroughly)
**Impact:** Save ~200-500ms OpenAI processing time, reduce token costs by ~30%
**Verification:** Compare `openai_end - openai_start` before/after, check token counts
**Implementation:**
- Extract diagnostic rules to shorter template
- Remove redundant examples
- Use abbreviations for common phrases
- Target: Reduce from ~1000 to ~600 tokens

#### A5. Add Request Correlation IDs
**Why:** Currently impossible to trace a request through logs. Critical for debugging production issues.
**Where:** All files (middleware in `index.js`, pass to all functions)
**Risk:** Low (additive change)
**Impact:** High for debugging, zero for performance
**Verification:** Check logs show consistent `request_id` across all phases
**Implementation:**
- Middleware: `app.use((req, res, next) => { req.id = crypto.randomUUID(); next(); })`
- Add to all log statements
- Return in response header: `res.setHeader('X-Request-ID', req.id)`

#### A6. Optimize RAG Similarity Calculation
**Why:** Currently processes up to 200 vectors sequentially in batches. Can use Web Workers or optimize algorithm.
**Where:** `rag.js:143-201`
**Risk:** Low-Medium (algorithm change, need to verify correctness)
**Impact:** Save ~500-1000ms for large RAG queries
**Verification:** Compare `rag_similarity` duration, verify same results
**Implementation:**
- Use typed arrays for vector operations (faster)
- Early exit if similarity too low (< 0.05 threshold)
- Reduce batch size or use parallel processing
- Consider approximate nearest neighbor (ANN) if accuracy allows

### B) Medium Risk

#### B1. Reduce Conversation History Size
**Why:** Currently sends up to 20 messages (~2000 tokens). Can summarize older messages or reduce limit.
**Where:** `index.js:361`, `chatMemory.js:85`
**Risk:** Medium (may affect context quality)
**Impact:** Save ~500-1000ms OpenAI processing, reduce token costs
**Verification:** A/B test with users, measure response quality vs latency
**Implementation:**
- Reduce `MAX_HISTORY_MESSAGES` from 20 to 10-15
- Or: Summarize messages older than 5 turns
- Or: Only include last N messages + summary of older ones

#### B2. Implement Prompt Compression
**Why:** Large prompts slow down OpenAI. Can use prompt compression techniques (summarization, key extraction).
**Where:** `galibotSystemPrompt.js:416-429`
**Risk:** Medium (may affect response quality)
**Impact:** Save ~300-800ms OpenAI processing
**Verification:** Compare response quality scores, measure latency
**Implementation:**
- Compress RAG context: Summarize chunks before adding to prompt
- Use shorter system prompt version for non-diagnostic turns
- Cache compressed prompts for common queries

#### B3. Add Connection Pooling for OpenAI
**Why:** Currently creates new HTTP connections. Reuse connections with keep-alive.
**Where:** `index.js:187`
**Risk:** Medium (need to configure HTTP agent)
**Impact:** Save ~50-100ms per request (connection reuse)
**Verification:** Monitor connection count, measure latency improvement
**Implementation:**
- Use `undici` or configure `https.Agent` with `keepAlive: true`
- Set `maxSockets: 10`, `keepAliveMsecs: 1000`

#### B4. Implement RAG Result Caching (Extend Current Cache)
**Why:** Current cache is 60s TTL, but key is too simple (first 50 chars). Can improve cache key strategy.
**Where:** `rag.js:8-46`
**Risk:** Low-Medium (cache invalidation complexity)
**Impact:** Increase cache hit rate from ~10% to ~30-40%
**Verification:** Log cache hit rate, measure `rag_*` durations
**Implementation:**
- Use semantic cache key (hash of normalized query + course_name)
- Increase TTL to 5 minutes for stable queries
- Add cache warming for common queries

#### B5. Stream RAG Results Early
**Why:** Currently waits for full RAG before starting OpenAI call. Can start OpenAI with partial RAG, stream updates.
**Where:** `index.js:332-351`, `index.js:487-506`
**Risk:** Medium (complexity, may affect prompt quality)
**Impact:** Save ~500-2000ms perceived latency (start OpenAI earlier)
**Verification:** Measure `ttft` improvement
**Implementation:**
- Start OpenAI call with empty RAG context
- Stream RAG results as they arrive
- Update prompt mid-stream (if OpenAI supports) or use next turn

#### B6. Optimize Firestore Queries
**Why:** Some queries don't use indexes, or fetch more data than needed.
**Where:** `chatMemory.js:101-105`, `rag.js:125-133`
**Risk:** Medium (need to verify indexes exist)
**Impact:** Save ~50-200ms per query
**Verification:** Check Firestore query performance in console, measure duration
**Implementation:**
- Add composite index for `chat_messages`: `userId + createdAt`
- Use `select()` to fetch only needed fields
- Add pagination for large result sets

### C) High Risk / Big Refactor

#### C1. Implement Vector Database (Pinecone/Weaviate/Qdrant)
**Why:** Firestore not optimized for vector search. Dedicated vector DBs are 10-100x faster.
**Where:** `rag.js` (full rewrite)
**Risk:** High (migration complexity, new dependency, cost)
**Impact:** Save ~1000-2000ms on RAG queries, better scalability
**Verification:** Compare RAG latency before/after migration
**Implementation:**
- Choose vector DB (Pinecone recommended for managed)
- Migrate embeddings from Firestore
- Update `queryRAG()` to use vector DB API
- Keep Firestore for metadata only

#### C2. Implement Response Streaming with Partial RAG
**Why:** Currently RAG blocks response. Can stream response while RAG processes in background.
**Where:** `index.js:448-615` (major refactor)
**Risk:** High (complexity, may affect response quality)
**Impact:** Save ~500-2000ms perceived latency
**Verification:** Measure `ttft` improvement, verify response quality
**Implementation:**
- Start OpenAI call immediately with minimal context
- Process RAG in parallel
- Inject RAG results into streaming response (if possible) or next turn

#### C3. Implement Message Summarization
**Why:** Long conversation history increases tokens. Summarize old messages to reduce size.
**Where:** `chatMemory.js` (new summarization module)
**Risk:** High (complexity, may lose context, requires LLM call)
**Impact:** Reduce prompt size by ~30-50%, save ~500-1000ms
**Verification:** Compare response quality, measure token reduction
**Implementation:**
- Summarize messages older than N turns using OpenAI
- Store summaries in Firestore
- Use summaries + recent messages in prompt

#### C4. Move to Edge Functions / Serverless
**Why:** Current monolith on Render may have cold starts. Edge functions closer to users, faster.
**Where:** Entire architecture (major refactor)
**Risk:** Very High (complete rewrite, vendor lock-in, cost model change)
**Impact:** Save ~100-500ms network latency, eliminate cold starts
**Verification:** Compare total latency, measure cold start frequency
**Implementation:**
- Migrate to Vercel Edge Functions or Cloudflare Workers
- Use edge-compatible Firestore client
- Handle streaming differently (edge limitations)

---

## 5) First 3 Changes (Detailed)

### Change 1: Parallelize Firestore Reads (Non-Streaming Path)

**File:** `index.js`  
**Lines:** 324-361  
**Scope:** Replace sequential `await` calls with `Promise.all()`

**Current Code:**
```javascript
const { first_login } = await checkAndMarkFirstLogin(rawEmail);
const userState = await loadUserState(db, rawEmail);
const turn = decideTurn(prompt, userState);
// ... RAG ...
let conversationHistory = [];
if (chatMemoryEnabled) {
  conversationHistory = await getUserConversationHistory(rawEmail);
}
```

**Proposed Change:**
```javascript
// Parallelize all Firestore reads
const [firstLoginResult, userState, conversationHistory] = await Promise.all([
  checkAndMarkFirstLogin(rawEmail),
  loadUserState(db, rawEmail),
  chatMemoryEnabled ? getUserConversationHistory(rawEmail).catch(() => []) : Promise.resolve([])
]);

const { first_login } = firstLoginResult;
const turn = decideTurn(prompt, userState);
```

**Acceptance Criteria:**
- ✅ All three Firestore reads execute in parallel
- ✅ No behavior change (same data loaded)
- ✅ Error handling preserved (conversationHistory fallback)
- ✅ Performance: `total_ms` reduced by 200-400ms (measured via logs)
- ✅ Tests pass (if any exist)

**Risk:** Low (streaming path already does this, proven pattern)

---

### Change 2: Add Request Correlation IDs + Basic Instrumentation

**Files:** `index.js` (middleware + handlers), `rag.js`, `chatMemory.js`, `topicState.js`  
**Scope:** Add request ID generation, pass through all functions, add key performance logs

**Implementation:**

1. **Add middleware in `index.js`:**
```javascript
import crypto from 'crypto';

app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  req.startTime = Date.now();
  res.setHeader('X-Request-ID', req.id);
  next();
});
```

2. **Add logs at key points:**
```javascript
// In /api/ask handler
console.log(`[PERF] req_start request_id=${req.id} email=${rawEmail} endpoint=/api/ask`);

// After parallel Firestore reads
console.log(`[PERF] data_load_end request_id=${req.id} duration_ms=${Date.now() - req.startTime}`);

// Before OpenAI call
const openaiStartTime = Date.now();
console.log(`[PERF] openai_start request_id=${req.id}`);

// After OpenAI call
console.log(`[PERF] openai_end request_id=${req.id} duration_ms=${Date.now() - openaiStartTime} tokens_in=${completion.usage.prompt_tokens} tokens_out=${completion.usage.completion_tokens}`);

// Before response
console.log(`[PERF] response_sent request_id=${req.id} total_ms=${Date.now() - req.startTime}`);
```

3. **Pass requestId to RAG/chatMemory functions:**
```javascript
// Update function signatures
export async function getRAGContext(queryText, topK, courseName, maxDocs, requestId = null)
export async function getUserConversationHistory(userId, limit, requestId = null)

// Add logs inside functions
console.log(`[PERF] rag_start request_id=${requestId || 'unknown'}`);
```

**Acceptance Criteria:**
- ✅ Every request has unique `X-Request-ID` header
- ✅ All logs include `request_id` field
- ✅ Can trace a request through all phases using `request_id`
- ✅ Performance logs show timing for: data load, RAG, OpenAI, total
- ✅ No performance regression (logging is async/lightweight)

**Risk:** Low (additive change, no behavior modification)

---

### Change 3: Cache Conversation History (In-Memory with TTL)

**File:** `chatMemory.js`  
**Scope:** Add in-memory cache layer before Firestore read

**Implementation:**

```javascript
// Add at top of chatMemory.js
const historyCache = new Map(); // { email: { data: [...], expires: timestamp } }
const HISTORY_CACHE_TTL = 30000; // 30 seconds

export async function getUserConversationHistory(userId, limit = MAX_HISTORY_MESSAGES, requestId = null) {
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
    const cacheKey = `${normalizedUserId}_${limit}`;
    
    // Check cache
    const cached = historyCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      console.log(`[ChatMemory] Cache hit for user ${normalizedUserId.substring(0, 10)}... (request_id: ${requestId || 'unknown'})`);
      return cached.data;
    }
    
    // Cache miss - load from Firestore
    const snapshot = await firestoreDb
      .collection("chat_messages")
      .where("userId", "==", normalizedUserId)
      .limit(limit)
      .get();

    // ... existing processing code ...
    
    // Store in cache
    historyCache.set(cacheKey, {
      data: messages,
      expires: Date.now() + HISTORY_CACHE_TTL
    });
    
    // Cleanup old cache entries (run occasionally)
    if (historyCache.size > 1000) {
      const now = Date.now();
      for (const [key, value] of historyCache.entries()) {
        if (value.expires < now) {
          historyCache.delete(key);
        }
      }
    }
    
    return messages;
  } catch (error) {
    // ... existing error handling ...
  }
}

// Invalidate cache on save
export async function saveChatMessage(userId, role, content, metadata = {}) {
  // ... existing save code ...
  
  // Invalidate cache for this user
  const normalizedUserId = userId.toLowerCase().trim();
  for (const key of historyCache.keys()) {
    if (key.startsWith(normalizedUserId)) {
      historyCache.delete(key);
    }
  }
  
  // ... rest of function ...
}
```

**Acceptance Criteria:**
- ✅ Cache hit returns data in < 1ms (measured via logs)
- ✅ Cache miss falls back to Firestore (no behavior change)
- ✅ Cache invalidated on `saveChatMessage` (fresh data after save)
- ✅ Cache size limited (prevents memory leaks)
- ✅ Performance: `history_load` duration reduced by 100-200ms on cache hits
- ✅ Cache hit rate > 20% after warmup (measured via logs)

**Risk:** Low-Medium (cache invalidation must be correct, memory usage)

---

## Summary

**Total Expected Impact of First 3 Changes:**
- **Change 1 (Parallelize reads):** -200 to -400ms
- **Change 2 (Instrumentation):** 0ms (enables measurement)
- **Change 3 (Cache history):** -100 to -200ms (on cache hits, ~30% of requests)

**Combined:** ~300-600ms reduction in p95 latency, with ability to measure and optimize further.

**Next Steps After First 3:**
1. Deploy changes to staging
2. Monitor logs for 24-48 hours
3. Calculate p95/p99 metrics from logs
4. Identify next bottlenecks from data
5. Implement Change A4 (Reduce System Prompt Size) based on measurements

---

**End of Analysis**
