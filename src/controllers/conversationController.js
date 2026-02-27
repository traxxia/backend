const { ObjectId } = require("mongodb");
const ConversationModel = require("../models/conversationModel");
const BusinessModel = require("../models/businessModel");
const QuestionModel = require("../models/questionModel");
const UserModel = require("../models/userModel");
const { logAuditEvent } = require("../services/auditService");



/**
 * Helper: Validate business + determine owner + access rights
 */
async function getBusinessAndValidateAccess(business_id, currentUser) {
  const business = await BusinessModel.findById(new ObjectId(business_id));
  if (!business) return { error: "Business not found" };

  const isOwner = business.user_id.toString() === currentUser._id.toString();

  const isCollaborator = (business.collaborators || []).some(
    (id) => id.toString() === currentUser._id.toString()
  );

  const isAdmin = ["super_admin", "company_admin"].includes(
    currentUser.role?.role_name
  );

  const isViewer = currentUser.role?.role_name === "viewer";

  console.log({
    userId: currentUser._id,
    role: currentUser.role?.role_name,
    company: currentUser.company_id,
    isOwner,
    isCollaborator,
    isAdmin,
    isViewer
  });

  if (isAdmin && currentUser.company_id) {
    const owner = await UserModel.findById(business.user_id);
    if (
      owner?.company_id?.toString() !== currentUser.company_id.toString()
    ) {
      return { error: "Business not in your company" }
    }
  }

  if (!isOwner && !isCollaborator && !isAdmin && !isViewer) {
    return { error: "Not allowed to access conversations for this business" };
  }

  return {
    business,
    ownerId: business.user_id,
    access: {
      isOwner,
      isCollaborator,
      isAdmin,
      canWrite: isOwner || isCollaborator || isAdmin,
    }

  };
}

class ConversationController {
  static async getAll(req, res) {
    try {
      const { phase, business_id, user_id } = req.query;

      let requestedUserId;

      if (user_id) {
        if (
          !["super_admin", "company_admin"].includes(req.user.role.role_name)
        ) {
          return res
            .status(403)
            .json({ error: "Admin access required to view other users data" });
        }

        const targetUser = await UserModel.findById(user_id);
        if (!targetUser)
          return res.status(404).json({ error: "User not found" });

        if (
          req.user.role.role_name === "company_admin" &&
          (!targetUser.company_id ||
            targetUser.company_id.toString() !== req.user.company_id.toString())
        ) {
          return res
            .status(403)
            .json({ error: "User not part of your company" });
        }

        requestedUserId = new ObjectId(user_id);
      } else {
        requestedUserId = new ObjectId(req.user._id);
      }
      if (business_id && user_id) {
        return res.status(400).json({
          error:
            "Cannot combine business_id and user_id. Business conversations always belong to the business owner.",
        });
      }
      let businessInfo = null;
      let documentInfo = null;
      let ownerIdToUse = requestedUserId;

      //BUSINESS VALIDATION
      if (business_id) {
        const access = await getBusinessAndValidateAccess(
          business_id,
          req.user
        );

        if (access.error) return res.status(403).json({ error: access.error });

        const business = access.business;
        ownerIdToUse = new ObjectId(access.ownerId);

        // business info
        businessInfo = {
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

        // document info
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
            template_type:
              business.financial_document.template_type || "unknown",
            template_name:
              business.financial_document.template_name || "Unknown",
            validation_confidence:
              business.financial_document.validation_confidence || "medium",
            upload_mode: business.financial_document.upload_mode || "manual",
            blob_url: business.financial_document.blob_url || null,
            storage_type: business.financial_document.blob_url
              ? "blob"
              : "filesystem",
            file_content_base64: null,
            file_content_available: false,
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
          };
        }
      }

      // FETCH OWNER CONVERSATIONS
      const conversations = await ConversationModel.findByFilter({
        user_id: ownerIdToUse,
        business_id: business_id ? new ObjectId(business_id) : null,
        conversation_type: "question_answer",
      });

      //PHASE ANALYSIS
      const phaseAnalysis = await ConversationModel.findByFilter({
        user_id: ownerIdToUse,
        business_id: business_id ? new ObjectId(business_id) : null,
        conversation_type: "phase_analysis",
        ...(phase && { "metadata.phase": phase }),
      });

      // BUILD QUESTION LIST
      // We want to show:
      // 1. ALL active questions for the requested phase(s) - cumulative approach
      // 2. Any questions the user has previously interacted with (even if inactive/soft-deleted)
      
      const questionIdMap = new Map(); // question_id string -> question doc
      const db = require('../config/database').getDB();

      // Determine cumulative phases
      let phaseFilter = phase;
      if (phase === 'advanced') {
        phaseFilter = { $in: ['initial', 'essential', 'advanced'] };
      } else if (phase === 'essential') {
        phaseFilter = { $in: ['initial', 'essential'] };
      }

      // Fetch ALL active questions for the cumulative phases
      const activeQuestions = await db.collection('global_questions')
        .find({
          is_active: true,
          ...(phaseFilter ? { phase: phaseFilter } : {})
        })
        .sort({ order: 1 })
        .toArray();

      // Populate map with active questions
      for (const q of activeQuestions) {
        questionIdMap.set(q._id.toString(), q);
      }

      // Identify question IDs from existing conversations that aren't in the active list
      const conversationQuestionIds = conversations
        .map(conv => conv.question_id?.toString())
        .filter(qid => qid && !questionIdMap.has(qid));

      if (conversationQuestionIds.length > 0) {
        // Fetch these additional interacted questions (might be inactive or from other phases)
        const interactedQuestions = await db.collection('global_questions')
          .find({
            _id: { $in: Array.from(new Set(conversationQuestionIds)).map(id => new ObjectId(id)) }
          })
          .toArray();

        for (const q of interactedQuestions) {
          questionIdMap.set(q._id.toString(), q);
        }
      }


      //BUILD QUESTION RESPONSE
      const result = Array.from(questionIdMap.entries())
        .map(([qidStr, question]) => {
          const questionConvs = conversations.filter(
            (c) =>
              c.question_id &&
              c.question_id.toString() === qidStr
          );

          // Resolve question text: from doc, or fall back to snapshot stored in conv
          const resolvedQuestionText =
            question?.question_text ||
            questionConvs.find(c => c.question_text_snapshot)?.question_text_snapshot ||
            '(Question removed)';

          const resolvedPhase = question?.phase || questionConvs[0]?.question_phase_snapshot || 'unknown';
          const resolvedOrder = question?.order ?? Infinity;

          const allEntries = questionConvs.sort(
            (a, b) => new Date(a.created_at) - new Date(b.created_at)
          );

          const userAnswers = allEntries.filter(
            (entry) =>
              entry.message_type === "user" &&
              entry.answer_text &&
              entry.answer_text.trim() !== ""
          );

          const realAnswers = userAnswers.filter(
            (e) => e.answer_text !== "[Question Skipped]"
          );

          const skippedAnswers = userAnswers.filter(
            (e) => e.answer_text === "[Question Skipped]"
          );

          const hasRealAnswer = realAnswers.length > 0;

          const latestUserAnswer = hasRealAnswer
            ? realAnswers[realAnswers.length - 1]
            : skippedAnswers.length > 0
              ? skippedAnswers[skippedAnswers.length - 1]
              : null;

          const isSkipped = !hasRealAnswer && skippedAnswers.length > 0;

          const conversationFlow = [];

          allEntries.forEach((entry) => {
            if (entry.message_type === "bot" && entry.message_text) {
              conversationFlow.push({
                type: "question",
                text: entry.message_text,
                timestamp: entry.created_at,
                is_followup: entry.is_followup || false,
              });
            } else if (entry.message_type === "user" && entry.answer_text) {
              conversationFlow.push({
                type: "answer",
                text: entry.answer_text,
                timestamp: entry.created_at,
                is_latest: latestUserAnswer && entry._id.toString() === latestUserAnswer._id.toString(),
                is_followup: entry.is_followup || false,
                is_edited: entry.metadata?.is_edit === true,
              });
            }
          });

          conversationFlow.sort(
            (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
          );

          let status = "incomplete";
          if (isSkipped) {
            status = "skipped";
          } else if (latestUserAnswer?.metadata?.is_complete) {
            status = "complete";
          } else if (hasRealAnswer) {
            status = "complete";
          }

          return {
            question_id: question?._id || qidStr,
            question_text: resolvedQuestionText,
            phase: resolvedPhase,
            order: resolvedOrder,
            is_deleted: !question?.is_active && question !== null ? true : (question === null),
            conversation_flow: conversationFlow,
            total_interactions: conversationFlow.length,
            total_answers: conversationFlow.filter((i) => i.type === "answer")
              .length,
            completion_status: status,
            is_skipped: isSkipped,
            last_updated: latestUserAnswer
              ? latestUserAnswer.created_at
              : allEntries.length > 0
                ? allEntries[allEntries.length - 1].created_at
                : null,
            latest_answer: latestUserAnswer?.answer_text || null,
            is_edited: latestUserAnswer?.metadata?.is_edit === true,
          };
        })
        .sort((a, b) => a.order - b.order);

      const analysisResultsByPhase = {};

      phaseAnalysis.forEach((analysis) => {
        const p = analysis.metadata?.phase || "initial";
        const t = analysis.metadata?.analysis_type || "unknown";

        if (!analysisResultsByPhase[p]) {
          analysisResultsByPhase[p] = { phase: p, analyses: [] };
        }

        const existing = analysisResultsByPhase[p].analyses.findIndex(
          (a) => a.analysis_type === t
        );

        const analysisData = {
          analysis_type: t,
          analysis_name: analysis.message_text || `${t.toUpperCase()} Analysis`,
          analysis_data: analysis.analysis_result,
          created_at: analysis.created_at,
          phase: p,
        };

        if (existing >= 0) {
          if (
            new Date(analysis.created_at) >
            new Date(analysisResultsByPhase[p].analyses[existing].created_at)
          ) {
            analysisResultsByPhase[p].analyses[existing] = analysisData;
          }
        } else {
          analysisResultsByPhase[p].analyses.push(analysisData);
        }
      });

      res.json({
        conversations: result,
        phase_analysis: analysisResultsByPhase,
        total_questions: result.length,
        completed: result.filter((r) => r.completion_status === "complete")
          .length,
        skipped: result.filter((r) => r.completion_status === "skipped").length,
        phase: phase || "all",
        user_id: ownerIdToUse.toString(),
        business_info: businessInfo,
        document_info: documentInfo,
      });
    } catch (error) {
      console.error("Failed to fetch conversations:", error);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  }

  static async create(req, res) {
    try {
      const {
        business_id,
        question_id,
        message_text,
        answer_text,
        is_complete = false,
        metadata = {},
      } = req.body;

      if (!business_id) {
        return res.status(400).json({ error: "business_id is required" });
      }

      const access = await getBusinessAndValidateAccess(
        business_id,
        req.user
      );
      if (access.error) return res.status(403).json({ error: access.error });

      const ownerId = new ObjectId(access.ownerId);

      const isUserMessage = !!answer_text;
      const isBotMessage = !!message_text && !answer_text;

      if (!isUserMessage && !isBotMessage && !question_id) {
        return res.status(400).json({
          error:
            "Invalid payload: must include question_id + answer_text (user) or message_text (bot)",
        });
      }

      // === EDIT FROM BRIEF MODE ===
      const isEdit =
        metadata?.from_editable_brief === true || metadata?.is_edit === true;

      if (isEdit) {
        if (!question_id || !answer_text) {
          return res
            .status(400)
            .json({ error: "question_id and answer_text required for edit" });
        }

        // Clean up all previous entries for this question
        const cleanupFilter = {
          user_id: ownerId,
          business_id: new ObjectId(business_id),
          question_id: new ObjectId(question_id),
          conversation_type: "question_answer",
        };

        const deleted = await ConversationModel.deleteMany(cleanupFilter);
        console.log(
          `🧽 Edit cleanup: removed ${deleted.deletedCount} entries for question ${question_id}`
        );

        // Create new clean edited answer
        const editedPayload = {
          user_id: ownerId,
          business_id: new ObjectId(business_id),
          question_id: new ObjectId(question_id),
          conversation_type: "question_answer",
          message_type: "user",
          message_text: "",
          answer_text: answer_text.trim(),
          is_followup: false,
          metadata: {
            ...metadata,
            is_complete: true,
            is_edit: true,
            from_editable_brief: true,
            last_edited: new Date(),
          },
          created_at: new Date(),
          updated_at: new Date(),
        };

        const inserted = await ConversationModel.create(editedPayload);

        // Audit log
        await logAuditEvent(
          req.user._id,
          "question_edited",
          {
            question_id,
            answer_preview: answer_text,
            deleted_count: deleted.deletedCount,
            business_id,
          },
          business_id
        );

        return res.json({
          message: "Answer edited successfully — previous history cleared",
          conversation_id: inserted._id || inserted,
          action: "edited_and_replaced",
          is_complete: true,
          is_edit: true,
        });
      }

      // === NORMAL MODE (New Answer or Bot Message) ===
      // Fetch question text snapshot to persist even if question is later soft-deleted
      let question_text_snapshot = null;
      let question_phase_snapshot = null;
      if (question_id) {
        try {
          const qDoc = await QuestionModel.findById(question_id);
          question_text_snapshot = qDoc?.question_text || null;
          question_phase_snapshot = qDoc?.phase || null;
        } catch (_) { /* non-fatal */ }
      }

      const payload = {
        user_id: ownerId,
        business_id: new ObjectId(business_id),
        question_id: question_id ? new ObjectId(question_id) : null,
        conversation_type: "question_answer",
        message_type: isUserMessage ? "user" : "bot",
        message_text: message_text || null,
        answer_text: answer_text || null,
        is_followup: isBotMessage && metadata.is_followup === true,
        question_text_snapshot,
        question_phase_snapshot,
        metadata: {
          ...metadata,
          is_complete: isUserMessage ? is_complete : false,
        },
        created_at: new Date(),
      };

      const result = await ConversationModel.create(payload);

      // Audit logging for regular answers
      if (isUserMessage) {
        const eventType =
          answer_text === "[Question Skipped]"
            ? "question_skipped"
            : "question_answered";
        await logAuditEvent(
          req.user._id,
          eventType,
          {
            question_id,
            answer_preview: answer_text,
            is_complete,
            business_id,
          },
          business_id
        );
      }

      res.status(201).json({
        message: "Conversation entry added",
        conversation: result,
        action: "created",
      });
    } catch (error) {
      console.error("Conversation create error:", error);
      res.status(500).json({ error: "Failed to save conversation" });
    }
  }

  static async bulkCreate(req, res) {
    try {
      const { business_id, answers } = req.body;

      if (!business_id || !answers || !Array.isArray(answers)) {
        return res.status(400).json({ error: "business_id and answers array are required" });
      }

      const access = await getBusinessAndValidateAccess(business_id, req.user);
      if (access.error) return res.status(403).json({ error: access.error });

      const ownerId = new ObjectId(access.ownerId);
      const businessObjectId = new ObjectId(business_id);
      const now = new Date();

      const results = [];
      for (const answer of answers) {
        const { question_id, answer_text } = answer;

        if (!question_id || !answer_text) continue;

        const questionObjectId = new ObjectId(question_id);

        // Clean up previous entries for this question
        await ConversationModel.deleteMany({
          user_id: ownerId,
          business_id: businessObjectId,
          question_id: questionObjectId,
          conversation_type: "question_answer",
        });

        // Insert new clean answer
        const payload = {
          user_id: ownerId,
          business_id: businessObjectId,
          question_id: questionObjectId,
          conversation_type: "question_answer",
          message_type: "user",
          message_text: "",
          answer_text: answer_text.trim(),
          is_followup: false,
          metadata: {
            from_editable_brief: true,
            is_complete: true,
            is_edit: true,
            is_enriched: true,
            last_edited: now,
          },
          created_at: now,
          updated_at: now,
        };

        const result = await ConversationModel.create(payload);
        results.push(result);
      }

      // Audit log for the bulk operation
      await logAuditEvent(
        req.user._id,
        "questions_bulk_enriched",
        {
          business_id,
          answers_count: results.length,
        },
        business_id
      );

      res.status(201).json({
        message: `${results.length} answers enriched and saved successfully`,
        count: results.length,
      });
    } catch (error) {
      console.error("Conversation bulkCreate error:", error);
      res.status(500).json({ error: "Failed to save enriched conversations" });
    }
  }

  static async skip(req, res) {
    try {
      const { business_id, question_id } = req.body;

      const access = await getBusinessAndValidateAccess(
        business_id,
        req.user
      );
      if (access.error) return res.status(403).json({ error: access.error });

      if (!question_id) {
        return res.status(400).json({ error: "question_id is required" });
      }

      const ownerId = new ObjectId(access.ownerId);

      const payload = {
        user_id: ownerId,
        business_id: new ObjectId(business_id),
        question_id: new ObjectId(question_id),
        answer_text: "[Question Skipped]",
        message_type: "user",
        conversation_type: "question_answer",
        metadata: {
          is_complete: true,
          is_skipped: true,
        },
        created_at: new Date(),
      };

      const result = await ConversationModel.create(payload);

      await logAuditEvent(
        req.user._id,
        "question_skipped",
        { question_id, business_id },
        business_id
      );

      res.json({
        message: "Question skipped",
        conversation: result,
      });
    } catch (error) {
      console.error("Skip error:", error);
      res.status(500).json({ error: "Failed to skip question" });
    }
  }

  static async saveFollowupQuestion(req, res) {
    try {
      const { business_id, question_id, message_text, followup_question_text } = req.body;
      const textToUse = message_text || followup_question_text;

      const access = await getBusinessAndValidateAccess(
        business_id,
        req.user
      );
      if (access.error) return res.status(403).json({ error: access.error });

      if (!question_id) {
        return res.status(400).json({ error: "question_id is required" });
      }

      if (!textToUse) {
        return res.status(400).json({ error: "message_text (or followup_question_text) is required" });
      }

      const ownerId = new ObjectId(access.ownerId);

      const payload = {
        user_id: ownerId,
        business_id: new ObjectId(business_id),
        question_id: new ObjectId(question_id),
        message_text: textToUse,
        message_type: "bot",
        is_followup: true,
        conversation_type: "question_answer",
        created_at: new Date(),
      };

      const result = await ConversationModel.create(payload);

      res.json({
        message: "Follow-up saved",
        conversation: result,
      });
    } catch (error) {
      console.error("Follow-up error:", error);
      res.status(500).json({ error: "Failed to save follow-up" });
    }
  }

  static async savePhaseAnalysis(req, res) {
    try {
      const {
        business_id,
        phase,
        analysis_type,
        analysis_name,
        analysis_data,
        metadata = {},
      } = req.body;

      // Validation
      if (
        !business_id ||
        !phase ||
        !analysis_type ||
        !analysis_name ||
        !analysis_data
      ) {
        return res.status(400).json({
          error:
            "business_id, phase, analysis_type, analysis_name, and analysis_data are required",
        });
      }

      // Access control
      const access = await getBusinessAndValidateAccess(
        business_id,
        req.user
      );
      if (access.error) return res.status(403).json({ error: access.error });

      const ownerId = new ObjectId(access.ownerId);

      // Unique filter
      const filter = {
        user_id: ownerId,
        business_id: new ObjectId(business_id),
        conversation_type: "phase_analysis",
        "metadata.phase": phase,
        "metadata.analysis_type": analysis_type,
      };

      const fullDocument = {
        user_id: ownerId,
        business_id: new ObjectId(business_id),
        conversation_type: "phase_analysis",
        message_type: "system",
        message_text: analysis_name,
        analysis_result: analysis_data,
        metadata: {
          phase,
          analysis_type,
          generated_at: new Date().toISOString(),
          ...metadata,
        },
        created_at: new Date(),
        updated_at: new Date(),
      };

      const result = await ConversationModel.replaceOne(filter, fullDocument, {
        upsert: true,
      });

      // Audit logging
      await logAuditEvent(
        req.user._id,
        "analysis_generated",
        {
          phase,
          analysis_type,
          analysis_name,
          business_id,
          was_update: result.modifiedCount > 0 || result.matchedCount > 0,
          was_insert: !!result.upsertedId,
          data_keys: Object.keys(analysis_data || {}),
        },
        business_id
      );

      res.json({
        message: "Phase analysis saved successfully",
        upserted: !!result.upsertedId,
        modified: result.modifiedCount > 0,
        matched: result.matchedCount > 0,
      });
    } catch (error) {
      console.error("Phase analysis save error:", error);
      res.status(500).json({ error: "Failed to save phase analysis" });
    }
  }

  static async getPhaseAnalysis(req, res) {
    try {
      const { phase, business_id, analysis_type } = req.query;

      if (!business_id) {
        return res.status(400).json({ error: "business_id is required" });
      }

      const access = await getBusinessAndValidateAccess(
        business_id,
        req.user
      );
      if (access.error) {
        return res.status(403).json({ error: access.error });
      }

      const ownerId = new ObjectId(access.ownerId);

      const filter = {
        user_id: ownerId,
        business_id: new ObjectId(business_id),
        conversation_type: "phase_analysis",
      };

      if (phase) filter["metadata.phase"] = phase;
      if (analysis_type) filter["metadata.analysis_type"] = analysis_type;

      const analysisResults = await ConversationModel.findByFilter(filter);

      const formattedResults = analysisResults.map((analysis) => ({
        analysis_id: analysis._id,
        phase: analysis.metadata?.phase,
        analysis_type: analysis.metadata?.analysis_type,
        analysis_name:
          analysis.message_text ||
          `${analysis.metadata?.analysis_type || "Unknown"} Analysis`,
        analysis_data: analysis.analysis_result,
        created_at: analysis.created_at,
      }));

      const resultsByPhase = formattedResults.reduce((acc, result) => {
        const p = result.phase || "unknown";
        if (!acc[p]) acc[p] = [];
        acc[p].push(result);
        return acc;
      }, {});

      res.json({
        business_id,
        owner_id: ownerId.toString(),
        total_analyses: formattedResults.length,
        analysis_results: formattedResults,
        results_by_phase: resultsByPhase,
      });
    } catch (error) {
      console.error("Failed to fetch phase analysis:", error);
      res.status(500).json({ error: "Failed to fetch phase analysis" });
    }
  }

  static async deleteAll(req, res) {
    try {
      const { business_id } = req.body;

      const access = await getBusinessAndValidateAccess(
        business_id,
        req.user
      );
      if (access.error) return res.status(403).json({ error: access.error });

      const ownerId = new ObjectId(access.ownerId);

      const deleteResult = await ConversationModel.deleteMany({
        user_id: ownerId,
        business_id: new ObjectId(business_id),
      });

      res.json({
        message: "All conversations deleted",
        deleted: deleteResult.deletedCount,
      });
    } catch (error) {
      console.error("Delete error:", error);
      res.status(500).json({ error: "Failed to delete conversations" });
    }
  }
}

module.exports = ConversationController;
