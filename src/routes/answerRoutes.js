const express = require('express');
const router = express.Router();
const AnswerController = require('../controllers/answerController');
const { authenticateToken } = require('../middleware/auth');

// POST: Create a new answer
router.post('/', authenticateToken, AnswerController.create);

// POST: Bulk create answers
router.post('/bulk', authenticateToken, AnswerController.bulkCreate);

// GET: Get answer by ID
router.get('/:id', authenticateToken, AnswerController.getByID);

// PUT: Bulk update answers
router.put('/bulk', authenticateToken, AnswerController.bulkUpdate);

// GET: Get answers by business ID
router.get('/business/:business_id', authenticateToken, AnswerController.getByBusinessID);

// PUT: Update answer by ID
router.put('/:id', authenticateToken, AnswerController.update);

module.exports = router;
