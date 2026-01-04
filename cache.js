// cache.js - In-memory cache utility with TTL support
// Simple Map-based cache for conversation history and user state
import { createHash } from "crypto";

const cache = new Map(); // { key: { data, timestamp, ttl } }

// Default TTL values (in milliseconds)
const DEFAULT_TTL = {
  conversationHistory: 30000,  // 30 seconds
  userState: 60000,             // 60 seconds
  firstLogin: 60000,            // 60 seconds
};

/**
 * Hash cache key for logging (shortened for readability)
 * @param {string} key - Cache key
 * @returns {string} - Shortened hash
 */
function hashKey(key) {
  return createHash("sha256").update(key).digest("hex").substring(0, 8);
}

/**
 * Get cached value if still valid
 * @param {string} key - Cache key
 * @returns {any|null} - Cached data or null if expired/missing
 */
export function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  
  const age = Date.now() - entry.timestamp;
  if (age > entry.ttl) {
    cache.delete(key);
    return null;
  }
  
  return entry.data;
}

/**
 * Set cache value with TTL
 * @param {string} key - Cache key
 * @param {any} data - Data to cache
 * @param {number} ttl - Time to live in milliseconds
 */
export function setCache(key, data, ttl) {
  cache.set(key, {
    data,
    timestamp: Date.now(),
    ttl: ttl || DEFAULT_TTL.conversationHistory,
  });
  
  // Periodic cleanup: if cache grows beyond 1000 entries, remove expired ones
  if (cache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of cache.entries()) {
      if (now - v.timestamp > v.ttl) {
        cache.delete(k);
      }
    }
  }
}

/**
 * Delete cache entry
 * @param {string} key - Cache key
 */
export function deleteCache(key) {
  cache.delete(key);
}

/**
 * Clear all cache entries matching a prefix (for invalidation)
 * @param {string} prefix - Key prefix to match
 */
export function clearCachePrefix(prefix) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

/**
 * Generate cache key for conversation history
 * @param {string} userId - User email
 * @returns {string} - Cache key
 */
export function getConversationHistoryKey(userId) {
  return `conv_history:${userId.toLowerCase().trim()}`;
}

/**
 * Generate cache key for user state
 * @param {string} userId - User email
 * @returns {string} - Cache key
 */
export function getUserStateKey(userId) {
  return `user_state:${userId.toLowerCase().trim()}`;
}

/**
 * Generate cache key for first login
 * @param {string} userId - User email
 * @returns {string} - Cache key
 */
export function getFirstLoginKey(userId) {
  return `first_login:${userId.toLowerCase().trim()}`;
}

/**
 * Get cached user state or load from Firestore
 * @param {object} db - Firestore instance
 * @param {string} email - User email
 * @param {string} requestId - Request ID for logging
 * @param {function} loadUserStateFn - Function to load state from Firestore
 * @returns {Promise<object>} - User state object
 */
export async function getStateCached(db, email, requestId, loadUserStateFn) {
  const cacheKey = getUserStateKey(email);
  const keyHash = hashKey(cacheKey);
  const entry = cache.get(cacheKey);
  
  if (entry) {
    const age = Date.now() - entry.timestamp;
    if (age <= entry.ttl) {
      const remainingTtl = entry.ttl - age;
      console.log(`[Cache] state HIT key=${keyHash} ttl=${remainingTtl}ms remaining`);
      return { state: entry.data, cached: true };
    } else {
      // Expired, remove it
      cache.delete(cacheKey);
    }
  }
  
  console.log(`[Cache] state MISS key=${keyHash} reason=${entry ? 'expired' : 'not_found'}`);
  const state = await loadUserStateFn(db, email);
  setCache(cacheKey, state, DEFAULT_TTL.userState);
  console.log(`[Cache] state SET key=${keyHash} ttl=${DEFAULT_TTL.userState}ms`);
  return { state, cached: false };
}

/**
 * Get cached conversation history or load from Firestore
 * @param {boolean} chatMemoryEnabled - Whether chat memory is enabled
 * @param {string} email - User email
 * @param {string} requestId - Request ID for logging
 * @param {function} getUserConversationHistoryFn - Function to load history from Firestore
 * @returns {Promise<Array>} - Conversation history array
 */
export async function getHistoryCached(chatMemoryEnabled, email, requestId, getUserConversationHistoryFn) {
  if (!chatMemoryEnabled) {
    return { history: [], cached: false };
  }
  
  const cacheKey = getConversationHistoryKey(email);
  const keyHash = hashKey(cacheKey);
  const entry = cache.get(cacheKey);
  
  if (entry) {
    const age = Date.now() - entry.timestamp;
    if (age <= entry.ttl) {
      const remainingTtl = entry.ttl - age;
      console.log(`[Cache] history HIT key=${keyHash} ttl=${remainingTtl}ms remaining`);
      return { history: entry.data, cached: true };
    } else {
      // Expired, remove it
      cache.delete(cacheKey);
    }
  }
  
  console.log(`[Cache] history MISS key=${keyHash} reason=${entry ? 'expired' : 'not_found'}`);
  try {
    const history = await getUserConversationHistoryFn(email);
    setCache(cacheKey, history, DEFAULT_TTL.conversationHistory);
    console.log(`[Cache] history SET key=${keyHash} ttl=${DEFAULT_TTL.conversationHistory}ms`);
    return { history, cached: false };
  } catch (e) {
    console.error(`[Cache] history ERROR key=${keyHash} error=${e?.message || e}`);
    return { history: [], cached: false };
  }
}

/**
 * Update cached conversation history by appending a new message (write-through cache)
 * @param {string} userId - User email
 * @param {object} message - Message object with { role, content }
 * @param {number} maxMessages - Maximum number of messages to keep in cache (default: 200)
 */
export function updateHistoryCache(userId, message, maxMessages = 200) {
  const cacheKey = getConversationHistoryKey(userId);
  const keyHash = hashKey(cacheKey);
  const entry = cache.get(cacheKey);
  
  if (entry) {
    const age = Date.now() - entry.timestamp;
    if (age <= entry.ttl) {
      // Cache is valid, append message
      const history = Array.isArray(entry.data) ? [...entry.data] : [];
      history.push(message);
      
      // Cap at maxMessages, keeping the most recent ones
      const cappedHistory = history.slice(-maxMessages);
      
      // Update cache with same TTL and timestamp (preserve age)
      cache.set(cacheKey, {
        data: cappedHistory,
        timestamp: entry.timestamp, // Keep original timestamp to preserve TTL
        ttl: entry.ttl
      });
      
      console.log(`[Cache] history UPDATED key=${keyHash} messages=${history.length}->${cappedHistory.length}`);
      return true;
    } else {
      // Cache expired, don't update
      cache.delete(cacheKey);
      return false;
    }
  }
  
  // No cache entry, nothing to update
  return false;
}

/**
 * Update cached user state (write-through cache)
 * @param {string} userId - User email
 * @param {object} newState - New state object
 */
export function updateStateCache(userId, newState) {
  const cacheKey = getUserStateKey(userId);
  const keyHash = hashKey(cacheKey);
  const entry = cache.get(cacheKey);
  
  if (entry) {
    const age = Date.now() - entry.timestamp;
    if (age <= entry.ttl) {
      // Cache is valid, update state
      // Update cache with same TTL and timestamp (preserve age)
      cache.set(cacheKey, {
        data: newState,
        timestamp: entry.timestamp, // Keep original timestamp to preserve TTL
        ttl: entry.ttl
      });
      
      console.log(`[Cache] state UPDATED key=${keyHash}`);
      return true;
    } else {
      // Cache expired, don't update
      cache.delete(cacheKey);
      return false;
    }
  }
  
  // No cache entry, nothing to update
  return false;
}

/**
 * Get cached first_login result or load from Firestore
 * @param {object} db - Firestore instance
 * @param {string} email - User email
 * @param {string} requestId - Request ID for logging
 * @param {function} checkFirstLoginFn - Function to check first login from Firestore
 * @returns {Promise<object>} - Object with { first_login: boolean, cached: boolean }
 */
export async function getFirstLoginCached(db, email, requestId, checkFirstLoginFn) {
  if (!db) {
    return { first_login: false, cached: false };
  }
  
  const cacheKey = getFirstLoginKey(email);
  const keyHash = hashKey(cacheKey);
  const entry = cache.get(cacheKey);
  
  if (entry) {
    const age = Date.now() - entry.timestamp;
    if (age <= entry.ttl) {
      const remainingTtl = entry.ttl - age;
      console.log(`[Cache] first_login HIT key=${keyHash} ttl=${remainingTtl}ms remaining`);
      return { first_login: entry.data, cached: true };
    } else {
      // Expired, remove it
      cache.delete(cacheKey);
    }
  }
  
  console.log(`[Cache] first_login MISS key=${keyHash} reason=${entry ? 'expired' : 'not_found'}`);
  const result = await checkFirstLoginFn(db, email);
  
  // Cache the result: if first_login is true, cache false (because next time it will be false)
  // If first_login is false, cache false
  const valueToCache = result.first_login === true ? false : result.first_login;
  setCache(cacheKey, valueToCache, DEFAULT_TTL.firstLogin);
  console.log(`[Cache] first_login SET key=${keyHash} value=${valueToCache} ttl=${DEFAULT_TTL.firstLogin}ms`);
  
  return { first_login: result.first_login, cached: false };
}

export { DEFAULT_TTL };

