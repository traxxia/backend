const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/authController');
const { authenticateToken } = require('../middleware/auth');

router.post('/login', AuthController.login);
router.post('/register', AuthController.register);
router.post('/check-email', AuthController.checkEmail);
router.post('/logout', authenticateToken, AuthController.logout);
router.post('/complete-tour', authenticateToken, AuthController.completeTour);
router.post('/forgot-password', AuthController.forgotPassword);
router.post('/verify-otp', AuthController.verifyOtp);
router.post('/reset-password', AuthController.resetPassword);

module.exports = router;