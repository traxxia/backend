const express = require('express');
const router = express.Router();
const NotificationController = require('../controllers/notificationController');

// Ensure the user is authenticated (auth middleware might be named differently in the app)
// Assuming standard authenticateToken location. We will update if needed when modifying app.js.
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

router.get('/', NotificationController.getNotifications);
router.put('/read-all', NotificationController.markAllAsRead);
router.put('/:id/read', NotificationController.markAsRead);
router.delete('/:id', NotificationController.deleteNotification);

module.exports = router;
