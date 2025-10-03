const express = require('express');
const router = express.Router();
const QuestionController = require('../controllers/questionController');
const { authenticateToken, requireSuperAdmin } = require('../middleware/auth');

router.get('/', authenticateToken, QuestionController.getAll);
router.post('/missing-for-analysis', authenticateToken, QuestionController.checkMissingForAnalysis);
router.put('/reorder', authenticateToken, requireSuperAdmin, QuestionController.reorder);
router.post('/bulk', authenticateToken, requireSuperAdmin, QuestionController.bulkCreateOrUpdate);
router.put('/:id', authenticateToken, requireSuperAdmin, QuestionController.update);
router.delete('/:id', authenticateToken, requireSuperAdmin, QuestionController.delete);

module.exports = router;