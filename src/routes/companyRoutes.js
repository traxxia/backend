const express = require('express');
const router = express.Router();
const CompanyController = require('../controllers/companyController');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

router.get('/', CompanyController.getAll);
router.put('/:id/logo', authenticateToken, requireAdmin, CompanyController.updateLogo);
router.post('/update-ai-usage', authenticateToken, CompanyController.updateAITokenUsage);
router.get('/ai-usage/:business_id', authenticateToken, CompanyController.getAITokenUsage);


module.exports = router;