const { ObjectId } = require("mongodb");
const BusinessModel = require("../models/businessModel");
const UserModel = require("../models/userModel");
const ConversationModel = require("../models/conversationModel");
const QuestionModel = require("../models/questionModel");
const ProjectModel = require("../models/projectModel");
const { logAuditEvent } = require("../services/auditService");
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

      // fetch owned and collaborating businesses
      const owned = await BusinessModel.findByUserId(targetUserId);
      const collabs = await BusinessModel.findByCollaborator(targetUserId);

      const ownedIds = new Set(owned.map((b) => b._id.toString()));
      const collaborating_businesses = collabs.filter(
        (b) => !ownedIds.has(b._id.toString())
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
        const canLaunchProject = isAdmin; // company_admin + super_admin

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
            };
          })
        );
      };

      const enhancedOwned = await enhance(owned);
      const enhancedCollaborating = await enhance(collaborating_businesses);

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
      });
    } catch (error) {
      console.error("Failed to fetch businesses:", error);
      res.status(500).json({ error: "Failed to fetch businesses" });
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

      const existingCount = await BusinessModel.countByUserId(req.user._id);
      if (existingCount >= MAX_BUSINESSES_PER_USER) {
        return res.status(400).json({ error: "Maximum 5 businesses allowed" });
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

      const business = await BusinessModel.findById(businessId, userId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const conversationCount = await ConversationModel.countDocuments({
        user_id: userId,
        business_id: businessId,
      });

      const deleteResult = await BusinessModel.delete(businessId, userId);
      if (deleteResult.deletedCount === 0) {
        return res.status(404).json({ error: "Business not found" });
      }

      await ConversationModel.deleteMany({
        user_id: userId,
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

      if (!isAdmin) {
        return res.status(403).json({
          error: "Only company_admin or super_admin can assign collaborators",
        });
      }

      if (business.user_id && business.user_id.toString() === collaboratorId) {
        return res
          .status(400)
          .json({ error: "Owner cannot be added as collaborator" });
      }

      const addResult = await BusinessModel.addCollaborator(
        businessId,
        collaboratorId
      );
      if (addResult.modifiedCount === 0 && addResult.matchedCount === 1) {
        return res
          .status(200)
          .json({ message: "Collaborator already assigned or no change" });
      }

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

      const VALID_STATUS = ["draft", "prioritizing", "prioritized", "launched"];
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

      // Update business status
      await BusinessModel.collection().updateOne(
        { _id: new ObjectId(id) },
        { $set: { status, updated_at: new Date() } }
      );

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
