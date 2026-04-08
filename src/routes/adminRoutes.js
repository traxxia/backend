const express = require('express');
const router = express.Router();
const AdminController = require('../controllers/adminController');
const QuestionController = require('../controllers/questionController');
const { authenticateToken, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { logoUpload } = require('../middleware/upload');

// Company routes
router.get('/companies', authenticateToken, requireAdmin, AdminController.getCompanies);
router.post('/companies', authenticateToken, requireSuperAdmin, logoUpload.single('logo'), AdminController.createCompany);
router.put('/companies/:id', authenticateToken, requireAdmin, AdminController.updateCompany);
router.put('/companies/:id/logo', authenticateToken, requireAdmin, logoUpload.single('logo'), AdminController.updateCompanyLogo);
router.get('/companies/:id/logo/display', AdminController.serveLogo);

// User routes
router.get('/users', authenticateToken, requireAdmin, AdminController.getUsers);
router.post('/users', authenticateToken, requireAdmin, AdminController.createUser);

// Audit routes
router.get('/audit-trail', authenticateToken, requireAdmin, AdminController.getAuditTrail);
router.get('/audit-trail/:audit_id/analysis-data', authenticateToken, requireAdmin, AdminController.getAuditAnalysisData);
router.get('/audit-trail/event-types', authenticateToken, requireAdmin, AdminController.getAuditEventTypes);

// User data route
router.get('/user-data/:user_id', authenticateToken, requireAdmin, AdminController.getUserData);
router.get('/businesses', authenticateToken, requireAdmin, AdminController.getCompanyBusinesses);
router.delete('/businesses/:business_id/participants/:user_id', authenticateToken, requireAdmin, AdminController.removeParticipant);
router.get('/stale-projects', authenticateToken, requireAdmin, AdminController.getStaleProjects);
router.put('/users/:user_id/role', authenticateToken, requireAdmin, AdminController.updateUserRole);

// Question routes
router.post('/questions', authenticateToken, requireSuperAdmin, QuestionController.create);
router.get('/questions', authenticateToken, requireAdmin, QuestionController.getAll);
router.put('/questions/reorder', authenticateToken, requireSuperAdmin, QuestionController.reorder);
router.put('/questions/:id', authenticateToken, requireSuperAdmin, QuestionController.update);
router.delete('/questions/:id', authenticateToken, requireSuperAdmin, QuestionController.delete);

module.exports = router;