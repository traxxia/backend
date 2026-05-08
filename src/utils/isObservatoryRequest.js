/**
 * Gate utility — checks if the current request is from the Observatory Account.
 * Import this wherever logging decisions are made.
 *
 * Usage:
 *   const { isObservatoryRequest } = require('../utils/isObservatoryRequest');
 *   if (!isObservatoryRequest(req)) return; // skip for all regular users
 */

/**
 * Returns true ONLY if the authenticated user has is_observatory === true.
 * This is the single source of truth for all LLM logging gates.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isObservatoryRequest(req) {
  return req.user?.is_observatory === true;
}

/**
 * Builds common headers to forward to the Python ML backend,
 * including the x-is-observatory flag so Python can gate logging too.
 * @param {import('express').Request} req
 * @param {string} [sessionId] - The observatory session UUID (only set for observatory requests)
 * @returns {Record<string, string>}
 */
function buildMLHeaders(req, sessionId = '') {
  return {
    'Content-Type': 'application/json',
    'x-business-id': req.headers['x-business-id'] || '',
    'x-session-id': sessionId,
    'x-is-observatory': isObservatoryRequest(req) ? 'true' : 'false'
  };
}

module.exports = { isObservatoryRequest, buildMLHeaders };
