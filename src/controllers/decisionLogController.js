const { ObjectId } = require("mongodb");
const DecisionLogModel = require("../models/decisionLogModel");
const ProjectModel = require("../models/projectModel");
const BusinessModel = require("../models/businessModel");
const DecisionLogService = require("../services/decisionLogService");

const ADMIN_ROLES = ["super_admin", "company_admin"];

function isAdmin(user) {
  const roleName = user?.role?.role_name;
  return ADMIN_ROLES.includes(roleName);
}

async function resolveProjectAndPermissions(req, projectId) {
  const project = await ProjectModel.findById(projectId);
  if (!project) return { error: "Project not found", status: 404 };

  const business = await BusinessModel.findById(project.business_id);
  if (!business) return { error: "Business not found", status: 404 };

  const userId = req.user._id.toString();
  const ownerId = business.user_id?.toString();
  const collaboratorIds = (business.collaborators || []).map((id) => id.toString());
  const userRole = req.user?.role?.role_name;

  const canView =
    isAdmin(req.user) || ownerId === userId || collaboratorIds.includes(userId) || userRole === "viewer";
  const canWrite =
    isAdmin(req.user) || ownerId === userId || collaboratorIds.includes(userId);

  return { project, business, canView, canWrite };
}

class DecisionLogController {
  static async createDecisionLog(req, res) {
    try {
      const { projectId } = req.params;
      if (!ObjectId.isValid(projectId)) {
        return res.status(400).json({ error: "Invalid project ID" });
      }

      const authResult = await resolveProjectAndPermissions(req, projectId);
      if (authResult.error) {
        return res.status(authResult.status).json({ error: authResult.error });
      }

      if (!authResult.canWrite || req.user?.role?.role_name === "viewer") {
        return res.status(403).json({ error: "You do not have permission to create decision logs" });
      }

      const {
        log_type,
        decision,
        execution_state,
        assumption_state,
        justification,
        metadata = {},
        before_snapshot = {},
        after_snapshot = {},
      } = req.body || {};

      if (!justification || !String(justification).trim()) {
        return res.status(400).json({ error: "justification is required" });
      }

      const insertedId = await DecisionLogService.createManualDecisionLog({
        project: authResult.project,
        actorId: req.user._id,
        logType: log_type || "manual",
        decision: decision || "manual_decision",
        executionState: execution_state || authResult.project.status,
        assumptionState: assumption_state || authResult.project.learning_state,
        justification: String(justification).trim(),
        metadata: {
          ...metadata,
          source: "decision_log_api_create",
        },
        beforeSnapshot: before_snapshot,
        afterSnapshot: after_snapshot,
      });

      return res.status(201).json({
        message: "Decision log created successfully",
        decision_log_id: insertedId,
      });
    } catch (error) {
      console.error("CREATE DECISION LOG ERROR:", error);
      return res.status(500).json({ error: "Server error" });
    }
  }

  static async getProjectDecisionLogs(req, res) {
    try {
      const { projectId } = req.params;
      if (!ObjectId.isValid(projectId)) {
        return res.status(400).json({ error: "Invalid project ID" });
      }

      const authResult = await resolveProjectAndPermissions(req, projectId);
      if (authResult.error) {
        return res.status(authResult.status).json({ error: authResult.error });
      }
      if (!authResult.canView) {
        return res.status(403).json({ error: "You do not have permission to view decision logs" });
      }

      const logsResult = await DecisionLogModel.findByProjectId(projectId, {
        ...(req.query || {}),
        returnMeta: true,
      });

      return res.json({
        message: "Decision logs fetched successfully",
        ...logsResult,
      });
    } catch (error) {
      console.error("GET DECISION LOGS ERROR:", error);
      return res.status(500).json({ error: "Server error" });
    }
  }

  static async getDecisionTimeline(req, res) {
    try {
      const { projectId } = req.params;
      if (!ObjectId.isValid(projectId)) {
        return res.status(400).json({ error: "Invalid project ID" });
      }

      const authResult = await resolveProjectAndPermissions(req, projectId);
      if (authResult.error) {
        return res.status(authResult.status).json({ error: authResult.error });
      }
      if (!authResult.canView) {
        return res.status(403).json({ error: "You do not have permission to view timeline" });
      }

      const timeline = await DecisionLogModel.getTimelineByProjectId(projectId, req.query || {});
      return res.json({
        message: "Decision timeline fetched successfully",
        ...timeline,
      });
    } catch (error) {
      console.error("GET DECISION TIMELINE ERROR:", error);
      return res.status(500).json({ error: "Server error" });
    }
  }

  static async getDecisionDetails(req, res) {
    try {
      const { decisionLogId } = req.params;
      if (!ObjectId.isValid(decisionLogId)) {
        return res.status(400).json({ error: "Invalid decision log ID" });
      }

      const log = await DecisionLogModel.findById(decisionLogId);
      if (!log) {
        return res.status(404).json({ error: "Decision log not found or has been deleted" });
      }

      const authResult = await resolveProjectAndPermissions(req, log.project_id);
      if (authResult.error) {
        return res.status(authResult.status).json({ error: authResult.error });
      }
      if (!authResult.canView) {
        return res.status(403).json({ error: "You do not have permission to view decision details" });
      }

      return res.json({
        message: "Decision log details fetched successfully",
        log,
      });
    } catch (error) {
      console.error("GET DECISION DETAILS ERROR:", error);
      return res.status(500).json({ error: "Server error" });
    }
  }

  static async updateDecisionStatus(req, res) {
    try {
      const { decisionLogId } = req.params;
      const { status } = req.body || {};

      if (!ObjectId.isValid(decisionLogId)) {
        return res.status(400).json({ error: "Invalid decision log ID" });
      }
      if (!status || !String(status).trim()) {
        return res.status(400).json({ error: "status is required" });
      }

      const existingLog = await DecisionLogModel.findById(decisionLogId);
      if (!existingLog) {
        return res.status(404).json({ error: "Decision log not found or has been deleted" });
      }

      const authResult = await resolveProjectAndPermissions(req, existingLog.project_id);
      if (authResult.error) {
        return res.status(authResult.status).json({ error: authResult.error });
      }
      if (!authResult.canWrite) {
        return res.status(403).json({ error: "You do not have permission to update decision logs" });
      }

      const updated = await DecisionLogModel.updateStatus(
        decisionLogId,
        String(status).trim(),
        req.user._id
      );

      if (!updated) {
        return res.status(404).json({ error: "Decision log not found or has been deleted" });
      }

      return res.json({
        message: "Decision log updated successfully",
      });
    } catch (error) {
      console.error("UPDATE DECISION STATUS ERROR:", error);
      return res.status(500).json({ error: "Server error" });
    }
  }

  /**
   * GET /api/decision-logs/business/:businessId
   * Business-scoped decision logs from all projects within a specific business.
   * Supports filters: project_id, log_type, execution_state, status, from, to, page, limit, sort_order
   */
  static async getBusinessDecisionLogs(req, res) {
    try {
      const { businessId } = req.params;
      if (!ObjectId.isValid(businessId)) {
        return res.status(400).json({ error: "Invalid business ID" });
      }

      // Check if user has access to this business
      const business = await BusinessModel.findById(businessId);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const userId = req.user._id.toString();
      const ownerId = business.user_id?.toString();
      const collaboratorIds = (business.collaborators || []).map((id) => id.toString());
      const userRole = req.user?.role?.role_name;

      const canView =
        isAdmin(req.user) || ownerId === userId || collaboratorIds.includes(userId) || userRole === "viewer";

      if (!canView) {
        return res.status(403).json({ error: "You do not have permission to view this business's decision logs" });
      }

      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
      const skip = (page - 1) * limit;

      const options = {
        project_id: req.query.project_id,
        log_type: req.query.log_type,
        execution_state: req.query.execution_state,
        status: req.query.status,
        from: req.query.from,
        to: req.query.to,
        sort_order: req.query.sort_order || "desc",
        limit,
        skip,
      };

      const result = await DecisionLogModel.findByBusinessId(businessId, options);

      return res.json({
        message: "Business decision logs fetched successfully",
        business_id: businessId,
        page,
        total_pages: Math.ceil(result.total / limit),
        ...result,
      });
    } catch (error) {
      console.error("GET BUSINESS DECISION LOGS ERROR:", error);
      return res.status(500).json({ error: "Server error" });
    }
  }

  /**
   * GET /api/decision-logs
   * Cross-project aggregated feed scoped to the authenticated user's business.
   * Admins can pass ?business_id= to view any business.
   * Supports filters: project_id, log_type, execution_state, status, from, to, page, limit, sort_order
   */
  static async getAllDecisionLogs(req, res) {
    try {
      const userRole = req.user?.role?.role_name;
      const adminUser = ADMIN_ROLES.includes(userRole);

      // Determine business_id to query
      let businessId;
      if (adminUser && req.query.business_id && ObjectId.isValid(req.query.business_id)) {
        businessId = req.query.business_id;
      } else {
        // Resolve from the user's own business
        const { getDB } = require("../config/database");
        const db = getDB();
        const business = await db.collection("businesses").findOne({
          $or: [
            { user_id: new ObjectId(req.user._id) },
            { collaborators: new ObjectId(req.user._id) },
          ],
        });

        if (!business) {
          return res.status(404).json({ error: "No business found for your account" });
        }
        businessId = business._id.toString();
      }

      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
      const skip = (page - 1) * limit;

      const options = {
        project_id: req.query.project_id,
        log_type: req.query.log_type,
        execution_state: req.query.execution_state,
        status: req.query.status,
        from: req.query.from,
        to: req.query.to,
        sort_order: req.query.sort_order || "desc",
        limit,
        skip,
      };

      const result = await DecisionLogModel.findByBusinessId(businessId, options);

      return res.json({
        message: "Decision logs fetched successfully",
        business_id: businessId,
        page,
        total_pages: Math.ceil(result.total / limit),
        ...result,
      });
    } catch (error) {
      console.error("GET ALL DECISION LOGS ERROR:", error);
      return res.status(500).json({ error: "Server error" });
    }
  }
}

module.exports = DecisionLogController;
