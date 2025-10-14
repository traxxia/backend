const express = require('express');
const router = express.Router();
const DocumentController = require('../controllers/documentController');
const { authenticateToken } = require('../middleware/auth');
const { financialDocUpload } = require('../middleware/upload');

router.put('/:id/financial-document', authenticateToken, financialDocUpload.single('document'), DocumentController.upload);
router.post('/:id/upload-decision', authenticateToken, DocumentController.updateUploadDecision);
router.get('/:id/financial-document', authenticateToken, DocumentController.getInfo);
router.delete('/:id/financial-document', authenticateToken, DocumentController.delete);
router.get('/:id/financial-document/download', authenticateToken, DocumentController.download);

module.exports = router;