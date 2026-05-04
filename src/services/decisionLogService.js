const { ObjectId } = require("mongodb");
const DecisionLogModel = require("../models/decisionLogModel");
const { logAuditEvent } = require("./auditService");

const SIGNIFICANT_FIELDS = [
  "status",
  "learning_state",
  "review_cadence",
  "impact",
  "effort",
  "risk",
  "strategic_theme",
  "accountable_owner",
  "accountable_owner_id",
];

function normalizeComparable(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof ObjectId) return value.toString();
  if (Array.isArray(value)) return value.map(normalizeComparable);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function collectChanges(before = {}, after = {}) {
  const changedFields = [];

  SIGNIFICANT_FIELDS.forEach((field) => {
    if (!(field in after)) return;
    const oldValue = normalizeComparable(before[field]);
    const newValue = normalizeComparable(after[field]);
    if (oldValue !== newValue) {
      changedFields.push(field);
    }
  });

  return changedFields;
}

function toIdValue(value) {
  if (!value) return null;
  if (value instanceof ObjectId) return value;
  if (!ObjectId.isValid(value)) return null;
  return new ObjectId(value);
}

class DecisionLogService {
  static async ensureIndexes() {
    try {
      await DecisionLogModel.createIndexes();
    } catch (error) {
      console.error("Failed to create decision log indexes:", error);
    }
  }

  static async createManualDecisionLog({
    project,
    actorId,
    logType = "manual",
    decision = "manual_update",
    executionState = null,
    assumptionState = null,
    justification = "",
    metadata = {},
    beforeSnapshot = {},
    afterSnapshot = {},
  }) {
    const projectId = toIdValue(project?._id || project?.project_id);
    if (!projectId) {
      throw new Error("Project is required to create a decision log");
    }

    const payload = {
      project_id: projectId,
      business_id: toIdValue(project?.business_id),
      actor_id: toIdValue(actorId),
      log_type: logType,
      decision,
      execution_state: executionState || project?.status || null,
      assumption_state: assumptionState || project?.learning_state || null,
      justification,
      metadata,
      before_snapshot: beforeSnapshot,
      after_snapshot: afterSnapshot,
      from_status: beforeSnapshot?.status || null,
      to_status: afterSnapshot?.status || project?.status || null,
      from_learning_state: beforeSnapshot?.learning_state || null,
      to_learning_state: afterSnapshot?.learning_state || project?.learning_state || null,
      status: "active",
    };

    const logId = await DecisionLogModel.create(payload);

    await logAuditEvent(
      actorId,
      "project_decision_logged",
      {
        project_id: projectId.toString(),
        decision_log_id: logId.toString(),
        log_type: payload.log_type,
        decision: payload.decision,
        execution_state: payload.execution_state,
      },
      project?.business_id?.toString?.() || project?.business_id || null
    );

    return logId;
  }

  static async logProjectUpdateIfSignificant({
    projectBefore,
    updateData,
    actorId,
    justification = "",
    source = "project_update",
  }) {
    if (!projectBefore || !updateData) return null;

    const changedFields = collectChanges(projectBefore, updateData);
    if (changedFields.length === 0) return null;

    const projectedAfter = {
      ...projectBefore,
      ...updateData,
    };

    return this.createManualDecisionLog({
      project: projectBefore,
      actorId,
      logType: changedFields.includes("status") ? "status_change" : "project_update",
      decision: changedFields.includes("status")
        ? `status_${projectBefore.status || "unknown"}_to_${projectedAfter.status || "unknown"}`
        : "project_fields_updated",
      executionState: projectedAfter.status || null,
      assumptionState: projectedAfter.learning_state || null,
      justification,
      metadata: {
        source,
        changed_fields: changedFields,
      },
      beforeSnapshot: {
        status: projectBefore.status || null,
        learning_state: projectBefore.learning_state || null,
        review_cadence: projectBefore.review_cadence || null,
        impact: projectBefore.impact || null,
        effort: projectBefore.effort || null,
        risk: projectBefore.risk || null,
      },
      afterSnapshot: {
        status: projectedAfter.status || null,
        learning_state: projectedAfter.learning_state || null,
        review_cadence: projectedAfter.review_cadence || null,
        impact: projectedAfter.impact || null,
        effort: projectedAfter.effort || null,
        risk: projectedAfter.risk || null,
      },
    });
  }
}

module.exports = DecisionLogService;
