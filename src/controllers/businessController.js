const { ObjectId } = require("mongodb");
const BusinessModel = require("../models/businessModel");
const UserModel = require("../models/userModel");
const ConversationModel = require("../models/conversationModel");
const QuestionModel = require("../models/questionModel");
const ProjectModel = require("../models/projectModel");
const ProjectRankingModel = require("../models/projectRankingModel")
const { logAuditEvent } = require("../services/auditService");
const { getDB } = require("../config/database")
const TierService = require("../services/tierService");

const {
  MAX_BUSINESSES_PER_USER,
  ALLOWED_PHASES,
} = require("../config/constants");

const VALID_ADMIN_ROLES = ["super_admin", "company_admin"];



class BusinessController {


  static async getAll(req, res) {
    try {
      const { user_id } = req.query;
      let targetUserId;


      const db = getDB();

      // Fetch the role document for company_admin
      const companyAdminRole = await db.collection("roles").findOne({ role_name: "company_admin" });
      const companyAdminRoleId = companyAdminRole?._id;

      let companyAdminIds = [];

      if (req.user.company_id && companyAdminRoleId) {
        try {
          const companyAdmins = await UserModel.getAll({
            company_id: req.user.company_id,
            role_id: companyAdminRoleId
          });

          // Ensure we always have an array of string IDs
          companyAdminIds = Array.isArray(companyAdmins)
            ? companyAdmins.map(admin => admin._id.toString())
            : [];

        } catch (err) {
          console.error("Failed to fetch company admins:", err);
          companyAdminIds = [];
        }
      }

      if (user_id) {
        if (!VALID_ADMIN_ROLES.includes(req.user.role.role_name)) {
          return res.status(403).json({
            error: "Admin access required to view other users businesses",
          });
        }

        const targetUser = await UserModel.findById(user_id);
        if (!targetUser)
          return res.status(404).json({ error: "User not found" });

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

        targetUserId = new ObjectId(user_id);
      } else {
        targetUserId = new ObjectId(req.user._id);
      }

      let owned = [];
      let collabs = [];

      if (
        ["company_admin", "viewer"].includes(req.user.role.role_name) &&
        !user_id
      ) {
        const companyUsers = await UserModel.getAll({
          company_id: req.user.company_id,
        });

        const companyUserIds = companyUsers.map((u) => new ObjectId(u._id));

        owned = await BusinessModel.findByUserIds(companyUserIds);
        collabs = await BusinessModel.findByCollaborator(req.user._id);
      } else {
        owned = await BusinessModel.findByUserId(targetUserId);
        collabs = await BusinessModel.findByCollaborator(targetUserId);
      }

      const ownedIds = new Set(owned.map((b) => b._id.toString()));
      const collaborating_businesses = collabs.filter(
        (b) => !ownedIds.has(b._id.toString())
      );

      // check business with started projects
      const allBusinesses = [...owned, ...collaborating_businesses];
      const businessIds = allBusinesses.map((b) => new ObjectId(b._id));

      const businessesWithProjects = await ProjectModel.collection().distinct(
        "business_id",
        {
          business_id: { $in: businessIds },
        }
      );

      const businessHasProjectSet = new Set(
        businessesWithProjects.map((id) => id.toString())
      );

      const totalQuestions = await QuestionModel.countDocuments({
        is_active: true,
        phase: { $in: ALLOWED_PHASES },
      });

      const buildAccess = (business) => {
        const isOwner =
          business.user_id &&
          business.user_id.toString() === req.user._id.toString();
        const isCollaborator = (business.collaborators || []).some(
          (id) => id.toString() === req.user._id.toString()
        );
        const isAdmin = VALID_ADMIN_ROLES.includes(req.user.role.role_name);

        // permission rules:
        const canCreateProject = isCollaborator || isAdmin;
        const canEditProject = isCollaborator || isAdmin;
        const canLaunchProject = isAdmin;

        return {
          isOwner,
          isCollaborator,
          isAdmin,
          canView: true,
          canCreateProject,
          canEditProject,
          canLaunchProject,
        };
      };

      const enhance = async (businessList) => {
        return Promise.all(
          businessList.map(async (business) => {
            const conversations = await ConversationModel.findByFilter({
              user_id: business.user_id,
              business_id: business._id,
              conversation_type: "question_answer",
            });

            const questionStats = {};
            conversations.forEach((conv) => {
              if (conv.question_id) {
                const qid = conv.question_id.toString();
                if (!questionStats[qid])
                  questionStats[qid] = {
                    hasAnswers: false,
                    isComplete: false,
                    answerCount: 0,
                  };
                if (conv.answer_text && conv.answer_text.trim() !== "") {
                  questionStats[qid].hasAnswers = true;
                  questionStats[qid].answerCount++;
                }
                if (conv.metadata && conv.metadata.is_complete === true) {
                  questionStats[qid].isComplete = true;
                }
              }
            });

            const allowedQuestions = await QuestionModel.findAll({
              is_active: true,
              phase: { $in: ALLOWED_PHASES },
            });
            const allowedQuestionIds = new Set(
              allowedQuestions.map((q) => q._id.toString())
            );
            const filteredQuestionStats = Object.entries(questionStats).filter(
              ([qid]) => allowedQuestionIds.has(qid)
            );
            const completedQuestions = filteredQuestionStats.filter(
              ([_, stat]) => stat.isComplete || stat.hasAnswers
            ).length;
            const pendingQuestions = totalQuestions - completedQuestions;
            const progressPercentage =
              totalQuestions > 0
                ? Math.round((completedQuestions / totalQuestions) * 100)
                : 0;

            const access = buildAccess(business);

            return {
              ...business,
              company_admin_id: companyAdminIds,
              city: business.city || "",
              country: business.country || "",
              location_display: [business.city, business.country]
                .filter(Boolean)
                .join(", "),
              has_financial_document: business.has_financial_document || false,
              financial_document_info:
                business.has_financial_document && business.financial_document
                  ? {
                    filename: business.financial_document.original_name,
                    upload_date: business.financial_document.upload_date,
                    file_size: business.financial_document.file_size,
                    file_type: business.financial_document.file_type,
                  }
                  : null,
              question_statistics: {
                total_questions: totalQuestions,
                completed_questions: completedQuestions,
                pending_questions: pendingQuestions,
                progress_percentage: progressPercentage,
                total_answers_given: filteredQuestionStats.reduce(
                  (sum, [, stat]) => sum + stat.answerCount,
                  0
                ),
                excluded_phases: ["good"],
                included_phases: ALLOWED_PHASES,
              },
              access,
              has_projects: businessHasProjectSet.has(business._id.toString()),
            };
          })
        );
      };

      const enhancedOwned = await enhance(owned);
      const enhancedCollaborating = await enhance(collaborating_businesses);

      //       console.log("DEBUG companyAdminIds:", companyAdminIds);
      // console.log("DEBUG targetUserId:", targetUserId.toString());
      // console.log("DEBUG owned:", owned.map(b => b._id.toString()));
      // console.log("DEBUG collaborating_businesses:", collaborating_businesses.map(b => b._id.toString()));

      res.json({
        businesses: enhancedOwned,
        collaborating_businesses: enhancedCollaborating,
        overall_stats: {
          total_businesses: owned.length,
          total_questions_in_system: totalQuestions,
          businesses_with_location: enhancedOwned.filter(
            (b) => b.city || b.country
          ).length,
          businesses_with_documents: enhancedOwned.filter(
            (b) => b.has_financial_document
          ).length,
          calculation_method: "excluding_good_phase",
          phases_included: ALLOWED_PHASES,
          phases_excluded: ["good"],
        },
        user_id: targetUserId.toString(),
        company_admin_ids: companyAdminIds
      });
    } catch (error) {
      console.error("Failed to fetch businesses:", error);
      res.status(500).json({ error: "Failed to fetch businesses" });
    }
  }

  static async getById(req, res) {
    try {
      const businessId = req.params.id;

      if (!ObjectId.isValid(businessId)) {
        return res.status(400).json({ error: "Invalid business ID" });
      }

      const business = await BusinessModel.findById(businessId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      // Check access permissions
      const isOwner = business.user_id && business.user_id.toString() === req.user._id.toString();
      const isCollaborator = (business.collaborators || []).some(
        (id) => id.toString() === req.user._id.toString()
      );
      const isAdmin = VALID_ADMIN_ROLES.includes(req.user.role.role_name);

      if (!isOwner && !isCollaborator && !isAdmin) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Enhance business data similar to getAll
      const totalQuestions = await QuestionModel.countDocuments({
        is_active: true,
        phase: { $in: ALLOWED_PHASES },
      });

      const conversations = await ConversationModel.findByFilter({
        user_id: business.user_id,
        business_id: business._id,
        conversation_type: "question_answer",
      });

      const questionStats = {};
      conversations.forEach((conv) => {
        if (conv.question_id) {
          const qid = conv.question_id.toString();
          if (!questionStats[qid])
            questionStats[qid] = {
              hasAnswers: false,
              isComplete: false,
              answerCount: 0,
            };
          if (conv.answer_text && conv.answer_text.trim() !== "") {
            questionStats[qid].hasAnswers = true;
            questionStats[qid].answerCount++;
          }
          if (conv.metadata && conv.metadata.is_complete === true) {
            questionStats[qid].isComplete = true;
          }
        }
      });

      const allowedQuestions = await QuestionModel.findAll({
        is_active: true,
        phase: { $in: ALLOWED_PHASES },
      });
      const allowedQuestionIds = new Set(
        allowedQuestions.map((q) => q._id.toString())
      );
      const filteredQuestionStats = Object.entries(questionStats).filter(
        ([qid]) => allowedQuestionIds.has(qid)
      );
      const completedQuestions = filteredQuestionStats.filter(
        ([_, stat]) => stat.isComplete || stat.hasAnswers
      ).length;
      const pendingQuestions = totalQuestions - completedQuestions;
      const progressPercentage =
        totalQuestions > 0
          ? Math.round((completedQuestions / totalQuestions) * 100)
          : 0;

      const hasProjects = await ProjectModel.collection().countDocuments({
        business_id: new ObjectId(businessId),
      }) > 0;

      const enhancedBusiness = {
        ...business,
        city: business.city || "",
        country: business.country || "",
        location_display: [business.city, business.country]
          .filter(Boolean)
          .join(", "),
        has_financial_document: business.has_financial_document || false,
        financial_document_info:
          business.has_financial_document && business.financial_document
            ? {
              filename: business.financial_document.original_name,
              upload_date: business.financial_document.upload_date,
              file_size: business.financial_document.file_size,
              file_type: business.financial_document.file_type,
            }
            : null,
        question_statistics: {
          total_questions: totalQuestions,
          completed_questions: completedQuestions,
          pending_questions: pendingQuestions,
          progress_percentage: progressPercentage,
          total_answers_given: filteredQuestionStats.reduce(
            (sum, [, stat]) => sum + stat.answerCount,
            0
          ),
          excluded_phases: ["good"],
          included_phases: ALLOWED_PHASES,
        },
        access: {
          isOwner,
          isCollaborator,
          isAdmin,
          canView: true,
          canCreateProject: isCollaborator || isAdmin,
          canEditProject: isCollaborator || isAdmin,
          canLaunchProject: isAdmin,
        },
        has_projects: hasProjects,
      };

      res.json(enhancedBusiness);
    } catch (error) {
      console.error("Failed to fetch business:", error);
      res.status(500).json({ error: "Failed to fetch business" });
    }
  }

  static async create(req, res) {
    try {
      const { business_name, business_purpose, description, city, country } =
        req.body;

      if (!business_name || !business_purpose) {
        return res
          .status(400)
          .json({ error: "Business name and purpose required" });
      }

      if (city && city.trim().length > 0 && city.trim().length < 2) {
        return res
          .status(400)
          .json({ error: "City must be at least 2 characters long" });
      }

      if (country && country.trim().length > 0 && country.trim().length < 2) {
        return res
          .status(400)
          .json({ error: "Country must be at least 2 characters long" });
      }

      const tierName = await TierService.getUserTier(req.user._id);
      const limits = TierService.getTierLimits(tierName);
      const existingCount = await BusinessModel.countByUserId(req.user._id);

      if (existingCount >= limits.max_workspaces) {
        return res.status(403).json({
          error: `Workspace limit reached for ${tierName} plan. Maximum ${limits.max_workspaces} workspace(s) allowed.`
        });
      }

      const existingBusinesses = await BusinessModel.findByUserId(req.user._id);
      const duplicateName = existingBusinesses.some(
        (business) =>
          business.business_name.toLowerCase() ===
          business_name.trim().toLowerCase()
      );

      if (duplicateName) {
        return res
          .status(400)
          .json({ error: "A business with this name already exists" });
      }

      const businessData = {
        user_id: new ObjectId(req.user._id),
        business_name: business_name.trim(),
        business_purpose: business_purpose.trim(),
        description: description ? description.trim() : "",
        city: city ? city.trim() : "",
        country: country ? country.trim() : "",
        collaborators: [],
        status: "draft",
      };

      const businessId = await BusinessModel.create(businessData);

      await logAuditEvent(req.user._id, "business_created", {
        business_id: businessId,
        business_name: business_name.trim(),
        business_purpose: business_purpose.trim(),
        description: description ? description.trim() : "",
        location: {
          city: city ? city.trim() : "",
          country: country ? country.trim() : "",
        },
        has_location: !!(city || country),
      });

      res.json({
        message: "Business created successfully",
        business_id: businessId,
        business: {
          _id: businessId,
          ...businessData,
          created_at: new Date(),
        },
      });
    } catch (error) {
      console.error("Failed to create business:", error);
      res.status(500).json({ error: "Failed to create business" });
    }
  }

  static async delete(req, res) {
    try {
      const businessId = new ObjectId(req.params.id);
      const userId = new ObjectId(req.user._id);

      const business = await BusinessModel.findById(businessId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      // Check if this business is already deleted
      if (business.status === 'deleted') {
        return res.status(400).json({ error: "This business is already deleted" });
      }

      // 30-day cooldown check
      const lastDeleted = await BusinessModel.findLastDeleted(userId);
      if (lastDeleted && lastDeleted.deleted_at) {
        const cooldownDays = 30;
        const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
        const timeSinceLastDeleted = new Date() - new Date(lastDeleted.deleted_at);

        if (timeSinceLastDeleted < cooldownMs) {
          const remainingDays = Math.ceil((cooldownMs - timeSinceLastDeleted) / (1000 * 60 * 60 * 24));
          return res.status(403).json({
            error: `You cannot delete by 30 days. Please wait ${remainingDays} more day(s).`
          });
        }
      }
      // Check if user has permission to delete
      const isOwner = business.user_id && business.user_id.toString() === userId.toString();
      const isAdmin = VALID_ADMIN_ROLES.includes(req.user.role.role_name);

      if (!isOwner && !isAdmin) {
        return res.status(403).json({ error: "Access denied - only business owner or admin can delete" });
      }

      const conversationCount = await ConversationModel.countDocuments({
        user_id: business.user_id,
        business_id: businessId,
      });

      const deleteResult = await BusinessModel.delete(businessId, business.user_id);
      if (deleteResult.modifiedCount === 0) {
        return res.status(404).json({ error: "Business not found or already deleted" });
      }

      // We DON'T delete conversations anymore if we want to keep them for the "deleted" business
      // Or we can mark them deleted too. For now let's keep them if the business is still "in db".
      // However the controller previously did:
      // await ConversationModel.deleteMany({ user_id: userId, business_id: businessId });
      // I'll comment it out or remove it to keep the data as requested ("remains in db").

      await ConversationModel.deleteMany({
        user_id: business.user_id,
        business_id: businessId,
      });

      await logAuditEvent(req.user._id, "business_deleted", {
        business_id: businessId,
        business_name: business.business_name,
        business_purpose: business.business_purpose,
        conversations_deleted: conversationCount,
        deleted_at: new Date(),
      });

      res.json({ message: "Business and conversations deleted successfully" });
    } catch (error) {
      console.error("Delete business error:", error);
      res.status(500).json({ error: "Failed to delete business" });
    }
  }

  static async getCollaborators(req, res) {
    try {
      const businessId = req.params.id;

      if (!ObjectId.isValid(businessId)) {
        return res.status(400).json({ error: "Invalid business id" });
      }

      const business = await BusinessModel.findById(businessId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const role = req.user.role.role_name;
      if (!["company_admin", "super_admin"].includes(role)) {
        return res.status(403).json({
          error: "Only company_admin or super_admin can view collaborators",
        });
      }

      const collaboratorIds = business.collaborators || [];

      const db = getDB();
      const collaboratorRole = await db.collection("roles").findOne({ role_name: "collaborator" });
      if (!collaboratorRole) {
        return res.status(404).json({ error: "Collaborator role not found" });
      }
      const collaboratorRoleId = collaboratorRole._id;

      const collaborators = await UserModel.getAll({
        _id: { $in: collaboratorIds.map(id => new ObjectId(id)) },
        role_id: collaboratorRoleId
      });

      const response = collaborators.map(u => ({
        _id: u._id,
        name: u.name,
      }));

      res.json({ collaborators: response });
    } catch (err) {
      console.error("GET collaborators error:", err);
      res.status(500).json({ error: "Failed to fetch collaborators" });
    }
  }

  static async setAllowedCollaborators(req, res) {
    try {
      const { businessId, projectId } = req.params;
      const { collaborator_ids } = req.body;

      if (!ObjectId.isValid(businessId) || !ObjectId.isValid(projectId)) {
        return res.status(400).json({ error: "Invalid business or project id" });
      }

      if (!Array.isArray(collaborator_ids) || collaborator_ids.length === 0) {
        return res.status(400).json({
          error: "collaborator_ids must be a non-empty array of user IDs"
        });
      }

      // Fetch business
      const business = await BusinessModel.findById(businessId);
      if (!business) return res.status(404).json({ error: "Business not found" });

      // Only admin can update
      const role = req.user.role.role_name;
      if (!["company_admin", "super_admin"].includes(role)) {
        return res.status(403).json({ error: "Only admin can set allowed collaborators" });
      }

      // Fetch project to ensure it exists
      const project = await ProjectModel.collection().findOne({
        _id: new ObjectId(projectId),
        business_id: new ObjectId(businessId),
      });

      if (!project) return res.status(404).json({ error: "Project not found in this business" });

      // Get existing allowed collaborators
      const existingAllowedIds = (project.allowed_collaborators || []).map(id => id.toString());

      // Merge with new collaborator IDs (avoid duplicates)
      const mergedIds = [...new Set([...existingAllowedIds, ...collaborator_ids])];
      const allowedIds = mergedIds.map(id => new ObjectId(id));

      await ProjectModel.collection().updateOne(
        { _id: new ObjectId(projectId) },
        { $set: { allowed_collaborators: allowedIds, updated_at: new Date() } }
      );

      res.json({
        message: "Allowed collaborators updated for project",
        allowed_collaborators: allowedIds.map(id => id.toString()),
      });
    } catch (err) {
      console.error("Set allowed collaborators error:", err);
      res.status(500).json({ error: "Failed to update allowed collaborators" });
    }
  }

  static async setAllowedRankingCollaborators(req, res) {
    try {
      const { id } = req.params;
      const { collaborator_ids } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid business id" });
      }

      if (!Array.isArray(collaborator_ids) || collaborator_ids.length === 0) {
        return res.status(400).json({
          error: "collaborator_ids must be a non-empty array of user IDs",
        });
      }

      if (!["company_admin", "super_admin"].includes(req.user.role.role_name)) {
        return res.status(403).json({
          error: "Only admin can set ranking collaborators",
        });
      }

      const business = await BusinessModel.findById(id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      // only collaborators of this business are allowed
      const validIds = collaborator_ids.filter(cid =>
        (business.collaborators || []).some(
          bid => bid.toString() === cid.toString()
        )
      );

      // Get existing allowed ranking collaborators
      const existingAllowed = business.allowed_ranking_collaborators || [];
      const existingIds = existingAllowed.map(id => id.toString());

      // Merge with new IDs (avoid duplicates)
      const mergedIds = [...new Set([...existingIds, ...validIds])];

      await BusinessModel.setAllowedRankingCollaborators(id, mergedIds);

      res.json({
        message: "Allowed ranking collaborators updated",
        allowed_ranking_collaborators: mergedIds,
      });
    } catch (err) {
      console.error("SET RANKING COLLAB ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async assignCollaborator(req, res) {
    try {
      const businessId = req.params.id;
      const { user_id: collaboratorId } = req.body;

      if (!ObjectId.isValid(businessId) || !ObjectId.isValid(collaboratorId)) {
        return res.status(400).json({ error: "Invalid ids" });
      }

      const business = await BusinessModel.findById(businessId);
      if (!business)
        return res.status(404).json({ error: "Business not found" });

      const requesterRole = req.user.role.role_name;
      const isAdmin = VALID_ADMIN_ROLES.includes(requesterRole);

      const tierName = await TierService.getUserTier(req.user._id);
      const limits = TierService.getTierLimits(tierName);
      const currentCollaboratorsCount = (business.collaborators || []).length;

      if (!isAdmin) {
        return res.status(403).json({
          error: "Only company_admin or super_admin can assign collaborators",
        });
      }

      if (currentCollaboratorsCount >= limits.max_collaborators) {
        return res.status(403).json({
          error: tierName === 'essential'
            ? "Your current plan doesn't support collaborators. Upgrade to Advanced to add team members in the User Management panel."
            : `Collaborator limit reached for ${tierName} plan. Maximum ${limits.max_collaborators} collaborator(s) allowed. Manage your team in the User Management panel.`
        });
      }

      if (business.user_id && business.user_id.toString() === collaboratorId) {
        return res
          .status(400)
          .json({ error: "Owner cannot be added as collaborator" });
      }
      const alreadyAssigned = (business.collaborators || []).some(
        (id) => id.toString() === collaboratorId
      );

      if (alreadyAssigned) {
        return res.status(400).json({
          error: "This collaborator already assigned in this business",
        });
      }

      const addResult = await BusinessModel.addCollaborator(
        businessId,
        collaboratorId
      );

      if (typeof logAuditEvent === "function") {
        await logAuditEvent(req.user._id, "collaborator_assigned", {
          business_id: businessId,
          collaborator: collaboratorId,
        });
      }

      res.json({ message: "Collaborator assigned" });
    } catch (err) {
      console.error("Assign collaborator error:", err);
      res.status(500).json({ error: "Failed to assign collaborator" });
    }
  }

  static async removeCollaborator(req, res) {
    try {
      const businessId = req.params.id;
      const collabId = req.params.collabId;

      if (!ObjectId.isValid(businessId) || !ObjectId.isValid(collabId)) {
        return res.status(400).json({ error: "Invalid ids" });
      }

      const business = await BusinessModel.findById(businessId);
      if (!business)
        return res.status(404).json({ error: "Business not found" });

      const role = req.user.role.role_name;
      if (!["company_admin", "super_admin"].includes(role)) {
        return res.status(403).json({
          error: "Only company_admin or super_admin can remove collaborators",
        });
      }

      if (business.user_id && business.user_id.toString() === collabId) {
        return res.status(400).json({ error: "Cannot remove owner" });
      }

      await BusinessModel.removeCollaborator(businessId, collabId);
      if (typeof logAuditEvent === "function") {
        await logAuditEvent(req.user._id, "collaborator_removed", {
          business_id: businessId,
          collaborator: collabId,
        });
      }

      res.json({ message: "Collaborator removed" });
    } catch (err) {
      console.error("Remove collaborator error:", err);
      res.status(500).json({ error: "Failed to remove collaborator" });
    }
  }

  static async changeStatus(req, res) {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const VALID_STATUS = ["prioritizing", "prioritized", "launched", "reprioritizing"];
      const ADMIN_ROLES = ["company_admin", "super_admin"];

      if (!VALID_STATUS.includes(status)) {
        return res.status(400).json({ error: "Invalid status value" });
      }

      if (!ADMIN_ROLES.includes(req.user.role.role_name)) {
        return res.status(403).json({
          error: "Only company_admin or super_admin can change business status",
        });
      }

      const business = await BusinessModel.findById(id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      if (status === "reprioritizing") {
        await ProjectRankingModel.unlockRankingByBusiness(id);
        await BusinessModel.clearAllowedRankingCollaborators(id);
      }

      if (status === "launched") {
        await ProjectRankingModel.lockRankingByBusiness(id);
        await BusinessModel.clearAllowedRankingCollaborators(id);

        await ProjectModel.collection().updateMany(
          { business_id: new ObjectId(id) },
          { $set: { allowed_collaborators: [], updated_at: new Date() } }
        );
      }


      // Update business status
      await BusinessModel.collection().updateOne(
        { _id: new ObjectId(id) },
        { $set: { status, updated_at: new Date() } }
      );

      // business owner(user) to collaborator 
      if (["prioritizing", "prioritized", "reprioritizing"].includes(status) && business.user_id) {
        const ownerId = business.user_id.toString();
        const ownerUser = await require("../models/userModel").findById(ownerId);

        if (ownerUser) {
          const roleDoc = await require("../config/database")
            .getDB()
            .collection("roles")
            .findOne({ _id: ownerUser.role_id });

          const ownerRoleName = roleDoc?.role_name;

          if (["user", "viewer"].includes(ownerRoleName)) {
            await require("../models/userModel").updateRole(ownerId, "collaborator");
            await BusinessModel.addCollaborator(id, ownerId);
            console.log(
              `Owner auto-promoted to collaborator: ${ownerId} for business ${id}`
            );
          }
        }
      }

      // Update all projects under this business
      await ProjectModel.collection().updateMany(
        { business_id: new ObjectId(id) },
        { $set: { status, updated_at: new Date() } }
      );

      return res.json({
        message: "Business status updated successfully",
        business_id: id,
        new_status: status,
      });
    } catch (err) {
      console.error("BUSINESS STATUS UPDATE ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
}

module.exports = BusinessController;
