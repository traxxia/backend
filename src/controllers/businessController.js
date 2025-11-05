const { ObjectId } = require('mongodb');
const BusinessModel = require('../models/businessModel');
const ConversationModel = require('../models/conversationModel');
const QuestionModel = require('../models/questionModel');
const { logAuditEvent } = require('../services/auditService');
const { MAX_BUSINESSES_PER_USER, ALLOWED_PHASES } = require('../config/constants');

class BusinessController {
  static async getAll(req, res) {
    try {
      const { user_id } = req.query;
      let targetUserId;

      if (user_id) {
        if (!['super_admin', 'company_admin'].includes(req.user.role.role_name)) {
          return res.status(403).json({ error: 'Admin access required to view other users businesses' });
        }
        const targetUser = await UserModel.findById(user_id);
        if (!targetUser) {
          return res.status(404).json({ error: 'User not found' });
        }
        if (req.user.role.role_name === 'company_admin') {
          if (!targetUser.company_id || targetUser.company_id.toString() !== req.user.company_id.toString()) {
            return res.status(403).json({ error: 'Access denied - user not in your company' });
          }
        }
        targetUserId = new ObjectId(user_id);
      } else {
        targetUserId = new ObjectId(req.user._id);
      }

      const businesses = await BusinessModel.findByUserId(targetUserId);

      const totalQuestions = await QuestionModel.countDocuments({
        is_active: true,
        phase: { $in: ALLOWED_PHASES }
      });

      const enhancedBusinesses = await Promise.all(
        businesses.map(async (business) => {
          const conversations = await ConversationModel.findByFilter({
            user_id: targetUserId,
            business_id: business._id,
            conversation_type: 'question_answer'
          });

          const questionStats = {};
          conversations.forEach(conv => {
            if (conv.question_id) {
              const questionId = conv.question_id.toString();
              if (!questionStats[questionId]) {
                questionStats[questionId] = {
                  hasAnswers: false,
                  isComplete: false,
                  answerCount: 0
                };
              }
              if (conv.answer_text && conv.answer_text.trim() !== '') {
                questionStats[questionId].hasAnswers = true;
                questionStats[questionId].answerCount++;
              }
              if (conv.metadata && conv.metadata.is_complete === true) {
                questionStats[questionId].isComplete = true;
              }
            }
          });

          const allowedQuestions = await QuestionModel.findAll({
            is_active: true,
            phase: { $in: ALLOWED_PHASES }
          });

          const allowedQuestionIds = new Set(
            allowedQuestions.map(q => q._id.toString())
          );

          const filteredQuestionStats = Object.entries(questionStats).filter(
            ([questionId, stats]) => allowedQuestionIds.has(questionId)
          );

          const completedQuestions = filteredQuestionStats.filter(
            ([questionId, stat]) => stat.isComplete || stat.hasAnswers
          ).length;

          const pendingQuestions = totalQuestions - completedQuestions;
          const progressPercentage = totalQuestions > 0
            ? Math.round((completedQuestions / totalQuestions) * 100)
            : 0;

          return {
            ...business,
            city: business.city || '',
            country: business.country || '',
            location_display: [business.city, business.country].filter(Boolean).join(', '),
            has_financial_document: business.has_financial_document || false,
            financial_document_info: business.has_financial_document && business.financial_document ? {
              filename: business.financial_document.original_name,
              upload_date: business.financial_document.upload_date,
              file_size: business.financial_document.file_size,
              file_type: business.financial_document.file_type
            } : null,
            question_statistics: {
              total_questions: totalQuestions,
              completed_questions: completedQuestions,
              pending_questions: pendingQuestions,
              progress_percentage: progressPercentage,
              total_answers_given: filteredQuestionStats.reduce(
                (sum, [questionId, stat]) => sum + stat.answerCount, 0
              ),
              excluded_phases: ['good'],
              included_phases: ALLOWED_PHASES
            }
          };
        })
      );

      res.json({
        businesses: enhancedBusinesses,
        overall_stats: {
          total_businesses: businesses.length,
          total_questions_in_system: totalQuestions,
          businesses_with_location: enhancedBusinesses.filter(b => b.city || b.country).length,
          businesses_with_documents: enhancedBusinesses.filter(b => b.has_financial_document).length,
          calculation_method: 'excluding_good_phase',
          phases_included: ALLOWED_PHASES,
          phases_excluded: ['good']
        },
        user_id: targetUserId.toString()
      });
    } catch (error) {
      console.error('Failed to fetch businesses:', error);
      res.status(500).json({ error: 'Failed to fetch businesses' });
    }
  }

  static async create(req, res) {
    try {
      const { business_name, business_purpose, description, city, country } = req.body;

      if (!business_name || !business_purpose) {
        return res.status(400).json({ error: 'Business name and purpose required' });
      }

      if (city && city.trim().length > 0 && city.trim().length < 2) {
        return res.status(400).json({ error: 'City must be at least 2 characters long' });
      }

      if (country && country.trim().length > 0 && country.trim().length < 2) {
        return res.status(400).json({ error: 'Country must be at least 2 characters long' });
      }

      const existingCount = await BusinessModel.countByUserId(req.user._id);
      if (existingCount >= MAX_BUSINESSES_PER_USER) {
        return res.status(400).json({ error: 'Maximum 5 businesses allowed' });
      }

      const existingBusinesses = await BusinessModel.findByUserId(req.user._id);
      const duplicateName = existingBusinesses.some(
        business => business.business_name.toLowerCase() === business_name.trim().toLowerCase()
      );
      
      if (duplicateName) {
        return res.status(400).json({ error: 'A business with this name already exists' });
      }

      const businessData = {
        user_id: new ObjectId(req.user._id),
        business_name: business_name.trim(),
        business_purpose: business_purpose.trim(),
        description: description ? description.trim() : '',
        city: city ? city.trim() : '',
        country: country ? country.trim() : ''
      };

      const businessId = await BusinessModel.create(businessData);

      await logAuditEvent(req.user._id, 'business_created', {
        business_id: businessId,
        business_name: business_name.trim(),
        business_purpose: business_purpose.trim(),
        description: description ? description.trim() : '',
        location: {
          city: city ? city.trim() : '',
          country: country ? country.trim() : ''
        },
        has_location: !!(city || country)
      });

      res.json({
        message: 'Business created successfully',
        business_id: businessId,
        business: {
          _id: businessId,
          ...businessData,
          created_at: new Date()
        }
      });
    } catch (error) {
      console.error('Failed to create business:', error);
      res.status(500).json({ error: 'Failed to create business' });
    }
  }

  static async delete(req, res) {
    try {
      const businessId = new ObjectId(req.params.id);
      const userId = new ObjectId(req.user._id);

      const business = await BusinessModel.findById(businessId, userId);
      if (!business) {
        return res.status(404).json({ error: 'Business not found' });
      }

      const conversationCount = await ConversationModel.countDocuments({
        user_id: userId,
        business_id: businessId
      });

      const deleteResult = await BusinessModel.delete(businessId, userId);
      if (deleteResult.deletedCount === 0) {
        return res.status(404).json({ error: 'Business not found' });
      }

      await ConversationModel.deleteMany({
        user_id: userId,
        business_id: businessId
      });

      await logAuditEvent(req.user._id, 'business_deleted', {
        business_id: businessId,
        business_name: business.business_name,
        business_purpose: business.business_purpose,
        conversations_deleted: conversationCount,
        deleted_at: new Date()
      });

      res.json({ message: 'Business and conversations deleted successfully' });
    } catch (error) {
      console.error('Delete business error:', error);
      res.status(500).json({ error: 'Failed to delete business' });
    }
  }
}

module.exports = BusinessController;