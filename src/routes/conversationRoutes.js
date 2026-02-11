const express = require('express');
const router = express.Router();
const ConversationController = require('../controllers/conversationController');
const { authenticateToken } = require('../middleware/auth');
const { checkWriteAccess } = require('../middleware/subscriptionMiddleware');

router.get('/', authenticateToken, ConversationController.getAll);
router.post('/', authenticateToken, checkWriteAccess, ConversationController.create);
router.post('/skip', authenticateToken, checkWriteAccess, ConversationController.skip);
router.post('/followup-question', authenticateToken, checkWriteAccess, ConversationController.saveFollowupQuestion);
router.post('/phase-analysis', authenticateToken, checkWriteAccess, ConversationController.savePhaseAnalysis);
router.get('/phase-analysis', authenticateToken, ConversationController.getPhaseAnalysis);
router.delete('/', authenticateToken, ConversationController.deleteAll);

module.exports = router;