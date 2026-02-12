const express = require('express');
const router = express.Router();
const SubscriptionController = require('../controllers/subscriptionController');
const { authenticateToken } = require('../middleware/auth');

router.get('/plan-details', authenticateToken, SubscriptionController.getDetails);
router.put('/upgrade', authenticateToken, SubscriptionController.upgrade);
router.post('/process-downgrade', authenticateToken, SubscriptionController.processDowngrade);
router.post('/process-reactivation', authenticateToken, SubscriptionController.processReactivation);

module.exports = router;
