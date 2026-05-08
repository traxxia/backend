const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

class AiChatLogModel {
  static collection() {
    return getDB().collection('ai_chat_logs');
  }

  /**
   * Create a new AI chat turn log.
   * Only called for Observatory Account sessions (gate checked upstream).
   */
  static async create(logData) {
    const coll = this.collection();
    const doc = {
      observatory_account_id: logData.observatory_account_id
        ? new ObjectId(logData.observatory_account_id) : null,

      // Business / project context
      business_id: logData.business_id || null,
      business_name: logData.business_name || null,
      project_id: logData.project_id || null,
      project_name: logData.project_name || null,

      // Page context (where the chat was opened)
      page_context: {
        current_page: logData.page_context?.current_page || null,
        page_description: logData.page_context?.page_description || null,
        page_content: logData.page_context?.page_content || null
      },

      // The full conversation turn
      system_prompt: logData.system_prompt || null,       // full system prompt sent to LLM
      user_input: logData.user_input || null,             // exact user text
      assistant_response: logData.assistant_response || null,

      // Model info
      llm_provider: logData.llm_provider || 'mastra',
      model: logData.model || null,

      // Performance
      token_usage: {
        prompt_tokens: logData.token_usage?.prompt_tokens || 0,
        completion_tokens: logData.token_usage?.completion_tokens || 0,
        total_tokens: logData.token_usage?.total_tokens || 0
      },
      latency_ms: logData.latency_ms || null,

      // Status
      status: logData.status || 'success',
      error_message: logData.error_message || null,

      // Timestamps
      timestamp: logData.timestamp ? new Date(logData.timestamp) : new Date(),
      timestamp_readable: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    };

    const result = await coll.insertOne(doc);
    return result.insertedId;
  }

  /**
   * Paginated list with filters for Observatory UI AI Chat tab.
   */
  static async findPaged({ filter = {}, skip = 0, limit = 20 } = {}) {
    const coll = this.collection();

    const query = {};
    if (filter.business_id) query.business_id = filter.business_id;
    if (filter.project_id) query.project_id = filter.project_id;
    if (filter.page) query['page_context.current_page'] = filter.page;
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
   * All chat turns for a specific business (for by-business endpoint).
   */
  static async findByBusiness(businessId, { skip = 0, limit = 50 } = {}) {
    return this.collection()
      .find({ business_id: businessId })
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
  }

  /**
   * Chat usage statistics for Observatory stats tab.
   */
  static async getChatUsageStats({ date_from, date_to } = {}) {
    const coll = this.collection();
    const matchStage = {};
    if (date_from || date_to) {
      matchStage.timestamp = {};
      if (date_from) matchStage.timestamp.$gte = new Date(date_from);
      if (date_to) matchStage.timestamp.$lte = new Date(date_to);
    }

    const [totals, topBusinesses, topPages] = await Promise.all([
      // Overall totals
      coll.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: null,
            total_turns: { $sum: 1 },
            total_tokens: { $sum: '$token_usage.total_tokens' },
            avg_tokens: { $avg: '$token_usage.total_tokens' },
            avg_latency_ms: { $avg: '$latency_ms' }
          }
        }
      ]).toArray(),

      // Top businesses by chat count
      coll.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: '$business_id',
            business_name: { $first: '$business_name' },
            chat_count: { $sum: 1 },
            total_tokens: { $sum: '$token_usage.total_tokens' }
          }
        },
        { $sort: { chat_count: -1 } },
        { $limit: 10 }
      ]).toArray(),

      // Top pages by chat initiation
      coll.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: '$page_context.current_page',
            chat_count: { $sum: 1 },
            avg_tokens: { $avg: '$token_usage.total_tokens' }
          }
        },
        { $sort: { chat_count: -1 } },
        { $limit: 10 }
      ]).toArray()
    ]);

    return {
      totals: totals[0] || {},
      top_businesses: topBusinesses,
      top_pages: topPages
    };
  }

  /**
   * Model usage statistics aggregate for AI Chat.
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

  static async findById(id) {
    return this.collection().findOne({ _id: new ObjectId(id) });
  }
}

module.exports = AiChatLogModel;
