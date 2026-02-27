const { ObjectId } = require('mongodb');
const QuestionModel = require('../models/questionModel');
const ConversationModel = require('../models/conversationModel');
const BusinessModel = require('../models/businessModel');
const { ALLOWED_PHASES, VALID_PHASES, VALID_SEVERITIES } = require('../config/constants');
const { logAuditEvent } = require('../services/auditService');

class QuestionController {
  static async create(req, res) {
    try {
      const { question_text, phase, severity, order, used_for, objective, required_info } = req.body;

      if (!question_text || !phase || !severity) {
        return res.status(400).json({ error: 'Question text, phase, and severity are required' });
      }

      if (!VALID_SEVERITIES.includes(severity.toLowerCase())) {
        return res.status(400).json({
          error: `Severity must be one of: ${VALID_SEVERITIES.join(', ')}`
        });
      }

      if (order !== undefined && (!Number.isInteger(order) || order < 1)) {
        return res.status(400).json({ error: 'Order must be a positive integer' });
      }

      const db = require('../config/database').getDB();
      const resolvedOrder = order || 1;

      // Auto-shift: if a question with the same order already exists in this phase, shift up
      const collision = await db.collection('global_questions').findOne({
        is_active: true,
        phase: phase.trim(),
        order: resolvedOrder
      });

      if (collision) {
        await db.collection('global_questions').updateMany(
          { is_active: true, phase: phase.trim(), order: { $gte: resolvedOrder } },
          { $inc: { order: 1 } }
        );
      }

      const questionData = {
        question_text: question_text.trim(),
        phase: phase.trim(),
        severity: severity.toLowerCase(),
        order: resolvedOrder,
        used_for: used_for || '',
        objective: objective || '',
        required_info: required_info || '',
        is_active: true,
        created_at: new Date()
      };

      const insertedId = await QuestionModel.create(questionData);

      res.status(201).json({
        message: 'Question created successfully',
        question: {
          id: insertedId,
          ...questionData
        }
      });

    } catch (error) {
      console.error('Failed to create question:', error);
      res.status(500).json({ error: 'Failed to create question' });
    }
  }

  static async getAll(req, res) {
    try {
      const { phase } = req.query;

      let questionFilter = {
        is_active: true,
        phase: { $in: ALLOWED_PHASES }
      };

      if (phase) {
        if (!ALLOWED_PHASES.includes(phase)) {
          return res.status(400).json({
            error: `Invalid phase. Allowed phases are: ${ALLOWED_PHASES.join(', ')}`
          });
        }
        
        let phaseFilter = phase;
        if (phase === 'advanced') {
          phaseFilter = { $in: ['initial', 'essential', 'advanced'] };
        } else if (phase === 'essential') {
          phaseFilter = { $in: ['initial', 'essential'] };
        }
        questionFilter.phase = phaseFilter;
      }

      const questions = await QuestionModel.findAll(questionFilter);

      res.json({
        questions,
        allowed_phases: ALLOWED_PHASES,
        current_filter: phase || 'all_allowed_phases',
        total_questions: questions.length
      });
    } catch (error) {
      console.error('Failed to fetch questions:', error);
      res.status(500).json({ error: 'Failed to fetch questions' });
    }
  }

  static async checkMissingForAnalysis(req, res) {
    try {
      const { analysis_type, business_id } = req.body;

      if (!analysis_type) {
        return res.status(400).json({ error: 'Analysis type is required' });
      }

      const analysisQuestionMap = {
        'swot': ['swot'],
        'customerSegmentation': ['customerSegmentation'],
        'purchaseCriteria': ['purchaseCriteria'],
        'channelHeatmap': ['channelHeatmap'],
        'loyaltyNPS': ['loyaltyNPS'],
        'capabilityHeatmap': ['capabilityHeatmap'],
        'porters': ['porters'],
        'pestel': ['pestel'],
        'strategic': ['strategic'],
        'fullSwot': ['swot'],
        'competitiveAdvantage': ['competitiveAdvantage'],
        'channelEffectiveness': ['channelEffectiveness'],
        'expandedCapability': ['expandedCapability'],
        'strategicGoals': ['strategicGoals'],
        'strategicRadar': ['strategic'],
        'cultureProfile': ['cultureProfile'],
        'productivityMetrics': ['productivityMetrics'],
        'maturityScore': ['maturityScore']
      };

      const searchTerms = analysisQuestionMap[analysis_type] || [analysis_type];

      let requiredQuestions = [];

      for (const searchTerm of searchTerms) {
        const questions = await QuestionModel.findAll({
          is_active: true,
          used_for: { $regex: new RegExp(`\\b${searchTerm}\\b`, 'i') }
        });
        requiredQuestions = requiredQuestions.concat(questions);
      }

      const uniqueQuestions = requiredQuestions.filter((question, index, self) =>
        index === self.findIndex(q => q._id.toString() === question._id.toString())
      );

      console.log(`Searching for ${analysis_type} with terms:`, searchTerms);
      console.log(`Found ${uniqueQuestions.length} specific questions`);

      let questionsToCheck = uniqueQuestions;
      if (uniqueQuestions.length === 0) {
        if (analysis_type === 'customerSegmentation') {
          questionsToCheck = await QuestionModel.findAll({
            is_active: true,
            $or: [
              { phase: 'essential' },
              { order: { $gte: 8, $lte: 15 } }
            ]
          });
          console.log(`Using essential phase questions: ${questionsToCheck.length} questions`);
        } else {
          questionsToCheck = await QuestionModel.findAll({
            is_active: true,
            order: { $lte: 7 }
          });
          console.log(`Using basic requirements: ${questionsToCheck.length} questions`);
        }
      }

      // Determine which user ID to use for conversations.
      // For business conversations we always store under the business owner,
      // not the collaborator viewing them.
      let ownerIdToUse = new ObjectId(req.user._id);

      if (business_id) {
        const business = await BusinessModel.findById(new ObjectId(business_id));
        if (!business) {
          return res.status(404).json({ error: 'Business not found' });
        }
        ownerIdToUse = new ObjectId(business.user_id);
      }

      const conversationFilter = {
        user_id: ownerIdToUse,
        conversation_type: 'question_answer',
        $or: [
          { 'metadata.is_complete': true },
          { completion_status: 'complete' },
          {
            answer_text: {
              $exists: true,
              $ne: '',
              $ne: '[Question Skipped]'
            }
          }
        ]
      };

      if (business_id) {
        conversationFilter.business_id = new ObjectId(business_id);
      }

      const conversations = await ConversationModel.findByFilter(conversationFilter);

      const answeredQuestionIds = new Set(
        conversations.map(conv => conv.question_id?.toString()).filter(Boolean)
      );

      const missingQuestions = questionsToCheck.filter(q =>
        !answeredQuestionIds.has(q._id.toString())
      );

      const totalRequired = questionsToCheck.length;
      const answered = totalRequired - missingQuestions.length;
      const isComplete = missingQuestions.length === 0;

      res.json({
        analysis_type,
        total_required: totalRequired,
        answered: answered,
        missing_count: missingQuestions.length,
        missing_questions: missingQuestions.map(q => ({
          _id: q._id,
          order: q.order,
          question_text: q.question_text,
          objective: q.objective,
          required_info: q.required_info,
          used_for: q.used_for
        })),
        is_complete: isComplete,
        message: isComplete
          ? `All required questions answered for ${analysis_type}`
          : `Please answer ${missingQuestions.length} more question${missingQuestions.length > 1 ? 's' : ''} to generate ${analysis_type} analysis`,
        search_criteria: searchTerms.join(', '),
        debug_info: {
          search_terms_used: searchTerms,
          questions_found_with_criteria: uniqueQuestions.length,
          fallback_used: uniqueQuestions.length === 0,
          total_answered_questions: answeredQuestionIds.size
        }
      });

    } catch (error) {
      console.error('Error checking missing questions:', error);
      res.status(500).json({ error: 'Failed to check missing questions' });
    }
  }

  static async reorder(req, res) {
    try {
      const { questions, phase } = req.body;

      if (!questions || !Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ error: 'Questions array is required' });
      }

      if (!phase) {
        return res.status(400).json({ error: 'Phase is required for reordering' });
      }

      const validationErrors = [];
      questions.forEach((question, index) => {
        if (!question.question_id || !question.order) {
          validationErrors.push({
            index: index,
            error: 'question_id and order are required for each question'
          });
        }
        if (!Number.isInteger(question.order) || question.order < 1) {
          validationErrors.push({
            index: index,
            error: 'order must be a positive integer'
          });
        }
      });

      if (validationErrors.length > 0) {
        return res.status(400).json({
          error: 'Validation failed',
          validation_errors: validationErrors
        });
      }

      const questionIds = questions.map(q => new ObjectId(q.question_id));
      const existingQuestions = await QuestionModel.findAll({
        _id: { $in: questionIds },
        phase: phase
      });

      if (existingQuestions.length !== questions.length) {
        return res.status(400).json({
          error: 'One or more questions not found or do not belong to the specified phase'
        });
      }

      const phaseOrder = ['initial', 'essential', 'good', 'excellent'];
      const currentPhaseIndex = phaseOrder.indexOf(phase);
      const earlierPhases = phaseOrder.slice(0, currentPhaseIndex);
      let phaseStartOrder = 1;

      if (earlierPhases.length > 0) {
        const earlierPhasesMaxOrder = await QuestionModel.findAll({
          phase: { $in: earlierPhases },
          is_active: true
        });

        if (earlierPhasesMaxOrder.length > 0) {
          const maxOrder = Math.max(...earlierPhasesMaxOrder.map(q => q.order));
          phaseStartOrder = maxOrder + 1;
        }
      }

      const bulkOps = questions.map((question, index) => {
        const newGlobalOrder = phaseStartOrder + index;
        return {
          updateOne: {
            filter: { _id: new ObjectId(question.question_id) },
            update: {
              $set: {
                order: newGlobalOrder,
                updated_at: new Date()
              }
            }
          }
        };
      });

      const result = await QuestionModel.bulkWrite(bulkOps);

      const updatedQuestions = await QuestionModel.findAll({
        phase: phase,
        is_active: true
      });

      res.json({
        message: 'Questions reordered successfully',
        modified_count: result.modifiedCount,
        matched_count: result.matchedCount,
        phase: phase,
        updated_questions: updatedQuestions.map(q => ({
          question_id: q._id,
          question_text: q.question_text,
          phase: q.phase,
          order: q.order
        }))
      });

    } catch (error) {
      console.error('Failed to reorder questions:', error);
      res.status(500).json({ error: 'Failed to reorder questions' });
    }
  }

  static async delete(req, res) {
    try {
      const questionId = req.params.id;

      if (!ObjectId.isValid(questionId)) {
        return res.status(400).json({ error: 'Invalid question ID' });
      }

      const question = await QuestionModel.findById(questionId);
      if (!question) {
        return res.status(404).json({ error: 'Question not found' });
      }

      // Soft-delete: mark inactive so existing conversation snapshots are preserved
      const conversationCount = await ConversationModel.countDocuments({
        question_id: new ObjectId(questionId)
      });

      const result = await QuestionModel.update(questionId, { is_active: false });

      if (result.matchedCount === 0) {
        return res.status(500).json({ error: 'Failed to delete question' });
      }

      res.json({
        message: 'Question deleted successfully',
        soft_deleted: true,
        had_conversations: conversationCount > 0,
        deleted_question: {
          id: questionId,
          question_text: question.question_text,
          phase: question.phase
        }
      });

    } catch (error) {
      console.error('Failed to delete question:', error);
      res.status(500).json({ error: 'Failed to delete question' });
    }
  }

  static async update(req, res) {
    try {
      const questionId = req.params.id;
      const { question_text, phase, severity, order, is_active, used_for, objective, required_info } = req.body;

      if (!ObjectId.isValid(questionId)) {
        return res.status(400).json({ error: 'Invalid question ID' });
      }

      if (!question_text || !phase || !severity) {
        return res.status(400).json({ error: 'Question text, phase, and severity are required' });
      }

      if (!VALID_SEVERITIES.includes(severity.toLowerCase())) {
        return res.status(400).json({
          error: `Severity must be one of: ${VALID_SEVERITIES.join(', ')}`
        });
      }

      if (order !== undefined && (!Number.isInteger(order) || order < 1)) {
        return res.status(400).json({ error: 'Order must be a positive integer' });
      }

      const existingQuestion = await QuestionModel.findById(questionId);
      if (!existingQuestion) {
        return res.status(404).json({ error: 'Question not found' });
      }

      const updateData = {
        question_text: question_text.trim(),
        phase: phase.trim(),
        severity: severity.toLowerCase(),
        used_for: used_for || '',
        objective: objective || '',
        required_info: required_info || ''
      };

      if (order !== undefined) {
        updateData.order = order;
      }

      if (is_active !== undefined) {
        updateData.is_active = Boolean(is_active);
      }

      const result = await QuestionModel.update(questionId, updateData);

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: 'Question not found' });
      }

      if (result.modifiedCount === 0) {
        return res.status(200).json({
          message: 'No changes were made to the question',
          question_id: questionId
        });
      }

      const updatedQuestion = await QuestionModel.findById(questionId);

      res.json({
        message: 'Question updated successfully',
        question: {
          id: updatedQuestion._id,
          question_text: updatedQuestion.question_text,
          phase: updatedQuestion.phase,
          severity: updatedQuestion.severity,
          order: updatedQuestion.order,
          used_for: updatedQuestion.used_for,
          objective: updatedQuestion.objective,
          required_info: updatedQuestion.required_info,
          is_active: updatedQuestion.is_active,
          updated_at: updatedQuestion.updated_at
        }
      });

    } catch (error) {
      console.error('Failed to update question:', error);
      res.status(500).json({ error: 'Failed to update question' });
    }
  }

  static async bulkCreateOrUpdate(req, res) {
    try {
      const { questions } = req.body;

      if (!questions || !Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({
          error: 'Questions array is required and must contain at least one question'
        });
      }

      if (questions.length > 1000) {
        return res.status(400).json({
          error: 'Maximum 1000 questions allowed per bulk upload'
        });
      }

      const validationErrors = [];
      questions.forEach((question, index) => {
        if (!question.question_text || !question.phase || !question.severity || !question.order) {
          validationErrors.push({
            index: index,
            order: question.order,
            error: 'question_text, phase, severity, and order are required'
          });
        }

        if (!Number.isInteger(question.order) || question.order < 1) {
          validationErrors.push({
            index: index,
            order: question.order,
            error: 'order must be a positive integer'
          });
        }

        if (!VALID_PHASES.includes(question.phase)) {
          validationErrors.push({
            index: index,
            order: question.order,
            error: `phase must be one of: ${VALID_PHASES.join(', ')}`
          });
        }

        if (!VALID_SEVERITIES.includes(question.severity)) {
          validationErrors.push({
            index: index,
            order: question.order,
            error: `severity must be one of: ${VALID_SEVERITIES.join(', ')}`
          });
        }
      });

      if (validationErrors.length > 0) {
        return res.status(400).json({
          error: 'Validation failed',
          validation_errors: validationErrors
        });
      }

      const orderCounts = {};
      questions.forEach(q => {
        orderCounts[q.order] = (orderCounts[q.order] || 0) + 1;
      });

      const duplicateOrders = Object.entries(orderCounts)
        .filter(([order, count]) => count > 1)
        .map(([order, count]) => ({ order: parseInt(order), count }));

      if (duplicateOrders.length > 0) {
        return res.status(400).json({
          error: 'Duplicate orders found in payload',
          duplicate_orders: duplicateOrders
        });
      }

      const existingQuestions = await QuestionModel.findAll({ is_active: true });

      console.log(`Found ${existingQuestions.length} existing questions in database`);

      const bulkOps = [];
      let matchedCount = 0;
      let newQuestionsCount = 0;
      let insertedQuestions = [];

      questions.forEach((newQuestion) => {
        const existingQuestion = existingQuestions.find(eq => eq.order === newQuestion.order);

        if (existingQuestion) {
          matchedCount++;
          bulkOps.push({
            updateOne: {
              filter: { _id: existingQuestion._id },
              update: {
                $set: {
                  question_text: newQuestion.question_text.trim(),
                  phase: newQuestion.phase.trim(),
                  severity: newQuestion.severity.toLowerCase(),
                  used_for: newQuestion.used_for || '',
                  objective: newQuestion.objective || '',
                  required_info: newQuestion.required_info || '',
                  updated_at: new Date()
                }
              }
            }
          });
        } else {
          newQuestionsCount++;
          const newQuestionDoc = {
            question_text: newQuestion.question_text.trim(),
            phase: newQuestion.phase.trim(),
            severity: newQuestion.severity.toLowerCase(),
            order: newQuestion.order,
            used_for: newQuestion.used_for || '',
            objective: newQuestion.objective || '',
            required_info: newQuestion.required_info || '',
            is_active: true,
            created_at: new Date()
          };

          bulkOps.push({
            insertOne: {
              document: newQuestionDoc
            }
          });

          insertedQuestions.push({
            order: newQuestion.order,
            question_text: newQuestion.question_text,
            phase: newQuestion.phase
          });
        }
      });

      let modifiedCount = 0;
      let insertedCount = 0;
      let result = null;

      if (bulkOps.length > 0) {
        result = await QuestionModel.bulkWrite(bulkOps);
        modifiedCount = result.modifiedCount || 0;
        insertedCount = result.insertedCount || 0;

        console.log(`Bulk operation completed: ${modifiedCount} updated, ${insertedCount} inserted`);
      }

      const finalQuestionCount = await QuestionModel.countDocuments({ is_active: true });

      await logAuditEvent(req.user._id, 'bulk_questions_operation', {
        operation_type: 'bulk_update_insert',
        total_processed: questions.length,
        questions_updated: modifiedCount,
        questions_inserted: insertedCount,
        existing_questions_before: existingQuestions.length,
        total_questions_after: finalQuestionCount,
        new_questions_added: insertedQuestions,
        timestamp: new Date().toISOString()
      });

      res.json({
        message: 'Questions processed successfully',
        operation: 'bulk_update_insert',
        summary: {
          total_processed: questions.length,
          existing_questions_updated: modifiedCount,
          new_questions_inserted: insertedCount,
          questions_before_operation: existingQuestions.length,
          questions_after_operation: finalQuestionCount,
          questions_added: newQuestionsCount
        },
        details: {
          matched_and_updated: matchedCount,
          new_questions_added: newQuestionsCount,
          successfully_updated: modifiedCount,
          successfully_inserted: insertedCount
        },
        new_questions_added: insertedQuestions,
        database_stats: {
          questions_before: existingQuestions.length,
          questions_after: finalQuestionCount,
          net_increase: finalQuestionCount - existingQuestions.length
        },
        bulk_operation_result: result ? {
          acknowledged: result.acknowledged,
          inserted_count: result.insertedCount,
          matched_count: result.matchedCount,
          modified_count: result.modifiedCount,
          upserted_count: result.upsertedCount
        } : null
      });

    } catch (error) {
      console.error('Bulk questions operation failed:', error);

      await logAuditEvent(req.user._id, 'bulk_questions_error', {
        error_message: error.message,
        operation_type: 'bulk_update_insert',
        timestamp: new Date().toISOString()
      });

      res.status(500).json({
        error: 'Failed to process questions',
        details: error.message
      });
    }
  }
}

module.exports = QuestionController;