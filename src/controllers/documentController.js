const { ObjectId } = require('mongodb');
const BusinessModel = require('../models/businessModel');
const { logAuditEvent } = require('../services/auditService');
const blobService = require('../services/blobService');
const { VALID_TEMPLATE_TYPES } = require('../config/constants');

class DocumentController {
  static async upload(req, res) {
    try {
      const businessId = req.params.id;
      const uploadedFile = req.file;
      const { template_type, template_name, validation_confidence, upload_mode } = req.body;

      if (!uploadedFile) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      if (template_type && !VALID_TEMPLATE_TYPES.includes(template_type)) {
        return res.status(400).json({
          error: `Invalid template type. Must be one of: ${VALID_TEMPLATE_TYPES.join(', ')}`
        });
      }

      const business = await BusinessModel.findById(businessId, req.user._id);
      if (!business) {
        return res.status(404).json({ error: 'Business not found or access denied' });
      }

      let previousDocument = null;
      let action = 'uploaded';

      if (business.financial_document && business.financial_document.blob_url) {
        previousDocument = {
          filename: business.financial_document.filename,
          original_name: business.financial_document.original_name,
          upload_date: business.financial_document.upload_date,
          template_type: business.financial_document.template_type || 'unknown'
        };
        action = 'replaced';
      }

      const blobName = `${businessId}_${Date.now()}_${uploadedFile.originalname}`;
      const blobUrl = await blobService.uploadBuffer(blobName, uploadedFile.buffer, uploadedFile.mimetype);

      const documentData = {
        filename: blobName,
        original_name: uploadedFile.originalname,
        blob_url: blobUrl,
        file_type: uploadedFile.mimetype,
        file_size: uploadedFile.size,
        upload_date: new Date(),
        uploaded_by: new ObjectId(req.user._id),
        is_processed: false,
        template_type: template_type || 'unknown',
        template_name: template_name || 'Unknown Template',
        validation_confidence: validation_confidence || 'medium',
        upload_mode: upload_mode || 'manual'
      };

      const updateResult = await BusinessModel.updateDocument(businessId, documentData);

      if (updateResult.modifiedCount === 0) {
        return res.status(500).json({ error: 'Failed to update business document' });
      }

      await BusinessModel.updateUploadDecision(businessId, 'upload');

      await logAuditEvent(req.user._id, 'financial_document_uploaded', {
        business_id: businessId,
        business_name: business.business_name,
        action: action,
        filename: uploadedFile.originalname,
        file_size: uploadedFile.size,
        file_type: uploadedFile.mimetype,
        template_type: template_type || 'unknown',
        template_name: template_name || 'Unknown Template',
        validation_confidence: validation_confidence || 'medium',
        upload_mode: upload_mode || 'manual',
        previous_document: previousDocument
      });

      res.json({
        message: `Financial document ${action} successfully`,
        action: action,
        template_type: template_type || 'unknown',
        template_name: template_name || 'Unknown Template',
        previous_document: previousDocument,
        current_document: {
          filename: uploadedFile.originalname,
          upload_date: documentData.upload_date,
          file_size: uploadedFile.size,
          file_type: uploadedFile.mimetype,
          template_type: template_type || 'unknown',
          template_name: template_name || 'Unknown Template',
          validation_confidence: validation_confidence || 'medium'
        }
      });

    } catch (error) {
      console.error('Financial document upload error:', error);
      res.status(500).json({ error: 'Failed to upload financial document' });
    }
  }

  static async updateUploadDecision(req, res) {
    try {
      const businessId = req.params.id;
      const { decision } = req.body;

      await BusinessModel.updateUploadDecision(businessId, decision);

      res.json({ message: 'Upload decision saved', decision });
    } catch (error) {
      console.error('Failed to save decision:', error);
      res.status(500).json({ error: 'Failed to save decision' });
    }
  }

  static async getInfo(req, res) {
    try {
      const businessId = req.params.id;

      const business = await BusinessModel.findById(businessId, req.user._id);
      if (!business) {
        return res.status(404).json({ error: 'Business not found or access denied' });
      }

      if (!business.has_financial_document || !business.financial_document) {
        return res.json({
          has_document: false,
          message: 'No financial document uploaded for this business'
        });
      }

      let fileExists = business.financial_document.blob_url ? true : false;

      res.json({
        has_document: true,
        file_exists: fileExists,
        upload_decision_made: business.upload_decision_made || false,
        upload_decision: business.upload_decision || null,
        document: {
          filename: business.financial_document.original_name,
          upload_date: business.financial_document.upload_date,
          file_size: business.financial_document.file_size,
          file_type: business.financial_document.file_type,
          uploaded_by: business.financial_document.uploaded_by,
          is_processed: business.financial_document.is_processed || false,
          template_type: business.financial_document.template_type || 'unknown',
          template_name: business.financial_document.template_name || 'Unknown Template',
          validation_confidence: business.financial_document.validation_confidence || 'medium',
          upload_mode: business.financial_document.upload_mode || 'manual'
        }
      });

    } catch (error) {
      console.error('Get financial document error:', error);
      res.status(500).json({ error: 'Failed to get financial document info' });
    }
  }

  static async delete(req, res) {
    try {
      const businessId = req.params.id;
      const { getDB } = require('../config/database');
      const db = getDB();

      const business = await BusinessModel.findById(businessId, req.user._id);
      if (!business) {
        return res.status(404).json({ error: 'Business not found or access denied' });
      }

      if (!business.has_financial_document || !business.financial_document) {
        return res.status(404).json({ error: 'No financial document found for this business' });
      }

      const updateResult = await db.collection('user_businesses').updateOne(
        { _id: new ObjectId(businessId) },
        {
          $unset: { financial_document: "" },
          $set: {
            has_financial_document: false,
            updated_at: new Date()
          }
        }
      );

      if (updateResult.modifiedCount === 0) {
        return res.status(500).json({ error: 'Failed to delete financial document record' });
      }

      await logAuditEvent(req.user._id, 'financial_document_deleted', {
        business_id: businessId,
        business_name: business.business_name,
        deleted_document: {
          filename: business.financial_document.original_name,
          upload_date: business.financial_document.upload_date
        }
      });

      res.json({
        message: 'Financial document deleted successfully',
        deleted_document: {
          filename: business.financial_document.original_name,
          upload_date: business.financial_document.upload_date
        }
      });

    } catch (error) {
      console.error('Delete financial document error:', error);
      res.status(500).json({ error: 'Failed to delete financial document' });
    }
  }

  static async download(req, res) {
    try {
      const businessId = req.params.id;

      const business = await BusinessModel.findById(businessId, req.user._id);
      if (!business) {
        return res.status(404).json({ error: 'Business not found or access denied' });
      }

      if (!business.has_financial_document || !business.financial_document) {
        return res.status(404).json({ error: 'No financial document found for this business' });
      }

      await blobService.downloadToStream(
        business.financial_document.filename,
        res,
        business.financial_document.file_type,
        business.financial_document.original_name
      );

    } catch (error) {
      console.error('Download financial document error:', error);
      res.status(500).json({ error: 'Failed to download financial document' });
    }
  }

  static async uploadStrategicDocument(req, res) {
    try {
      const businessId = req.params.id;
      const uploadedFile = req.file;

      if (!uploadedFile) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const business = await BusinessModel.findById(businessId, req.user._id);
      if (!business) {
        return res.status(404).json({ error: 'Business not found or access denied' });
      }

      // Encrypt the file buffer!
      const crypto = require('crypto');
      const keyHex = process.env.ENCRYPTION_KEY || '586c0217d62713ed562b2952c2d8ede13d110cd416bc2278b70c9b57e71e6b7e';
      const key = Buffer.from(keyHex, 'hex');
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      const encrypted = Buffer.concat([cipher.update(uploadedFile.buffer), cipher.final()]);
      const encryptedBuffer = Buffer.concat([iv, encrypted]);

      // Upload to Azure Blob!
      const blobName = `strategic_${businessId}_${Date.now()}_${uploadedFile.originalname}`;
      const blobUrl = await blobService.uploadBuffer(blobName, encryptedBuffer, 'application/octet-stream');

      const documentData = {
        filename: blobName,
        original_name: uploadedFile.originalname,
        blob_url: blobUrl,
        file_type: uploadedFile.mimetype,
        file_size: uploadedFile.size,
        upload_date: new Date(),
        uploaded_by: new ObjectId(req.user._id)
      };

      await BusinessModel.addStrategicDocument(businessId, documentData);

      await logAuditEvent(req.user._id, 'strategic_document_uploaded', {
        business_id: businessId,
        business_name: business.business_name,
        filename: uploadedFile.originalname,
        file_size: uploadedFile.size,
        file_type: uploadedFile.mimetype
      });

      res.json({
        message: 'Strategic document uploaded and encrypted successfully',
        document: documentData
      });

    } catch (error) {
      console.error('Strategic document upload error:', error);
      res.status(500).json({ error: 'Failed to upload strategic document' });
    }
  }

  static async getStrategicDocuments(req, res) {
    try {
      const businessId = req.params.id;
      const business = await BusinessModel.findById(businessId, req.user._id);
      if (!business) {
        return res.status(404).json({ error: 'Business not found or access denied' });
      }

      res.json({
        documents: business.strategic_documents || []
      });
    } catch (error) {
      console.error('Get strategic documents error:', error);
      res.status(500).json({ error: 'Failed to get strategic documents' });
    }
  }

  static async deleteStrategicDocument(req, res) {
    try {
      const businessId = req.params.id;
      const { filename } = req.params;

      const business = await BusinessModel.findById(businessId, req.user._id);
      if (!business) {
        return res.status(404).json({ error: 'Business not found or access denied' });
      }

      const doc = (business.strategic_documents || []).find(d => d.filename === filename);
      if (!doc) {
        return res.status(404).json({ error: 'Document not found' });
      }

      // Delete from blob storage
      try {
        await blobService.deleteBlob(filename);
      } catch (err) {
        console.warn('Failed to delete blob:', err);
      }

      // Remove from DB
      await BusinessModel.removeStrategicDocument(businessId, filename);

      await logAuditEvent(req.user._id, 'strategic_document_deleted', {
        business_id: businessId,
        business_name: business.business_name,
        filename: doc.original_name
      });

      res.json({ message: 'Strategic document deleted successfully' });
    } catch (error) {
      console.error('Delete strategic document error:', error);
      res.status(500).json({ error: 'Failed to delete strategic document' });
    }
  }

  static async downloadStrategicDocument(req, res) {
    try {
      const businessId = req.params.id;
      const { filename } = req.params;

      const business = await BusinessModel.findById(businessId, req.user._id);
      if (!business) {
        return res.status(404).json({ error: 'Business not found or access denied' });
      }

      const doc = (business.strategic_documents || []).find(d => d.filename === filename);
      if (!doc) {
        return res.status(404).json({ error: 'Document not found' });
      }

      await blobService.downloadToStream(
        filename,
        res,
        'application/octet-stream',
        doc.original_name
      );
    } catch (error) {
      console.error('Download strategic document error:', error);
      res.status(500).json({ error: 'Failed to download strategic document' });
    }
  }

  static async analyzeStrategicDocuments(req, res) {
    try {
      const businessId = req.params.id;

      const business = await BusinessModel.findById(businessId, req.user._id);
      if (!business) {
        return res.status(404).json({ error: 'Business not found or access denied' });
      }

      const docs = business.strategic_documents || [];
      if (docs.length === 0) {
        return res.status(400).json({ error: 'No strategic documents uploaded for this business' });
      }

      const crypto = require('crypto');
      const keyHex = process.env.ENCRYPTION_KEY || '586c0217d62713ed562b2952c2d8ede13d110cd416bc2278b70c9b57e71e6b7e';
      const key = Buffer.from(keyHex, 'hex');

      const decryptedFiles = [];

      for (const doc of docs) {
        try {
          const encryptedBuffer = await blobService.downloadToBuffer(doc.filename);

          const iv = encryptedBuffer.subarray(0, 16);
          const ciphertext = encryptedBuffer.subarray(16);
          const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
          const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

          decryptedFiles.push({
            buffer: decrypted,
            original_name: doc.original_name,
            file_type: doc.file_type || 'application/octet-stream'
          });
        } catch (err) {
          console.error(`Failed to download or decrypt strategic doc: ${doc.original_name}`, err);
          return res.status(500).json({ error: `Failed to retrieve and decrypt document: ${doc.original_name}` });
        }
      }

      const formData = new FormData();
      decryptedFiles.forEach(file => {
        const blob = new Blob([file.buffer], { type: file.file_type });
        formData.append('files', blob, file.original_name);
      });

      const mlUrl = process.env.ML_BACKEND_URL || 'https://trax-qa1-ml-b4e6gmc4hjdncdg2.centralus-01.azurewebsites.net';
      const mlResponse = await fetch(`${mlUrl}/document-qa`, {
        method: 'POST',
        body: formData
      });

      if (!mlResponse.ok) {
        const errText = await mlResponse.text();
        throw new Error(`ML API request failed: ${mlResponse.statusText}. Details: ${errText}`);
      }

      const mlData = await mlResponse.json();
      if (!mlData || !Array.isArray(mlData.answers)) {
        throw new Error('Invalid response received from the analysis engine.');
      }

      const QuestionModel = require('../models/questionModel');
      const AnswerModel = require('../models/answerModel');

      const questions = await QuestionModel.findAll({ is_active: true });
      const combinedFileNames = docs.map(d => d.original_name).join(', ');
      const mappedAnswers = [];

      mlData.answers.forEach(item => {
        let localQId = item.question_id;
        if (typeof item.question_id === 'string' && item.question_id.startsWith('q_')) {
          const qNum = parseInt(item.question_id.replace('q_', ''), 10);
          let targetQuestion = questions.find(q => q.order === qNum);
          if (!targetQuestion) {
            const phaseOrderMap = { 'initial': 1, 'essential': 2, 'advanced': 3 };
            const sorted = [...questions].sort((a, b) => {
              const phaseA = phaseOrderMap[a.phase?.toLowerCase()] || 4;
              const phaseB = phaseOrderMap[b.phase?.toLowerCase()] || 4;
              if (phaseA !== phaseB) return phaseA - phaseB;
              return (a.order || 0) - (b.order || 0);
            });
            targetQuestion = sorted[qNum - 1];
          }
          if (targetQuestion) {
            localQId = String(targetQuestion._id);
          } else {
            console.warn(`Could not map ML API question_id ${item.question_id} to any database question`);
            return;
          }
        }

        let evidence = null;
        if (item.status === 'FOUND') {
          if (Array.isArray(item.evidence) && item.evidence.length > 0) {
            evidence = item.evidence.map(ev => ({
              ...ev,
              document_name: ev.document_name || ev.filename || ev.file || combinedFileNames
            }));
          } else {
            evidence = [{
              page: 1,
              text: item.answer || '',
              document_name: combinedFileNames
            }];
          }
        } else if (item.status === 'NOT_FOUND') {
          evidence = [{
            page: 1,
            text: 'No relevant information found in the document.',
            document_name: combinedFileNames
          }];
        }

        mappedAnswers.push({
          question_id: localQId,
          answer: item.answer,
          confidence: item.confidence,
          status: item.status,
          evidence: evidence
        });
      });

      const existingAnswers = await AnswerModel.getByBusinessId(businessId);
      const existingAnswerMap = {};
      existingAnswers.forEach(ans => {
        existingAnswerMap[String(ans.question_id)] = String(ans._id);
      });

      const toCreate = [];
      const toUpdate = [];

      mappedAnswers.forEach(item => {
        const qIdStr = String(item.question_id);
        const existingId = existingAnswerMap[qIdStr];

        if (existingId) {
          toUpdate.push({
            answer_id: existingId,
            answer: item.answer || '',
            confidence: item.confidence,
            status: item.status,
            evidence: item.evidence,
            ai_answer: item.answer || '',
            user_answer: null,
            previous_answer: null
          });
        } else {
          toCreate.push({
            business_id: new ObjectId(businessId),
            question_id: new ObjectId(item.question_id),
            answer: item.answer || '',
            confidence: item.confidence,
            status: item.status,
            evidence: item.evidence,
            ai_answer: item.answer || '',
            user_answer: null,
            previous_answer: null
          });
        }
      });

      const savedAnswers = [];

      if (toCreate.length > 0) {
        const insertedIds = await AnswerModel.bulkCreate(toCreate);
        toCreate.forEach((item, index) => {
          const newId = insertedIds[index];
          if (newId) {
            savedAnswers.push({
              _id: newId,
              business_id: item.business_id,
              question_id: item.question_id,
              answer: item.answer,
              confidence: item.confidence,
              status: item.status,
              evidence: item.evidence,
              ai_answer: item.ai_answer,
              user_answer: item.user_answer,
              previous_answer: item.previous_answer,
              created_at: new Date(),
              updated_at: new Date()
            });
          }
        });
      }

      if (toUpdate.length > 0) {
        await AnswerModel.bulkUpdate(toUpdate);
        const updatedIds = toUpdate.map(t => new ObjectId(t.answer_id));
        const { getDB } = require('../config/database');
        const db = getDB();
        const updatedDocs = await db.collection('answers').find({ _id: { $in: updatedIds } }).toArray();
        savedAnswers.push(...updatedDocs);
      }

      await logAuditEvent(req.user._id, 'strategic_documents_analyzed', {
        business_id: businessId,
        business_name: business.business_name,
        documents_count: docs.length,
        answers_updated_count: savedAnswers.length
      });

      res.json({
        message: 'Strategic documents analyzed and answers saved successfully',
        answers: savedAnswers
      });
    } catch (error) {
      console.error('Strategic document analysis error:', error);
      res.status(500).json({ error: error.message || 'Failed to analyze strategic documents' });
    }
  }

}

module.exports = DocumentController;