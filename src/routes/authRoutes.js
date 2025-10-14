const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/authController');
const { authenticateToken } = require('../middleware/auth');

router.post('/login', AuthController.login);
router.post('/register', AuthController.register);
router.post('/logout', authenticateToken, AuthController.logout);

module.exports = router;  