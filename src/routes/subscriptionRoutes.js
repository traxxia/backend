const express = require('express');
const router = express.Router();
const SubscriptionController = require('../controllers/subscriptionController');
const { authenticateToken } = require('../middleware/auth');

router.get('/plan-details', authenticateToken, SubscriptionController.getDetails);
router.put('/upgrade', authenticateToken, SubscriptionController.upgrade);
router.post('/process-configuration', authenticateToken, SubscriptionController.processConfiguration);
router.post('/payment-methods/add', authenticateToken, SubscriptionController.addPaymentMethod);
router.post('/payment-methods/set-default', authenticateToken, SubscriptionController.setDefaultPaymentMethod);
router.delete('/payment-methods/:paymentMethodId', authenticateToken, SubscriptionController.removePaymentMethod);


module.exports = router;
