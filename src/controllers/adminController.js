const { ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const { getDB } = require("../config/database");
const CompanyModel = require("../models/companyModel");
const UserModel = require("../models/userModel");
const AuditModel = require("../models/auditModel");
const QuestionModel = require("../models/questionModel");
const BusinessModel = require("../models/businessModel");
const ConversationModel = require("../models/conversationModel");

class AdminController {
  static async getCompanies(req, res) {
    try {
      let matchFilter = {};

      if (req.user.role.role_name === "company_admin") {
        if (!req.user.company_id) {
          return res
            .status(400)
            .json({ error: "No company associated with admin account" });
        }
        matchFilter._id = req.user.company_id;
      }

      const companies = await CompanyModel.findAll(matchFilter);

      const enhancedCompanies = companies.map((company) => ({
        ...company,
        admin_name: company.admin_name || "No Admin Assigned",
        admin_email: company.admin_email || "No Email",
        total_users: company.total_users || 0,
        active_users: company.active_users || 0,
      }));

      res.json({
        companies: enhancedCompanies,
        total_count: enhancedCompanies.length,
        user_role: req.user.role.role_name,
        filtered_by_company: req.user.role.role_name === "company_admin",
      });
    } catch (error) {
      console.error("Error fetching companies:", error);
      res.status(500).json({ error: "Failed to fetch companies" });
    }
  }

  static async createCompany(req, res) {
    try {
      const {
        company_name,
        industry,
        size,
        admin_name,
        admin_email,
        admin_password,
      } = req.body;

      if (!company_name || !admin_name || !admin_email || !admin_password) {
        return res
          .status(400)
          .json({ error: "Company name and admin details required" });
      }

      const existingUser = await UserModel.findByEmail(admin_email);
      if (existingUser) {
        return res.status(400).json({ error: "Admin email already exists" });
      }

      const normalizedCompanyName = company_name.trim().toLowerCase();
      const existingCompany = await CompanyModel.findByName(normalizedCompanyName);
      if(existingCompany){
        return res.status(400).json({ error: "Company with this name already exists"})
      }

      let logoUrl = null;
      if (req.file) {
        logoUrl = `${req.protocol}://${req.get("host")}/uploads/logos/${req.file.filename}`;
      }

      const companyId = await CompanyModel.create({
        company_name,
        company_name_normalized: normalizedCompanyName,
        industry: industry || "",
        size: size || "",
        logo: logoUrl,
      });

      const db = getDB();
      const companyAdminRole = await db
        .collection("roles")
        .findOne({ role_name: "company_admin" });
      const hashedPassword = await bcrypt.hash(admin_password, 12);

      const adminId = await UserModel.create({
        name: admin_name,
        email: admin_email,
        password: admin_password,
        role_id: companyAdminRole._id,
        company_id: companyId,
      });

      res.json({
        message: "Company and admin created successfully",
        company_id: companyId,
        admin_id: adminId,
        logo_url: logoUrl,
      });
    } catch (error) {
      console.error("Error creating company:", error);
      res.status(500).json({ error: "Failed to create company" });
    }
  }

  static async getUsers(req, res) {
    try {
      const { company_id } = req.query;
      let filter = {};

      if (req.user.role.role_name === "company_admin") {
        filter.company_id = req.user.company_id;
      } else if (req.user.role.role_name === "super_admin") {
        if (company_id) {
          try {
            filter.company_id = new ObjectId(company_id);
          } catch (error) {
            return res.status(400).json({ error: "Invalid company ID format" });
          }
        }
      }

      const users = await UserModel.getAll(filter);

      res.json({
        users,
        filter_applied: filter,
        total_count: users.length,
      });
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  }

  static async createUser(req, res) {
    try {
      const { name, email, password, role } = req.body;

      if (!name || !email || !password) {
        return res
          .status(400)
          .json({ error: "Name, email, and password required" });
      }

      const existingUser = await UserModel.findByEmail(email);
      if (existingUser) {
        return res.status(400).json({ error: "Email already exists" });
      }

      let companyId;

      if (req.user.role.role_name === "super_admin") {
        if (!req.body.company_id) {
          return res
            .status(400)
            .json({ error: "company_id is required for creating user" });
        }
        companyId = new ObjectId(req.body.company_id);

        // COMPANY ADMIN can only create inside their own company
      } else if (req.user.role.role_name === "company_admin") {
        companyId = req.user.company_id;
      } else {
        return res.status(403).json({ error: "Only admins can create users" });
      }

      const allowedRoles = ["user", "viewer", "collaborator"];

      if (
        req.user.role.role_name === "company_admin" &&
        role &&
        !allowedRoles.includes(role.toLowerCase())
      ) {
        return res
          .status(403)
          .json({ error: "company_admin cannot assign this role" });
      }

      // If role not provided: default "user"
      const finalRoleName =
        role && allowedRoles.includes(role.toLowerCase())
          ? role.toLowerCase()
          : "user";

      const db = getDB();
      const roleDoc = await db
        .collection("roles")
        .findOne({ role_name: finalRoleName });

      if (!roleDoc) {
        return res
          .status(400)
          .json({ error: `Role '${finalRoleName}' not found` });
      }

      const userId = await UserModel.create({
        name,
        email,
        password,
        role_id: roleDoc._id,
        company_id: companyId,
      });

      res.json({
        message: "User created successfully",
        user_id: userId,
        role_assigned: finalRoleName,
        company_id: companyId,
      });
    } catch (error) {
      console.error("Failed to create user:", error);
      res.status(500).json({ error: "Failed to create user" });
    }
  }


static async updateUserRole(req, res) {
  try {
    
    const { user_id } = req.params;
    const { role } = req.body;


    if (!ObjectId.isValid(user_id)) {
      return res.status(400).json({ error: "Invalid user ID" });
    }

    if (!role) {
      return res.status(400).json({ error: "Role is required" });
    }

    const allowedRoles = ["user", "viewer", "collaborator"];

    if (!allowedRoles.includes(role.toLowerCase())) {
      return res.status(400).json({
        error: `Invalid role. Allowed roles: ${allowedRoles.join(", ")}`,
      });
    }

    const targetUser = await UserModel.findById(user_id);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    await UserModel.updateRole(user_id, role.toLowerCase());

    return res.json({
      message: "User role updated successfully",
      user_id,
      new_role: role.toLowerCase(),
      role: req.user.role.role_name,
    });
  } catch (error) {
    console.error("Failed to update user role:", error);
    return res.status(500).json({ error: "Failed to update user role" });
  }
}

  static async getAuditTrail(req, res) {
    try {
      const {
        user_id,
        event_type,
        start_date,
        end_date,
        limit = 100,
        page = 1,
        include_analysis_data = false,
      } = req.query;

      let filter = {};

      if (req.user.role.role_name === "company_admin") {
        const companyUsers = await UserModel.getAll({
          company_id: req.user.company_id,
        });
        const userIds = companyUsers.map((u) => new ObjectId(u._id));
        filter.user_id = { $in: userIds };
      }

      if (user_id) {
        filter.user_id = new ObjectId(user_id);
      }

      if (event_type) {
        filter.event_type = event_type;
      }

      if (start_date || end_date) {
        filter.timestamp = {};
        if (start_date) filter.timestamp.$gte = new Date(start_date);
        if (end_date) filter.timestamp.$lte = new Date(end_date);
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);

      let projection = {
        event_type: 1,
        event_data: 1,
        timestamp: 1,
        additional_info: 1,
        user_name: "$user.name",
        user_email: "$user.email",
        company_name: "$company.company_name",
      };

      if (include_analysis_data === "false" || !include_analysis_data) {
        projection.event_data_summary = {
          $cond: {
            if: { $eq: ["$event_type", "analysis_generated"] },
            then: {
              analysis_type: "$event_data.analysis_type",
              analysis_name: "$event_data.analysis_name",
              phase: "$event_data.phase",
              data_size: "$event_data.data_size",
              analysis_summary: "$event_data.analysis_summary",
              metadata: "$event_data.metadata",
              has_analysis_result: {
                $ne: ["$event_data.analysis_result", null],
              },
            },
            else: "$event_data",
          },
        };
        projection.event_data = {
          $cond: {
            if: { $eq: ["$event_type", "analysis_generated"] },
            then: "$$REMOVE",
            else: "$event_data",
          },
        };
      }

      const auditEntries = await AuditModel.find(filter, {
        skip,
        limit: parseInt(limit),
        projection,
      });
      const totalCount = await AuditModel.countDocuments(filter);
      const analysisStats = await AuditModel.getAnalysisStats(filter);

      res.json({
        audit_entries: auditEntries,
        pagination: {
          total: totalCount,
          page: parseInt(page),
          limit: parseInt(limit),
          total_pages: Math.ceil(totalCount / parseInt(limit)),
        },
        analysis_statistics: analysisStats,
        data_inclusion: {
          includes_full_analysis_data: include_analysis_data === "true",
          note:
            include_analysis_data === "true"
              ? "Full analysis results included - may be large"
              : "Analysis results summarized for performance",
        },
      });
    } catch (error) {
      console.error("Failed to fetch audit trail:", error);
      res.status(500).json({ error: "Failed to fetch audit trail" });
    }
  }

  static async getAuditAnalysisData(req, res) {
    try {
      const { audit_id } = req.params;

      if (!ObjectId.isValid(audit_id)) {
        return res.status(400).json({ error: "Invalid audit ID" });
      }

      const auditEntry = await AuditModel.findById(audit_id);

      if (!auditEntry || auditEntry.event_type !== "analysis_generated") {
        return res
          .status(404)
          .json({ error: "Analysis audit entry not found" });
      }

      if (req.user.role.role_name === "company_admin") {
        const user = await UserModel.findById(auditEntry.user_id);
        if (
          !user ||
          user.company_id.toString() !== req.user.company_id.toString()
        ) {
          return res.status(403).json({ error: "Access denied" });
        }
      }

      res.json({
        audit_id: auditEntry._id,
        timestamp: auditEntry.timestamp,
        analysis_result: auditEntry.event_data.analysis_result,
        analysis_metadata: {
          type: auditEntry.event_data.analysis_type,
          name: auditEntry.event_data.analysis_name,
          phase: auditEntry.event_data.phase,
          data_size: auditEntry.event_data.data_size,
        },
      });
    } catch (error) {
      console.error("Failed to fetch analysis data from audit trail:", error);
      res.status(500).json({ error: "Failed to fetch analysis data" });
    }
  }

  static async getAuditEventTypes(req, res) {
    try {
      const eventTypes = await AuditModel.getEventTypes();
      res.json({ event_types: eventTypes.sort() });
    } catch (error) {
      console.error("Failed to fetch event types:", error);
      res.status(500).json({ error: "Failed to fetch event types" });
    }
  }

  static async getUserData(req, res) {
    try {
      const { user_id } = req.params;
      const { business_id } = req.query;

      if (!ObjectId.isValid(user_id)) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      const targetUser = await UserModel.findById(user_id);
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }

      if (req.user.role.role_name === "company_admin") {
        if (
          !targetUser.company_id ||
          targetUser.company_id.toString() !== req.user.company_id.toString()
        ) {
          return res
            .status(403)
            .json({ error: "Access denied - user not in your company" });
        }
      }

      const targetUserId = new ObjectId(user_id);

      // Build filters
      let conversationFilter = {
        user_id: targetUserId,
        conversation_type: "question_answer",
      };

      let phaseAnalysisFilter = {
        user_id: targetUserId,
        conversation_type: "phase_analysis",
      };

      let businessFilter = { user_id: targetUserId };

      if (business_id && ObjectId.isValid(business_id)) {
        const businessObjectId = new ObjectId(business_id);
        conversationFilter.business_id = businessObjectId;
        phaseAnalysisFilter.business_id = businessObjectId;

        const businessExists = await BusinessModel.findById(
          businessObjectId,
          targetUserId
        );
        if (!businessExists) {
          return res
            .status(404)
            .json({ error: "Business not found for this user" });
        }
      }

      // Get data
      const conversations =
        await ConversationModel.findByFilter(conversationFilter);
      const phaseAnalysis =
        await ConversationModel.findByFilter(phaseAnalysisFilter);
      const businesses = await BusinessModel.findByUserId(targetUserId);
      const questions = await QuestionModel.findAll({ is_active: true });

      // Get business and document information (same as conversations endpoint)
      let businessInfo = null;
      let documentInfo = null;

      if (business_id) {
        const business = await BusinessModel.findById(
          business_id,
          targetUserId
        );

        if (business) {
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

          if (business.has_financial_document && business.financial_document) {
            let fileExists = business.financial_document.blob_url
              ? true
              : false;

            documentInfo = {
              has_document: true,
              file_exists: fileExists,
              filename: business.financial_document.original_name,
              upload_date: business.financial_document.upload_date,
              file_size: business.financial_document.file_size,
              file_type: business.financial_document.file_type,
              is_processed: business.financial_document.is_processed || false,
              uploaded_by: business.financial_document.uploaded_by,
              blob_url: business.financial_document.blob_url,
              file_content_available: fileExists,
              template_type:
                business.financial_document.template_type || "unknown",
              template_name:
                business.financial_document.template_name || "Unknown Template",
              validation_confidence:
                business.financial_document.validation_confidence || "medium",
              upload_mode: business.financial_document.upload_mode || "manual",
              download_info: {
                can_download: fileExists,
                content_type: business.financial_document.file_type,
                content_disposition: `attachment; filename="${business.financial_document.original_name}"`,
              },
            };
          } else {
            documentInfo = {
              has_document: false,
              file_exists: false,
              file_content_available: false,
              message: "No financial document uploaded for this business",
            };
          }
        }
      }

      // Transform conversations into phases structure (simplified version)
      const phaseMap = new Map();

      questions.forEach((question) => {
        const questionConvs = conversations.filter(
          (c) =>
            c.question_id &&
            c.question_id.toString() === question._id.toString()
        );

        if (questionConvs.length > 0) {
          const phase = question.phase;

          if (!phaseMap.has(phase)) {
            phaseMap.set(phase, {
              phase: phase,
              severity: question.severity || "mandatory",
              questions: [],
            });
          }

          const phaseData = phaseMap.get(phase);
          const allEntries = questionConvs.sort(
            (a, b) => new Date(a.created_at) - new Date(b.created_at)
          );

          const conversationFlow = [];
          let finalAnswer = "";

          allEntries.forEach((entry) => {
            if (entry.message_type === "bot" && entry.message_text) {
              conversationFlow.push({
                type: "question",
                text: entry.message_text,
                timestamp: entry.created_at,
                is_followup: entry.is_followup || false,
              });
            }
            if (entry.answer_text && entry.answer_text.trim() !== "") {
              conversationFlow.push({
                type: "answer",
                text: entry.answer_text,
                timestamp: entry.created_at,
                is_followup: entry.is_followup || false,
              });
              finalAnswer = entry.answer_text;
            }
          });

          const statusEntries = questionConvs.filter(
            (c) => c.metadata && c.metadata.is_complete !== undefined
          );
          const latestStatusEntry =
            statusEntries.length > 0
              ? statusEntries.sort(
                  (a, b) => new Date(b.created_at) - new Date(a.created_at)
                )[0]
              : null;
          const isComplete = latestStatusEntry?.metadata?.is_complete || false;

          if (isComplete && finalAnswer) {
            phaseData.questions.push({
              question: question.question_text,
              answer: finalAnswer,
              question_id: question._id,
              conversation_flow: conversationFlow,
              is_complete: isComplete,
              last_updated:
                allEntries.length > 0
                  ? allEntries[allEntries.length - 1].created_at
                  : null,
            });
          }
        }
      });

      const conversationPhases = Array.from(phaseMap.values()).filter(
        (phase) => phase.questions.length > 0
      );

      // Transform phase analysis
      const analysisResultsByPhase = {};

      phaseAnalysis.forEach((analysis) => {
        const analysisPhase = analysis.metadata?.phase || "initial";
        const analysisType = analysis.metadata?.analysis_type || "unknown";

        if (!analysisResultsByPhase[analysisPhase]) {
          analysisResultsByPhase[analysisPhase] = {
            phase: analysisPhase,
            analyses: [],
          };
        }

        const existingIndex = analysisResultsByPhase[
          analysisPhase
        ].analyses.findIndex((a) => a.analysis_type === analysisType);

        const analysisData = {
          analysis_type: analysisType,
          analysis_name:
            analysis.message_text || `${analysisType.toUpperCase()} Analysis`,
          analysis_data: analysis.analysis_result,
          created_at: analysis.created_at,
          phase: analysisPhase,
        };

        if (existingIndex !== -1) {
          if (
            new Date(analysis.created_at) >
            new Date(
              analysisResultsByPhase[analysisPhase].analyses[
                existingIndex
              ].created_at
            )
          ) {
            analysisResultsByPhase[analysisPhase].analyses[existingIndex] =
              analysisData;
          }
        } else {
          analysisResultsByPhase[analysisPhase].analyses.push(analysisData);
        }
      });

      const systemAnalysis = [];
      Object.values(analysisResultsByPhase).forEach((phaseResult) => {
        phaseResult.analyses.forEach((analysis) => {
          systemAnalysis.push({
            name: analysis.analysis_type,
            analysis_result: analysis.analysis_data,
            created_at: analysis.created_at,
            phase: analysis.phase,
            message_text: analysis.analysis_name,
            analysis_type: analysis.analysis_type,
            analysis_name: analysis.analysis_name,
          });
        });
      });

      // Enhanced system analysis
      const enhancedSystemAnalysis = systemAnalysis.map((analysis) => {
        const analysisType =
          analysis.analysis_type?.toLowerCase() ||
          analysis.name?.toLowerCase() ||
          "";

        return {
          ...analysis,
          normalized_type: analysisType,
          is_financial_analysis: [
            "profitabilityanalysis",
            "profitability_analysis",
            "growthtracker",
            "growth_tracker",
            "liquidityefficiency",
            "liquidity_efficiency",
            "investmentperformance",
            "investment_performance",
            "leveragerisk",
            "leverage_risk",
            "costefficiency",
            "cost_efficiency",
            "financialperformance",
            "financial_performance",
            "financialbalance",
            "financial_balance",
            "operationalefficiency",
            "operational_efficiency",
          ].includes(analysisType),
          business_context: business_id
            ? {
                business_id: business_id,
                has_document: documentInfo?.has_document || false,
                document_exists: documentInfo?.file_exists || false,
              }
            : null,
          original_phase: analysis.phase,
          generated_timestamp: analysis.created_at,
        };
      });

      // Calculate statistics
      const totalQuestions = questions.length;
      const completedQuestions = conversationPhases.reduce(
        (sum, phase) => sum + phase.questions.length,
        0
      );

      // Enhanced businesses with statistics
      const enhancedBusinesses = await Promise.all(
        businesses.map(async (business) => {
          const businessConversations = await ConversationModel.findByFilter({
            user_id: targetUserId,
            business_id: business._id,
            conversation_type: "question_answer",
          });

          const businessQuestionStats = {};

          businessConversations.forEach((conv) => {
            if (conv.question_id) {
              const questionId = conv.question_id.toString();

              if (!businessQuestionStats[questionId]) {
                businessQuestionStats[questionId] = {
                  hasAnswers: false,
                  isComplete: false,
                  answerCount: 0,
                };
              }

              if (conv.answer_text && conv.answer_text.trim() !== "") {
                businessQuestionStats[questionId].hasAnswers = true;
                businessQuestionStats[questionId].answerCount++;
              }

              if (conv.metadata && conv.metadata.is_complete === true) {
                businessQuestionStats[questionId].isComplete =
                  businessQuestionStats[questionId].isComplete = true;
              }
            }
          });

          const completedQuestionsForBusiness = Object.values(
            businessQuestionStats
          ).filter((stat) => stat.isComplete || stat.hasAnswers).length;

          const progressPercentage =
            totalQuestions > 0
              ? Math.round(
                  (completedQuestionsForBusiness / totalQuestions) * 100
                )
              : 0;

          const enhancedBusiness = {
            ...business,
            city: business.city || "",
            country: business.country || "",
            location_display: [business.city, business.country]
              .filter(Boolean)
              .join(", "),
            has_financial_document: business.has_financial_document || false,
            question_statistics: {
              total_questions: totalQuestions,
              completed_questions: completedQuestionsForBusiness,
              pending_questions: totalQuestions - completedQuestionsForBusiness,
              progress_percentage: progressPercentage,
              total_answers_given: Object.values(businessQuestionStats).reduce(
                (sum, stat) => sum + stat.answerCount,
                0
              ),
            },
          };

          if (business.has_financial_document && business.financial_document) {
            enhancedBusiness.financial_document_info = {
              filename: business.financial_document.original_name,
              upload_date: business.financial_document.upload_date,
              file_size: business.financial_document.file_size,
              file_type: business.financial_document.file_type,
              template_type:
                business.financial_document.template_type || "unknown",
              template_name:
                business.financial_document.template_name || "Unknown Template",
              validation_confidence:
                business.financial_document.validation_confidence || "medium",
              upload_mode: business.financial_document.upload_mode || "manual",
              is_processed: business.financial_document.is_processed || false,
              blob_url: business.financial_document.blob_url,
            };

            enhancedBusiness.upload_decision_made =
              business.upload_decision_made || false;
            enhancedBusiness.upload_decision = business.upload_decision || null;
          }

          return enhancedBusiness;
        })
      );

      const responseData = {
        user_info: {
          user_id: targetUser._id,
          name: targetUser.name,
          email: targetUser.email,
          created_at: targetUser.created_at,
        },
        conversation: conversationPhases,
        system: enhancedSystemAnalysis,
        businesses: enhancedBusinesses,
        business_info: businessInfo,
        document_info: documentInfo,
        phase_analysis: analysisResultsByPhase,
        stats: {
          total_questions: totalQuestions,
          completed_questions: completedQuestions,
          completion_percentage:
            totalQuestions > 0
              ? Math.round((completedQuestions / totalQuestions) * 100)
              : 0,
          total_businesses: enhancedBusinesses.length,
          total_analyses: enhancedSystemAnalysis.length,
          analysis_breakdown: {
            initial_phase: enhancedSystemAnalysis.filter(
              (a) => a.phase === "initial"
            ).length,
            essential_phase: enhancedSystemAnalysis.filter(
              (a) => a.phase === "essential"
            ).length,
            good_phase: enhancedSystemAnalysis.filter((a) => a.phase === "good")
              .length,
            financial_analyses: enhancedSystemAnalysis.filter(
              (a) => a.is_financial_analysis
            ).length,
            non_financial_analyses: enhancedSystemAnalysis.filter(
              (a) => !a.is_financial_analysis
            ).length,
          },
          document_stats: {
            businesses_with_documents: enhancedBusinesses.filter(
              (b) => b.has_financial_document
            ).length,
            businesses_without_documents: enhancedBusinesses.filter(
              (b) => !b.has_financial_document
            ).length,
            document_upload_rate:
              enhancedBusinesses.length > 0
                ? Math.round(
                    (enhancedBusinesses.filter((b) => b.has_financial_document)
                      .length /
                      enhancedBusinesses.length) *
                      100
                  )
                : 0,
          },
        },
        filter_info: {
          filtered_by_business: business_id ? true : false,
          business_id: business_id || null,
          showing_all_businesses: !business_id,
        },
        metadata: {
          has_business_context: !!businessInfo,
          has_document_uploaded: documentInfo?.has_document || false,
          document_file_exists: documentInfo?.file_exists || false,
          document_content_available:
            documentInfo?.file_content_available || false,
          is_good_phase_ready:
            documentInfo?.has_document && documentInfo?.file_exists,
          request_timestamp: new Date().toISOString(),
        },
      };

      res.json(responseData);
    } catch (error) {
      console.error("Failed to fetch user data:", error);
      res.status(500).json({ error: "Failed to fetch user data" });
    }
  }
}

module.exports = AdminController;
