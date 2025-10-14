const express = require('express');
const router = express.Router();
const CompanyController = require('../controllers/companyController');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

router.get('/', CompanyController.getAll);
router.put('/:id/logo', authenticateToken, requireAdmin, CompanyController.updateLogo);

module.exports = router;