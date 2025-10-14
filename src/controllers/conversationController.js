const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');
const ConversationModel = require('../models/conversationModel');
const QuestionModel = require('../models/questionModel');
const BusinessModel = require('../models/businessModel');
const UserModel = require('../models/userModel');
const { logAuditEvent } = require('../services/auditService');
const blobService = require('../services/blobService');
const fs = require('fs').promises;

class ConversationController {
  static async getAll(req, res) {
    try {
      const { phase, business_id, user_id } = req.query;

      let targetUserId;

      if (user_id) {
        if (!['super_admin', 'company_admin'].includes(req.user.role.role_name)) {
          return res.status(403).json({ error: 'Admin access required to view other users conversations' });
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

      let questionFilter = { is_active: true };
      if (phase) questionFilter.phase = phase;

      const questions = await QuestionModel.findAll(questionFilter);

      const conversations = await ConversationModel.findByFilter({
        user_id: targetUserId,
        conversation_type: 'question_answer',
        business_id: business_id ? new ObjectId(business_id) : null
      });

      const phaseAnalysis = await ConversationModel.findByFilter({
        user_id: targetUserId,
        conversation_type: 'phase_analysis',
        business_id: business_id ? new ObjectId(business_id) : null,
        ...(phase && { 'metadata.phase': phase })
      });

      let businessInfo = null;
      let documentInfo = null;

      if (business_id) {
        const business = await BusinessModel.findById(business_id, targetUserId);

        if (business) {
          businessInfo = {
            id: business._id,
            name: business.business_name,
            purpose: business.business_purpose,
            location: {
              city: business.city || '',
              country: business.country || '',
              display: [business.city, business.country].filter(Boolean).join(', ')
            },
            upload_decision_made: business.upload_decision_made || false,
            upload_decision: business.upload_decision || null,
            created_at: business.created_at
          };

          if (business.has_financial_document && business.financial_document) {
            let fileExists = false;
            let fileContentBase64 = null;

            if (business.financial_document.blob_url) {
              try {
                fileExists = true;
              } catch (error) {
                console.warn(`Financial document blob access error: ${error.message}`);
              }
            }

            documentInfo = {
              has_document: true,
              file_exists: fileExists,
              filename: business.financial_document.original_name,
              upload_date: business.financial_document.upload_date,
              file_size: business.financial_document.file_size,
              file_type: business.financial_document.file_type,
              is_processed: business.financial_document.is_processed || false,
              uploaded_by: business.financial_document.uploaded_by,
              template_type: business.financial_document.template_type || 'unknown',
              template_name: business.financial_document.template_name || 'Unknown Template',
              validation_confidence: business.financial_document.validation_confidence || 'medium',
              upload_mode: business.financial_document.upload_mode || 'manual',
              blob_url: business.financial_document.blob_url || null,
              storage_type: business.financial_document.blob_url ? 'blob' : 'filesystem',
              file_content_base64: fileContentBase64,
              file_content_available: !!fileContentBase64,
              download_info: {
                can_download: fileExists,
                content_type: business.financial_document.file_type,
                content_disposition: `attachment; filename="${business.financial_document.original_name}"`
              }
            };
          } else {
            documentInfo = {
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
              message: 'No financial document uploaded for this business'
            };
          }
        }
      }

      const result = questions.map(question => {
        const questionConvs = conversations.filter(c =>
          c.question_id && c.question_id.toString() === question._id.toString()
        );

        const allEntries = questionConvs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        const isSkipped = allEntries.some(entry => entry.is_skipped === true);

        const conversationFlow = [];
        allEntries.forEach(entry => {
          if (entry.message_type === 'bot' && entry.message_text) {
            conversationFlow.push({
              type: 'question',
              text: entry.message_text,
              timestamp: entry.created_at,
              is_followup: entry.is_followup || false
            });
          }
          if (entry.answer_text && entry.answer_text.trim() !== '') {
            conversationFlow.push({
              type: 'answer',
              text: entry.answer_text,
              timestamp: entry.created_at,
              is_followup: entry.is_followup || false
            });
          }
        });

        const statusEntries = questionConvs.filter(c => c.metadata && c.metadata.is_complete !== undefined);
        const latestStatusEntry = statusEntries.length > 0
          ? statusEntries.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
          : null;

        let status = 'incomplete';
        if (isSkipped) {
          status = 'skipped';
        } else if (latestStatusEntry?.metadata?.is_complete) {
          status = 'complete';
        }

        const answerCount = conversationFlow.filter(item => item.type === 'answer').length;

        return {
          question_id: question._id,
          question_text: question.question_text,
          phase: question.phase,
          order: question.order,
          conversation_flow: conversationFlow,
          total_interactions: conversationFlow.length,
          total_answers: answerCount,
          completion_status: status,
          is_skipped: isSkipped,
          last_updated: allEntries.length > 0 ? allEntries[allEntries.length - 1].created_at : null
        };
      });

      const analysisResultsByPhase = {};

      phaseAnalysis.forEach(analysis => {
        const analysisPhase = analysis.metadata?.phase || 'initial';
        const analysisType = analysis.metadata?.analysis_type || 'unknown';

        if (!analysisResultsByPhase[analysisPhase]) {
          analysisResultsByPhase[analysisPhase] = {
            phase: analysisPhase,
            analyses: []
          };
        }

        const existingIndex = analysisResultsByPhase[analysisPhase].analyses
          .findIndex(a => a.analysis_type === analysisType);

        const analysisData = {
          analysis_type: analysisType,
          analysis_name: analysis.message_text || `${analysisType.toUpperCase()} Analysis`,
          analysis_data: analysis.analysis_result,
          created_at: analysis.created_at,
          phase: analysisPhase
        };

        if (existingIndex !== -1) {
          if (new Date(analysis.created_at) > new Date(analysisResultsByPhase[analysisPhase].analyses[existingIndex].created_at)) {
            analysisResultsByPhase[analysisPhase].analyses[existingIndex] = analysisData;
          }
        } else {
          analysisResultsByPhase[analysisPhase].analyses.push(analysisData);
        }
      });

      res.json({
        conversations: result,
        phase_analysis: analysisResultsByPhase,
        total_questions: questions.length,
        completed: result.filter(r => r.completion_status === 'complete').length,
        skipped: result.filter(r => r.completion_status === 'skipped').length,
        phase: phase || 'all',
        user_id: targetUserId.toString(),
        business_info: businessInfo,
        document_info: documentInfo,
        metadata: {
          has_business_context: !!businessInfo,
          has_document_uploaded: documentInfo?.has_document || false,
          document_file_exists: documentInfo?.file_exists || false,
          document_content_available: documentInfo?.file_content_available || false,
          document_template_type: documentInfo?.template_type || null,
          document_template_name: documentInfo?.template_name || null,
          document_validation_confidence: documentInfo?.validation_confidence || null,
          document_upload_mode: documentInfo?.upload_mode || null,
          document_storage_type: documentInfo?.storage_type || null,
          is_good_phase_ready: documentInfo?.has_document && documentInfo?.file_exists,
          request_timestamp: new Date().toISOString(),
          file_content_size: documentInfo?.file_content_base64 ?
            Math.round(documentInfo.file_content_base64.length * 0.75) : 0,
          file_content_warning: documentInfo?.file_content_base64 && documentInfo.file_content_base64.length > 1000000 ?
            'Large file content included - consider using download endpoint for better performance' : null
        }
      });

    } catch (error) {
      console.error('Failed to fetch conversations:', error);
      res.status(500).json({ error: 'Failed to fetch conversations' });
    }
  }

  static async create(req, res) {
    try {
      const {
        question_id,
        answer_text,
        is_followup = false,
        business_id,
        is_complete = false,
        is_skipped = false,
        metadata
      } = req.body;

      if (!question_id || (!answer_text && !is_skipped)) {
        return res.status(400).json({ error: 'Question ID and answer text (or skip) required' });
      }

      const question = await QuestionModel.findById(question_id);

      const isEdit = metadata?.from_editable_brief === true;

      if (isEdit && answer_text && answer_text.trim() !== '') {
        const filter = {
          user_id: new ObjectId(req.user._id),
          business_id: business_id ? new ObjectId(business_id) : null,
          question_id: new ObjectId(question_id),
          conversation_type: 'question_answer'
        };

        const updateDoc = {
          user_id: new ObjectId(req.user._id),
          business_id: business_id ? new ObjectId(business_id) : null,
          question_id: new ObjectId(question_id),
          conversation_type: 'question_answer',
          message_type: 'user',
          message_text: '',
          answer_text: answer_text.trim(),
          is_followup: false,
          is_skipped: false,
          analysis_result: null,
          metadata: {
            ...metadata,
            is_complete: true,
            is_edit: true,
            last_edited: new Date()
          },
          attempt_count: 1,
          timestamp: new Date(),
          created_at: new Date(),
          updated_at: new Date()
        };

        const result = await ConversationModel.replaceOne(filter, updateDoc, { upsert: true });

        await logAuditEvent(req.user._id, 'question_edited', {
          question_id,
          question_text: question?.question_text?.substring(0, 100) + '...',
          answer_preview: answer_text.substring(0, 200) + '...',
          operation: result.upsertedId ? 'created' : 'updated',
          upsert_id: result.upsertedId
        }, business_id);

        return res.json({
          message: 'Answer saved successfully',
          conversation_id: result.upsertedId || 'updated',
          is_complete: true,
          action: result.upsertedId ? 'created' : 'updated'
        });
      }

      const conversation = {
        user_id: new ObjectId(req.user._id),
        business_id: business_id ? new ObjectId(business_id) : null,
        question_id: new ObjectId(question_id),
        conversation_type: 'question_answer',
        message_type: 'user',
        message_text: '',
        answer_text: answer_text || '',
        is_followup,
        is_skipped,
        analysis_result: null,
        metadata: {
          ...metadata,
          is_complete,
          is_skipped
        },
        attempt_count: 1
      };

      const conversationId = await ConversationModel.create(conversation);

      const eventType = is_skipped ? 'question_skipped' : 'question_answered';
      await logAuditEvent(req.user._id, eventType, {
        question_id,
        question_text: question?.question_text?.substring(0, 100) + '...',
        answer_preview: answer_text ? answer_text.substring(0, 200) + '...' : 'N/A',
        is_followup
      }, business_id);

      res.json({
        message: is_skipped ? 'Question skipped' : 'Answer saved',
        conversation_id: conversationId,
        is_complete,
        is_skipped,
        action: 'created'
      });
    } catch (error) {
      console.error('Error saving conversation:', error);
      res.status(500).json({ error: 'Failed to save conversation' });
    }
  }

  static async skip(req, res) {
    try {
      const { question_id, business_id, metadata } = req.body;

      if (!question_id) {
        return res.status(400).json({ error: 'Question ID is required' });
      }

      const question = await QuestionModel.findById(question_id);
      if (!question) {
        return res.status(404).json({ error: 'Question not found' });
      }

      const conversation = {
        user_id: new ObjectId(req.user._id),
        business_id: business_id ? new ObjectId(business_id) : null,
        question_id: new ObjectId(question_id),
        conversation_type: 'question_answer',
        message_type: 'user',
        message_text: '',
        answer_text: '[Question Skipped]',
        is_followup: false,
        is_skipped: true,
        analysis_result: null,
        metadata: {
          ...metadata,
          is_complete: true,
          is_skipped: true,
          skip_reason: 'user_skipped'
        },
        attempt_count: 1
      };

      const conversationId = await ConversationModel.create(conversation);

      res.json({
        message: 'Question skipped successfully',
        conversation_id: conversationId,
        is_complete: true,
        is_skipped: true
      });
    } catch (error) {
      console.error('Failed to skip question:', error);
      res.status(500).json({ error: 'Failed to skip question' });
    }
  }

  static async saveFollowupQuestion(req, res) {
    try {
      const { question_id, followup_question_text, business_id, metadata } = req.body;

      if (!question_id || !followup_question_text) {
        return res.status(400).json({ error: 'Question ID and followup question text required' });
      }

      const conversation = {
        user_id: new ObjectId(req.user._id),
        business_id: business_id ? new ObjectId(business_id) : null,
        question_id: new ObjectId(question_id),
        conversation_type: 'question_answer',
        message_type: 'bot',
        message_text: followup_question_text,
        answer_text: null,
        is_followup: true,
        analysis_result: null,
        metadata: metadata || {}
      };

      const conversationId = await ConversationModel.create(conversation);

      res.json({
        message: 'Followup question saved',
        conversation_id: conversationId
      });
    } catch (error) {
      console.error('Failed to save followup question:', error);
      res.status(500).json({ error: 'Failed to save followup question' });
    }
  }

  static async savePhaseAnalysis(req, res) {
    try {
      const { phase, analysis_type, analysis_name, analysis_data, business_id, metadata } = req.body;

      if (!phase || !analysis_type || !analysis_name || !analysis_data) {
        return res.status(400).json({ error: 'Phase, analysis type, name, and data are required' });
      }

      const enhancedMetadata = {
        phase: phase,
        analysis_type: analysis_type,
        generated_at: new Date().toISOString(),
        ...metadata
      };

      const phaseAnalysis = {
        user_id: new ObjectId(req.user._id),
        business_id: business_id ? new ObjectId(business_id) : null,
        question_id: null,
        conversation_type: 'phase_analysis',
        message_type: 'system',
        message_text: analysis_name,
        answer_text: null,
        is_followup: false,
        analysis_result: analysis_data,
        metadata: enhancedMetadata
      };

      const result = await ConversationModel.updateOne(
        {
          user_id: new ObjectId(req.user._id),
          business_id: business_id ? new ObjectId(business_id) : null,
          conversation_type: 'phase_analysis',
          'metadata.phase': phase,
          'metadata.analysis_type': analysis_type
        },
        { $set: phaseAnalysis },
        { upsert: true }
      );

      await logAuditEvent(req.user._id, 'analysis_generated', {
        analysis_type,
        analysis_name,
        phase,
        analysis_result: analysis_data,
        metadata: {
          generated_at: new Date().toISOString(),
          was_update: result.upsertedId ? false : true,
          database_operation: result.upsertedId ? 'insert' : 'update',
          ...enhancedMetadata
        },
        data_size: JSON.stringify(analysis_data).length,
        analysis_summary: {
          data_keys: Object.keys(analysis_data || {}),
          has_data: !!analysis_data,
          data_type: typeof analysis_data
        }
      }, business_id);

      res.json({
        message: 'Phase analysis saved',
        analysis_id: result.insertedId || 'updated',
        analysis_type: analysis_type,
        phase: phase
      });
    } catch (error) {
      console.error('Failed to save phase analysis:', error);
      res.status(500).json({ error: 'Failed to save phase analysis' });
    }
  }

  static async getPhaseAnalysis(req, res) {
    try {
      const { phase, business_id, analysis_type, user_id } = req.query;

      let targetUserId;

      if (user_id) {
        if (!['super_admin', 'company_admin'].includes(req.user.role.role_name)) {
          return res.status(403).json({ error: 'Admin access required to view other users phase analysis' });
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

      let filter = {
        user_id: targetUserId,
        conversation_type: 'phase_analysis'
      };

      if (business_id) filter.business_id = new ObjectId(business_id);
      if (phase) filter['metadata.phase'] = phase;
      if (analysis_type) filter['metadata.analysis_type'] = analysis_type;

      const analysisResults = await ConversationModel.findByFilter(filter);

      const formattedResults = analysisResults.map(analysis => ({
        analysis_id: analysis._id,
        phase: analysis.metadata?.phase,
        analysis_type: analysis.metadata?.analysis_type,
        analysis_name: analysis.message_text,
        analysis_data: analysis.analysis_result,
        created_at: analysis.created_at
      }));

      const resultsByPhase = formattedResults.reduce((acc, result) => {
        const phase = result.phase || 'unknown';
        if (!acc[phase]) {
          acc[phase] = [];
        }
        acc[phase].push(result);
        return acc;
      }, {});

      res.json({
        analysis_results: formattedResults,
        results_by_phase: resultsByPhase,
        total_analyses: formattedResults.length,
        user_id: targetUserId.toString()
      });

    } catch (error) {
      console.error('Failed to fetch phase analysis:', error);
      res.status(500).json({ error: 'Failed to fetch phase analysis' });
    }
  }

  static async deleteAll(req, res) {
    try {
      const { business_id } = req.query;
      let filter = { user_id: new ObjectId(req.user._id) };

      if (business_id) {
        filter.business_id = new ObjectId(business_id);
      }

      const result = await ConversationModel.deleteMany(filter);

      res.json({
        message: 'Conversations cleared',
        deleted_count: result.deletedCount
      });
    } catch (error) {
      console.error('Failed to clear conversations:', error);
      res.status(500).json({ error: 'Failed to clear conversations' });
    }
  }
}

module.exports = ConversationController;