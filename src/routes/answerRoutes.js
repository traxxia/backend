const express = require('express');
const router = express.Router();
const AnswerController = require('../controllers/answerController');

// POST: Create a new answer
router.post('/', AnswerController.create);

// GET: Get answer by ID
router.get('/:id', AnswerController.getByID);

// GET: Get answers by business ID
router.get('/business/:business_id', AnswerController.getByBusinessID);

// PUT: Update answer by ID
router.put('/:id', AnswerController.update);

module.exports = router;
