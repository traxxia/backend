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

  static async analyzeDocuments(req, res) {
    try {
      const businessId = req.params.id;
      const uploadedFile = req.file;

      if (!uploadedFile) {
        return res.status(400).json({ error: 'No document file uploaded' });
      }

      // Fetch active questions
      const QuestionModel = require('../models/questionModel');
      const questions = await QuestionModel.findAll({ is_active: true });

      const mockAnswers = questions.map((question, index) => {
        const qId = String(question._id || question.question_id);
        const text = question.question_text || '';
        const lowerText = text.toLowerCase();

        let answer = '';
        let status = 'FOUND';
        let confidence = parseFloat((0.8 + Math.random() * 0.19).toFixed(2));
        let page = (index % 8) + 1;
        let evidenceText = '';

        if (lowerText.includes('name') || lowerText.includes('identity')) {
          answer = '[AI Extraction] Traxxia Enterprise Solutions';
          evidenceText = 'The business operates under the trade name Traxxia Enterprise Solutions.';
        } else if (lowerText.includes('purpose') || lowerText.includes('objective') || lowerText.includes('mission')) {
          answer = '[AI Extraction] To provide high-quality, high-capacity automated agentic strategic solutions to enterprise customers globally.';
          evidenceText = 'Our primary objective is to scale automated, reliable execution pipelines and expand target market reach.';
        } else if (lowerText.includes('target') || lowerText.includes('audience') || lowerText.includes('customer') || lowerText.includes('segment')) {
          answer = '[AI Extraction] B2B Mid-market and enterprise organizations looking to automate complex software and operational engineering pipelines.';
          evidenceText = 'The primary target segment comprises B2B mid-market organizations and enterprise players.';
        } else if (lowerText.includes('competit') || lowerText.includes('rival') || lowerText.includes('landscape')) {
          answer = '[AI Extraction] Legacy management consultancies and early-stage specialized SaaS companies in the automation domain.';
          evidenceText = 'We face competition from legacy firms and modern AI startups offering narrow automation tools.';
        } else if (lowerText.includes('pricing') || lowerText.includes('cost') || lowerText.includes('revenue') || lowerText.includes('model')) {
          answer = '[AI Extraction] Enterprise subscription tiers starting from $499/month, supplemented by custom pilot consulting contracts.';
          evidenceText = 'Pricing is structured on a tiered B2B SaaS model to ensure scalable adoption across customer sizes.';
        } else if (lowerText.includes('effective') || lowerText.includes('date') || lowerText.includes('launch') || lowerText.includes('start')) {
          answer = '[AI Extraction] March 1, 2025';
          evidenceText = 'This policy is effective from March 1, 2025.';
        } else if (lowerText.includes('board') || lowerText.includes('directors') || lowerText.includes('approve') || lowerText.includes('governance')) {
          answer = '[AI Extraction] Board of Directors';
          evidenceText = 'Approved by the Board of Directors.';
        } else if (lowerText.includes('violation') || lowerText.includes('penalty') || lowerText.includes('breach') || lowerText.includes('risk')) {
          answer = '';
          status = 'NOT_FOUND';
          confidence = 0.0;
        } else {
          const businessThemes = [
            'Optimizing operational efficiency through high-capacity automated agentic workflow pipelines.',
            'Targeting a 35% reduction in project delivery overhead within the next two fiscal quarters.',
            'Maintaining strict compliance with global digital security and data protection regulations.',
            'Fostering strong peer-to-peer developer collaboration and organic platform adoption.',
            'Developing flexible, integration-ready standard architectures that hook into client ERP networks.'
          ];
          const chosenTheme = businessThemes[index % businessThemes.length];
          answer = `[AI Extraction] ${chosenTheme}`;
          evidenceText = `As documented under Section ${index + 1}: ${chosenTheme}`;
        }

        return {
          question_id: qId,
          answer: answer,
          confidence: confidence,
          status: status,
          evidence: status === 'FOUND' ? [{
            page: page,
            text: evidenceText,
            document_name: uploadedFile.originalname
          }] : null
        };
      });

      res.status(200).json({
        request_id: `req_${Math.random().toString(36).substr(2, 9)}`,
        answers: mockAnswers
      });
    } catch (error) {
      console.error('Document analysis error:', error);
      res.status(500).json({ error: 'Failed to analyze documents' });
    }
  }
}

module.exports = DocumentController;