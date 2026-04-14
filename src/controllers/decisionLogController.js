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
}

module.exports = DecisionLogController;
