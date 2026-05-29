const express = require('express');
const router = express.Router();
const SessionStateController = require('../controllers/sessionStateController');
const { authenticateToken } = require('../middleware/auth');

router.post('/save-raw', authenticateToken, SessionStateController.saveRaw);
router.get('/business/:businessId', authenticateToken, SessionStateController.getSession);

// Document Intelligence Pipeline & Sync Endpoints
router.get('/business/:businessId/stream-analysis', SessionStateController.streamAnalysis);
router.post('/business/:businessId/update-session', authenticateToken, SessionStateController.updateSession);
router.post('/business/:businessId/sync-financial', authenticateToken, SessionStateController.syncFinancial);

module.exports = router;
