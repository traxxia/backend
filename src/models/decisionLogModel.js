const { ObjectId } = require("mongodb");
const { getDB } = require("../config/database");

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof ObjectId) return value;
  if (!ObjectId.isValid(value)) return null;
  return new ObjectId(value);
}

function normalizeDate(value, fallback = new Date()) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function normalizeForRead(log) {
  if (!log) return null;

  // Backward compatibility for older decision log documents.
  const actorId = log.actor_id || log.user_id || log.changed_by || null;
  const createdAt = log.created_at || log.changed_at || log.timestamp || new Date();
  const updatedAt = log.updated_at || createdAt;
  const decision =
    log.decision ||
    (log.from_status || log.to_status
      ? `${log.from_status || "Unknown"} -> ${log.to_status || "Unknown"}`
      : "status_change");

  return {
    ...log,
    actor_id: actorId,
    log_type: log.log_type || "status_change",
    decision,
    execution_state: log.execution_state || log.to_status || null,
    assumption_state: log.assumption_state || log.to_learning_state || null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

class DecisionLogModel {
  static collection() {
    return getDB().collection("decision_logs");
  }

  static normalizeCreatePayload(payload = {}) {
    const now = new Date();
    const projectId = toObjectId(payload.project_id);

    if (!projectId) {
      throw new Error("Invalid project_id for decision log creation");
    }

    return {
      project_id: projectId,
      business_id: toObjectId(payload.business_id) || null,
      actor_id: toObjectId(payload.actor_id || payload.user_id || payload.changed_by) || null,
      log_type: payload.log_type || "status_change",
      decision: payload.decision || "status_change",
      execution_state: payload.execution_state || payload.to_status || null,
      assumption_state: payload.assumption_state || payload.to_learning_state || null,
      justification: payload.justification ? String(payload.justification).trim() : "",
      metadata: payload.metadata || {},
      before_snapshot: payload.before_snapshot || {},
      after_snapshot: payload.after_snapshot || {},
      from_status: payload.from_status || null,
      to_status: payload.to_status || null,
      from_learning_state: payload.from_learning_state || null,
      to_learning_state: payload.to_learning_state || null,
      status: payload.status || "active",
      created_at: normalizeDate(payload.created_at, now),
      updated_at: normalizeDate(payload.updated_at, now),
    };
  }

  static async create(payload) {
    const coll = this.collection();
    const doc = this.normalizeCreatePayload(payload);
    const result = await coll.insertOne(doc);
    return result.insertedId;
  }

  static buildProjectQuery(projectId, options = {}) {
    const filter = { project_id: new ObjectId(projectId) };

    if (options.log_type) filter.log_type = options.log_type;
    if (options.execution_state) filter.execution_state = options.execution_state;
    if (options.assumption_state) filter.assumption_state = options.assumption_state;
    if (options.status) filter.status = options.status;
    if (options.actor_id && ObjectId.isValid(options.actor_id)) {
      filter.actor_id = new ObjectId(options.actor_id);
    }

    if (options.from || options.to) {
      filter.created_at = {};
      if (options.from) filter.created_at.$gte = new Date(options.from);
      if (options.to) filter.created_at.$lte = new Date(options.to);
    }

    return filter;
  }

  static async findByProjectId(projectId, options = {}) {
    const parsedLimit = Number(options.limit);
    const parsedSkip = Number(options.skip);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;
    const skip = Number.isFinite(parsedSkip) && parsedSkip > 0 ? parsedSkip : 0;
    const sortField = options.sort_by || "created_at";
    const sortOrder = String(options.sort_order).toLowerCase() === "asc" ? 1 : -1;

    const filter = this.buildProjectQuery(projectId, options);
    const cursor = this.collection()
      .find(filter)
      .sort({ [sortField]: sortOrder, _id: -1 })
      .skip(skip)
      .limit(limit);

    const [logs, total] = await Promise.all([
      cursor.toArray(),
      this.collection().countDocuments(filter),
    ]);

    const payload = {
      logs: logs.map(normalizeForRead),
      total,
      count: logs.length,
      limit,
      skip,
    };

    if (options.returnMeta) {
      return payload;
    }

    return payload.logs;
  }

  static async getTimelineByProjectId(projectId, options = {}) {
    const result = await this.findByProjectId(projectId, {
      ...options,
      sort_by: "created_at",
      sort_order: "desc",
      returnMeta: true,
    });

    const analytics = {
      total_logs: result.total,
      by_type: {},
      by_execution_state: {},
    };

    result.logs.forEach((item) => {
      analytics.by_type[item.log_type] = (analytics.by_type[item.log_type] || 0) + 1;
      const state = item.execution_state || "unknown";
      analytics.by_execution_state[state] = (analytics.by_execution_state[state] || 0) + 1;
    });

    return {
      ...result,
      analytics,
    };
  }

  static async findById(id) {
    if (!ObjectId.isValid(id)) return null;
    const log = await this.collection().findOne({ _id: new ObjectId(id) });
    return normalizeForRead(log);
  }

  static async updateStatus(id, status, actorId = null) {
    if (!ObjectId.isValid(id)) return false;
    const now = new Date();
    const update = {
      status,
      updated_at: now,
    };

    if (actorId && ObjectId.isValid(actorId)) {
      update.updated_by = new ObjectId(actorId);
    }

    const result = await this.collection().updateOne(
      { _id: new ObjectId(id) },
      { $set: update }
    );

    return result.modifiedCount > 0;
  }

  static async createIndexes() {
    await this.collection().createIndexes([
      { key: { project_id: 1, created_at: -1 }, name: "project_timeline_idx" },
      { key: { business_id: 1, created_at: -1 }, name: "business_timeline_idx" },
      { key: { actor_id: 1, created_at: -1 }, name: "actor_timeline_idx" },
      { key: { log_type: 1, created_at: -1 }, name: "type_timeline_idx" },
      {
        key: { project_id: 1, execution_state: 1, created_at: -1 },
        name: "project_execution_idx",
      },
    ]);
  }
}

module.exports = DecisionLogModel;
