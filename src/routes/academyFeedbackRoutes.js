const express = require('express');
const router = express.Router();
const academyFeedbackController = require('../controllers/academyFeedbackController');

// Submit academy feedback
router.post('/', academyFeedbackController.submitFeedback);

// Get academy feedback details
router.get('/', academyFeedbackController.getFeedback);

module.exports = router;
