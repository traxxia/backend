const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

class LLMInteractionLogModel {
  static collection() {
    return getDB().collection('llm_interaction_logs');
  }

  /**
   * Create a new LLM interaction log entry.
   * Only called for Observatory Account sessions (gate checked upstream).
   */
  static async create(logData) {
    const coll = this.collection();
    const doc = {
      observatory_account_id: logData.observatory_account_id
        ? new ObjectId(logData.observatory_account_id) : null,
      session_id: logData.session_id || null,

      // Business context
      business_id: logData.business_id || null,
      business_name: logData.business_name || null,

      // What was called
      stage: logData.stage || 'unknown',
      llm_provider: logData.llm_provider || 'unknown',
      model: logData.model || 'unknown',

      // Full prompt / response (the core of the observatory)
      system_prompt: logData.system_prompt || null,
      user_prompt: logData.user_prompt || null,
      llm_response: logData.llm_response || null,

      // Crawl details (populated when stage involves web crawling)
      crawl_details: logData.crawl_details || null,

      // Performance
      token_usage: logData.token_usage || null,
      latency_ms: logData.latency_ms || null,

      // Status
      status: logData.status || 'success',
      error_message: logData.error_message || null,

      // Timestamps
      timestamp: new Date(),
      timestamp_readable: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),

      metadata: logData.metadata || {}
    };

    const result = await coll.insertOne(doc);
    return result.insertedId;
  }

  /**
   * Get all logs for a specific observatory session (one business-creation run).
   */
  static async findBySession(sessionId) {
    return this.collection()
      .find({ session_id: sessionId })
      .sort({ timestamp: 1 })
      .toArray();
  }

  /**
   * Paginated list with filters — for the Observatory UI master list.
   */
  static async findPaged({ filter = {}, skip = 0, limit = 20 } = {}) {
    const coll = this.collection();

    // Build query
    const query = {};
    if (filter.session_id) query.session_id = filter.session_id;
    if (filter.stage) query.stage = filter.stage;
    if (filter.business_id) query.business_id = filter.business_id;
    if (filter.status) query.status = filter.status;
    if (filter.date_from || filter.date_to) {
      query.timestamp = {};
      if (filter.date_from) query.timestamp.$gte = new Date(filter.date_from);
      if (filter.date_to) query.timestamp.$lte = new Date(filter.date_to);
    }

    const [entries, total] = await Promise.all([
      coll.find(query).sort({ timestamp: -1 }).skip(skip).limit(limit).toArray(),
      coll.countDocuments(query)
    ]);

    return { entries, total };
  }

  /**
   * Get all distinct session_ids with summary stats (for sessions list).
   */
  static async getSessions({ skip = 0, limit = 20 } = {}) {
    return this.collection().aggregate([
      { $match: { session_id: { $ne: null, $exists: true } } },
      {
        $group: {
          _id: '$session_id',
          business_id: { $first: '$business_id' },
          business_name: { $first: '$business_name' },
          call_count: { $sum: 1 },
          total_tokens: { $sum: '$token_usage.total_tokens' },
          first_call: { $min: '$timestamp' },
          last_call: { $max: '$timestamp' },
          stages: { $addToSet: '$stage' }
        }
      },
      { $sort: { first_call: -1 } },
      { $skip: skip },
      { $limit: limit }
    ]).toArray();
  }

  /**
   * Model usage statistics aggregate.
   */
  static async getModelStats() {
    return this.collection().aggregate([
      {
        $group: {
          _id: { provider: '$llm_provider', model: '$model' },
          call_count: { $sum: 1 },
          total_tokens: { $sum: '$token_usage.total_tokens' },
          prompt_tokens: { $sum: '$token_usage.prompt_tokens' },
          completion_tokens: { $sum: '$token_usage.completion_tokens' },
          avg_latency_ms: { $avg: '$latency_ms' }
        }
      },
      { $sort: { call_count: -1 } }
    ]).toArray();
  }

  /**
   * Stage breakdown — how many calls per analysis stage.
   */
  static async getStageBreakdown() {
    return this.collection().aggregate([
      {
        $group: {
          _id: '$stage',
          count: { $sum: 1 },
          avg_tokens: { $avg: '$token_usage.total_tokens' },
          avg_latency_ms: { $avg: '$latency_ms' }
        }
      },
      { $sort: { count: -1 } }
    ]).toArray();
  }

  static async findById(id) {
    return this.collection().findOne({ _id: new ObjectId(id) });
  }
}

module.exports = LLMInteractionLogModel;
