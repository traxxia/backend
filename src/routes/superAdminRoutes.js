const express = require('express');
const router = express.Router();
const { authenticateToken, requireObservatory } = require('../middleware/auth');
const SuperAdminController = require('../controllers/superAdminController');

// All routes require authentication AND observatory/super_admin access
router.use(authenticateToken, requireObservatory);

// ── Analysis / ML Interaction Logs ────────────────────────────────────────────
router.get('/interactions',              SuperAdminController.getInteractions);
router.get('/interactions/:id',          SuperAdminController.getInteractionById);

router.get('/sessions',                  SuperAdminController.getSessions);
router.get('/sessions/:session_id',      SuperAdminController.getSessionDetail);

// ── AI Chat Logs ───────────────────────────────────────────────────────────────
// Note: /by-business/:business_id must come before /:id to avoid route conflict
router.get('/chat-logs/by-business/:business_id', SuperAdminController.getChatLogsByBusiness);
router.get('/chat-logs/:id',             SuperAdminController.getChatLogById);
router.get('/chat-logs',                 SuperAdminController.getChatLogs);

// ── Usage Statistics ───────────────────────────────────────────────────────────
router.get('/stats/models',              SuperAdminController.getModelStats);
router.get('/stats/stages',              SuperAdminController.getStageStats);
router.get('/stats/chat-usage',          SuperAdminController.getChatUsageStats);

module.exports = router;
