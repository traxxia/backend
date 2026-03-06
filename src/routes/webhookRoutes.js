const express = require('express');
const router = express.Router();
const WebhookController = require('../controllers/webhookController');

// Stripe requires the raw body for signature verification
router.post('/', (req, res, next) => {
    console.log(`[Router] Webhook Router Received Request`);
    next();
}, WebhookController.handleWebhook);

module.exports = router;
