const express = require('express');
const router = express.Router();
const DocumentController = require('../controllers/documentController');
const { authenticateToken } = require('../middleware/auth');
const { financialDocUpload, strategicDocUpload } = require('../middleware/upload');

// Financial Documents
router.put('/:id/financial-document', authenticateToken, financialDocUpload.single('document'), DocumentController.upload);
router.post('/:id/upload-decision', authenticateToken, DocumentController.updateUploadDecision);
router.get('/:id/financial-document', authenticateToken, DocumentController.getInfo);
router.delete('/:id/financial-document', authenticateToken, DocumentController.delete);
router.get('/:id/financial-document/download', authenticateToken, DocumentController.download);

// Strategic Documents
router.put('/:id/strategic-document', authenticateToken, strategicDocUpload.single('document'), DocumentController.uploadStrategicDocument);
router.get('/:id/strategic-documents', authenticateToken, DocumentController.getStrategicDocuments);
router.delete('/:id/strategic-document/:filename', authenticateToken, DocumentController.deleteStrategicDocument);
router.get('/:id/strategic-document/:filename/download', authenticateToken, DocumentController.downloadStrategicDocument);
router.post('/:id/strategic-document/analyze', authenticateToken, DocumentController.analyzeStrategicDocuments);

module.exports = router;