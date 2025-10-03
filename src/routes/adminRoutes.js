const express = require('express');
const router = express.Router();
const AdminController = require('../controllers/adminController');
const { authenticateToken, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { logoUpload } = require('../middleware/upload');

// Company routes
router.get('/companies', authenticateToken, requireAdmin, AdminController.getCompanies);
router.post('/companies', authenticateToken, requireSuperAdmin, logoUpload.single('logo'), AdminController.createCompany);

// User routes
router.get('/users', authenticateToken, requireAdmin, AdminController.getUsers);
router.post('/users', authenticateToken, requireAdmin, AdminController.createUser);

// Audit routes
router.get('/audit-trail', authenticateToken, requireAdmin, AdminController.getAuditTrail);
router.get('/audit-trail/:audit_id/analysis-data', authenticateToken, requireAdmin, AdminController.getAuditAnalysisData);
router.get('/audit-trail/event-types', authenticateToken, requireAdmin, AdminController.getAuditEventTypes);

// User data route
router.get('/user-data/:user_id', authenticateToken, requireAdmin, AdminController.getUserData);

module.exports = router;