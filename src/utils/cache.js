const NodeCache = require('node-cache');

/**
 * Standard TTL is 60 seconds.
 * checkperiod is 120 seconds for automatic cleanup.
 */
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

/**
 * Cache utility to provide a consistent interface and logging.
 */
const cacheUtil = {
  get: (key) => {
    const val = cache.get(key);
    if (val !== undefined) {
      console.log(`[Cache] HIT: ${key}`);
    }
    return val;
  },
  
  set: (key, value, ttl = 60) => {
    console.log(`[Cache] SET: ${key} (TTL: ${ttl}s)`);
    return cache.set(key, value, ttl);
  },
  
  del: (key) => {
    console.log(`[Cache] DEL: ${key}`);
    return cache.del(key);
  },
  
  flush: () => {
    console.log('[Cache] FLUSH ALL');
    return cache.flushAll();
  },

  // Generates a consistent key for user-specific data
  getUserKey: (prefix, userId) => `${prefix}_user_${userId}`,

  // Generates a consistent key for company-specific data
  getCompanyKey: (prefix, companyId) => `${prefix}_company_${companyId}`
};

module.exports = cacheUtil;
