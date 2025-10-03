const express = require('express');
const router = express.Router();
const ConversationController = require('../controllers/conversationController');
const { authenticateToken } = require('../middleware/auth');

router.get('/', authenticateToken, ConversationController.getAll);
router.post('/', authenticateToken, ConversationController.create);
router.post('/skip', authenticateToken, ConversationController.skip);
router.post('/followup-question', authenticateToken, ConversationController.saveFollowupQuestion);
router.post('/phase-analysis', authenticateToken, ConversationController.savePhaseAnalysis);
router.get('/phase-analysis', authenticateToken, ConversationController.getPhaseAnalysis);
router.delete('/', authenticateToken, ConversationController.deleteAll);

module.exports = router;