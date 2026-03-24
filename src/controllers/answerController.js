const { ObjectId } = require('mongodb');
const AnswerModel = require('../models/answerModel');
const BusinessModel = require('../models/businessModel');
const QuestionModel = require('../models/questionModel');

class AnswerController {
  
  static async create(req, res) {
    try {
      const { business_id, question_id, answer } = req.body;
      
      const answerData = {
        business_id: new ObjectId(business_id),
        question_id: new ObjectId(question_id),
        answer: answer
      };

      const result = await AnswerModel.create(answerData);
      
      res.status(201).json({
        message: 'Answer created successfully',
        data: { _id: result, ...answerData }
      });
    } catch (error) {
      console.error('Create answer error:', error);
      res.status(500).json({ error: 'Failed to create answer' });
    }
  }

  static async bulkCreate(req, res) {
    try {
      const { business_id, answers } = req.body;
      
      if (!business_id || !Array.isArray(answers) || answers.length === 0) {
        return res.status(400).json({ error: 'business_id and a non-empty array of answers are required' });
      }

      const answersData = answers.map(item => ({
        business_id: new ObjectId(business_id),
        question_id: new ObjectId(item.question_id),
        answer: item.answer
      }));

      const result = await AnswerModel.bulkCreate(answersData);
      
      res.status(201).json({
        message: `${answers.length} answers created successfully`,
        data: { insertedIds: result }
      });
    } catch (error) {
      console.error('Bulk create answers error:', error);
      res.status(500).json({ error: 'Failed to bulk create answers' });
    }
  }

  static async bulkUpdate(req, res) {
    try {
      const { business_id, answers } = req.body;
      
      if (!business_id || !Array.isArray(answers) || answers.length === 0) {
        return res.status(400).json({ error: 'business_id and a non-empty array of answers are required' });
      }

      const answersData = answers.map(item => {
         if(!item.answer_id) throw new Error("Missing answer_id in bulk update payload");
         return {
           answer_id: item.answer_id,
           answer: item.answer
         };
      });

      const result = await AnswerModel.bulkUpdate(answersData);
      
      res.json({
        message: `${result.modifiedCount} answers updated successfully`
      });
    } catch (error) {
      console.error('Bulk update answers error:', error);
      if (error.message && error.message.includes('Missing answer_id')) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: 'Failed to bulk update answers' });
    }
  }

  static async getByID(req, res) {
    try {
      const { id } = req.params;
      const answer = await AnswerModel.getById(id);
      
      if (!answer) {
        return res.status(404).json({ error: 'Answer not found' });
      }

      res.status(200).json({ data: answer });
    } catch (error) {
      console.error('Get answer by ID error:', error);
      res.status(500).json({ error: 'Failed to find answer' });
    }
  }

  static async getByBusinessID(req, res) {
    try {
      const { business_id } = req.params;
      
      if (!ObjectId.isValid(business_id)) {
        return res.status(400).json({ error: 'Invalid business ID' });
      }

      const businessObjectId = new ObjectId(business_id);

      // Fetch Business for business_info and document_info
      const business = await BusinessModel.findById(businessObjectId);
      if (!business) {
        return res.status(404).json({ error: 'Business not found' });
      }

      // Fetch All Active Questions
      const questions = await QuestionModel.findAll({ is_active: true });

      // Fetch Answers for this business
      const answers = await AnswerModel.getByBusinessId(business_id);
      
      // Prepare business info similar to how ConversationController does it
      const businessInfo = {
        id: business._id,
        name: business.business_name,
        purpose: business.business_purpose,
        location: {
          city: business.city || "",
          country: business.country || "",
          display: [business.city, business.country]
            .filter(Boolean)
            .join(", "),
        },
        upload_decision_made: business.upload_decision_made || false,
        upload_decision: business.upload_decision || null,
        created_at: business.created_at,
      };

      // Prepare document info
      let documentInfo = {
        has_document: false,
        file_exists: false,
        template_type: null,
        template_name: null,
        validation_confidence: null,
        upload_mode: null,
        file_content_base64: null,
        file_content_available: false,
        storage_type: null,
        blob_url: null,
      };

      if (business.has_financial_document && business.financial_document) {
        documentInfo = {
          has_document: true,
          file_exists: !!business.financial_document.blob_url,
          filename: business.financial_document.original_name,
          upload_date: business.financial_document.upload_date,
          file_size: business.financial_document.file_size,
          file_type: business.financial_document.file_type,
          is_processed: business.financial_document.is_processed || false,
          uploaded_by: business.financial_document.uploaded_by,
          template_type: business.financial_document.template_type || "unknown",
          template_name: business.financial_document.template_name || "Unknown",
          validation_confidence: business.financial_document.validation_confidence || "medium",
          upload_mode: business.financial_document.upload_mode || "manual",
          blob_url: business.financial_document.blob_url || null,
          storage_type: business.financial_document.blob_url ? "blob" : "filesystem",
          file_content_base64: null,
          file_content_available: false,
        };
      }

      res.status(200).json({ 
        data: answers,
        questions: questions,
        business_info: businessInfo,
        document_info: documentInfo
      });
    } catch (error) {
      console.error('Get answers by business ID error:', error);
      res.status(500).json({ error: 'Failed to find answers' });
    }
  }

  static async update(req, res) {
    try {
      const { id } = req.params;
      const { answer } = req.body;
      
      const updateData = {};
      if (answer !== undefined) {
        updateData.answer = answer;
      }
      
      const result = await AnswerModel.update(id, updateData);
      
      if (result.matchedCount === 0) {
         return res.status(404).json({ error: 'Answer not found' });
      }

      res.status(200).json({ message: 'Answer updated successfully' });
    } catch (error) {
      console.error('Update answer error:', error);
      res.status(500).json({ error: 'Failed to update answer' });
    }
  }
}

module.exports = AnswerController;
