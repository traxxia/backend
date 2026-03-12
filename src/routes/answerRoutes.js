const express = require('express');
const router = express.Router();
const AnswerController = require('../controllers/answerController');
const { authenticateToken } = require('../middleware/auth');

router.post('/', authenticateToken, AnswerController.create);

router.get('/:id', authenticateToken, AnswerController.getByID);

router.get('/business/:business_id', authenticateToken, AnswerController.getByBusinessID);

router.put('/:id', authenticateToken, AnswerController.update);

module.exports = router;
