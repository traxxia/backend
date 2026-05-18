const express = require('express');
const router = express.Router();
const SessionStateController = require('../controllers/sessionStateController');
const { authenticateToken } = require('../middleware/auth');

router.post('/save-raw', authenticateToken, SessionStateController.saveRaw);
router.get('/business/:businessId', authenticateToken, SessionStateController.getSession);

module.exports = router;
