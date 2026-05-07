const LLMInteractionLogModel = require('../models/llmInteractionLogModel');
const AiChatLogModel = require('../models/aiChatLogModel');
const BusinessModel = require('../models/businessModel');
const ProjectModel = require('../models/projectModel');
const { isObservatoryRequest } = require('../utils/isObservatoryRequest');

class SuperAdminController {

  // ─────────────────────────────────────────────────────────────────────
  // ANALYSIS / ML INTERACTION LOGS
  // ─────────────────────────────────────────────────────────────────────

  /**
   * GET /api/superadmin/interactions
   * Paginated list of all LLM interaction logs from the Observatory Account.
   * Query params: session_id, stage, business_id, status, date_from, date_to, page, limit
   */
  static async getInteractions(req, res) {
    try {
      const { session_id, stage, business_id, status, date_from, date_to } = req.query;
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, parseInt(req.query.limit) || 20);
      const skip = (page - 1) * limit;

      const { entries, total } = await LLMInteractionLogModel.findPaged({
        filter: { session_id, stage, business_id, status, date_from, date_to },
        skip,
        limit
      });

      res.json({
        success: true,
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
        data: entries
      });
    } catch (error) {
      console.error('[SuperAdmin] getInteractions error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch interactions' });
    }
  }

  /**
   * GET /api/superadmin/interactions/:id
   * Full detail of a single LLM interaction (incl. system prompt, response, crawl details).
   */
  static async getInteractionById(req, res) {
    try {
      const entry = await LLMInteractionLogModel.findById(req.params.id);
      if (!entry) return res.status(404).json({ success: false, error: 'Interaction not found' });
      res.json({ success: true, data: entry });
    } catch (error) {
      console.error('[SuperAdmin] getInteractionById error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch interaction' });
    }
  }

  /**
   * GET /api/superadmin/sessions
   * List all Observatory sessions (grouped by session_id).
   */
  static async getSessions(req, res) {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(50, parseInt(req.query.limit) || 20);
      const skip = (page - 1) * limit;

      const sessions = await LLMInteractionLogModel.getSessions({ skip, limit });
      res.json({ success: true, data: sessions });
    } catch (error) {
      console.error('[SuperAdmin] getSessions error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch sessions' });
    }
  }

  /**
   * GET /api/superadmin/sessions/:session_id
   * All LLM calls for a single business-creation session (timeline view).
   */
  static async getSessionDetail(req, res) {
    try {
      const entries = await LLMInteractionLogModel.findBySession(req.params.session_id);
      res.json({ success: true, session_id: req.params.session_id, data: entries });
    } catch (error) {
      console.error('[SuperAdmin] getSessionDetail error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch session detail' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // AI CHAT LOGS
  // ─────────────────────────────────────────────────────────────────────

  /**
   * GET /api/superadmin/chat-logs
   * Paginated AI assistant chat turns from the Observatory Account.
   * Query params: business_id, page, status, date_from, date_to, page_num, limit
   */
  static async getChatLogs(req, res) {
    try {
      const { business_id, page: pageFilter, status, date_from, date_to } = req.query;
      const page = Math.max(1, parseInt(req.query.page_num) || 1);
      const limit = Math.min(100, parseInt(req.query.limit) || 20);
      const skip = (page - 1) * limit;

      const { entries, total } = await AiChatLogModel.findPaged({
        filter: { business_id, page: pageFilter, status, date_from, date_to },
        skip,
        limit
      });

      res.json({
        success: true,
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
        data: entries
      });
    } catch (error) {
      console.error('[SuperAdmin] getChatLogs error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch chat logs' });
    }
  }

  /**
   * GET /api/superadmin/chat-logs/:id
   * Full detail of one AI chat turn (system prompt + user input + response).
   */
  static async getChatLogById(req, res) {
    try {
      const entry = await AiChatLogModel.findById(req.params.id);
      if (!entry) return res.status(404).json({ success: false, error: 'Chat log not found' });
      res.json({ success: true, data: entry });
    } catch (error) {
      console.error('[SuperAdmin] getChatLogById error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch chat log' });
    }
  }

  /**
   * GET /api/superadmin/chat-logs/by-business/:business_id
   * All chat turns for a specific business from the Observatory Account.
   */
  static async getChatLogsByBusiness(req, res) {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, parseInt(req.query.limit) || 50);
      const skip = (page - 1) * limit;

      const entries = await AiChatLogModel.findByBusiness(req.params.business_id, { skip, limit });
      res.json({ success: true, business_id: req.params.business_id, data: entries });
    } catch (error) {
      console.error('[SuperAdmin] getChatLogsByBusiness error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch chat logs by business' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // USAGE STATS
  // ─────────────────────────────────────────────────────────────────────

  /**
   * GET /api/superadmin/stats/models
   * Token & model usage aggregation across all Observatory sessions (Analysis + AI Chat).
   */
  static async getModelStats(req, res) {
    try {
      const [analysisStats, chatStats] = await Promise.all([
        LLMInteractionLogModel.getModelStats(),
        AiChatLogModel.getModelStats()
      ]);

      const combinedMap = new Map();

      const mergeStat = (stat) => {
        const key = `${stat._id.provider}|${stat._id.model}`;
        if (!combinedMap.has(key)) {
          combinedMap.set(key, { ...stat });
        } else {
          const existing = combinedMap.get(key);
          const totalCalls = existing.call_count + stat.call_count;
          
          // Weighted average for latency
          const avg_latency_ms = ((existing.avg_latency_ms || 0) * existing.call_count + (stat.avg_latency_ms || 0) * stat.call_count) / (totalCalls || 1);
          
          existing.call_count = totalCalls;
          existing.total_tokens += stat.total_tokens || 0;
          existing.prompt_tokens += stat.prompt_tokens || 0;
          existing.completion_tokens += stat.completion_tokens || 0;
          existing.avg_latency_ms = avg_latency_ms;
        }
      };

      analysisStats.forEach(mergeStat);
      chatStats.forEach(mergeStat);

      const data = Array.from(combinedMap.values()).sort((a, b) => b.call_count - a.call_count);

      res.json({ success: true, data });
    } catch (error) {
      console.error('[SuperAdmin] getModelStats error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch model stats' });
    }
  }

  /**
   * GET /api/superadmin/stats/stages
   * Breakdown of calls per analysis stage.
   */
  static async getStageStats(req, res) {
    try {
      const data = await LLMInteractionLogModel.getStageBreakdown();
      res.json({ success: true, data });
    } catch (error) {
      console.error('[SuperAdmin] getStageStats error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch stage stats' });
    }
  }

  /**
   * GET /api/superadmin/stats/chat-usage
   * AI chat usage summary: total turns, tokens, top businesses, top pages.
   * Query params: date_from, date_to
   */
  static async getChatUsageStats(req, res) {
    try {
      const { date_from, date_to } = req.query;
      const data = await AiChatLogModel.getChatUsageStats({ date_from, date_to });
      res.json({ success: true, data });
    } catch (error) {
      console.error('[SuperAdmin] getChatUsageStats error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch chat usage stats' });
    }
  }
}

module.exports = SuperAdminController;
