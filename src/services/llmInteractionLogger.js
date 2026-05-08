const LLMInteractionLogModel = require('../models/llmInteractionLogModel');
const { isObservatoryRequest } = require('../utils/isObservatoryRequest');
const { v4: uuidv4 } = require('uuid');

/**
 * Generate a new observatory session ID.
 * Called once at the start of a business-creation flow.
 */
function generateSessionId() {
  return `obs_${uuidv4()}`;
}

/**
 * Log an ML backend interaction. Fire-and-forget — never throws.
 * Silently skips if the request is not from the Observatory Account.
 *
 * @param {import('express').Request} req
 * @param {object} logData
 */
async function logMLInteraction(req, logData) {
  // ✅ GATE: Only log for Observatory Account
  if (!isObservatoryRequest(req)) return;

  try {
    await LLMInteractionLogModel.create({
      observatory_account_id: req.user._id,
      session_id: req.observatorySessionId || null,
      business_id: logData.business_id || req.headers['x-business-id'] || null,
      business_name: logData.business_name || null,
      stage: logData.stage,
      llm_provider: logData.llm_provider,
      model: logData.model,
      system_prompt: logData.system_prompt,
      user_prompt: logData.user_prompt,
      llm_response: logData.llm_response,
      crawl_details: logData.crawl_details || null,
      token_usage: logData.token_usage || null,
      latency_ms: logData.latency_ms || null,
      status: logData.status || 'success',
      error_message: logData.error_message || null,
      metadata: logData.metadata || {}
    });
  } catch (err) {
    // Never let logging failures affect the main request
    console.error('[Observatory] Failed to log ML interaction:', err.message);
  }
}

/**
 * Middleware: Attaches observatorySessionId to req for Observatory Account requests.
 * Inject at the start of business-creation routes.
 */
function attachObservatorySession(req, _res, next) {
  if (isObservatoryRequest(req)) {
    req.observatorySessionId = generateSessionId();
  }
  next();
}

module.exports = { logMLInteraction, attachObservatorySession, generateSessionId };
