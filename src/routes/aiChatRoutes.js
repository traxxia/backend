const express = require('express');
const router = express.Router();
const AiHistoryController = require('../controllers/aiHistoryController');
const { authenticateToken } = require('../middleware/auth');

// Store a chat message
router.post('/history', authenticateToken, AiHistoryController.storeChat);

// Get chat history for a project
router.get('/history/:projectId', authenticateToken, AiHistoryController.getChatHistory);

// Clear chat history for a project or global
router.delete('/history/:projectId', authenticateToken, AiHistoryController.clearChatHistory);

// Observatory: Log a full AI chat turn (system prompt + user input + response).
// Gated server-side — no-ops (204) for non-observatory users.
router.post('/log-turn', authenticateToken, AiHistoryController.logTurn);

module.exports = router;
