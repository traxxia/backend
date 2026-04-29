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
  const logType = log.log_type || "status_change";
  const decision =
    log.decision ||
    (log.from_status || log.to_status
      ? `${log.from_status || "Unknown"} -> ${log.to_status || "Unknown"}`
      : logType);

  return {
    ...log,
    actor_id: actorId,
    log_type: logType,
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
      decision: payload.decision || payload.log_type || "status_change",
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

  /**
   * Cross-project query scoped to a business.
   * Used by the "All Decision Logs" tab.
   */
  static async findByBusinessId(businessId, options = {}) {
    const parsedLimit = Number(options.limit);
    const parsedSkip = Number(options.skip);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;
    const skip = Number.isFinite(parsedSkip) && parsedSkip > 0 ? parsedSkip : 0;
    const sortOrder = String(options.sort_order || "").toLowerCase() === "asc" ? 1 : -1;

    const match = { business_id: new ObjectId(businessId) };
    if (options.project_id && ObjectId.isValid(options.project_id)) {
      match.project_id = new ObjectId(options.project_id);
    }
    if (options.log_type) match.log_type = options.log_type;
    if (options.execution_state) match.execution_state = options.execution_state;
    if (options.status) match.status = options.status;
    if (options.from || options.to) {
      match.created_at = {};
      if (options.from) match.created_at.$gte = new Date(options.from);
      if (options.to) match.created_at.$lte = new Date(options.to);
    }

    const pipeline = [
      { $match: match },
      { $sort: { created_at: sortOrder, _id: -1 } },
      {
        $facet: {
          data: [
            { $skip: skip },
            { $limit: limit },
            {
              $lookup: {
                from: "projects",
                localField: "project_id",
                foreignField: "_id",
                as: "_project",
              },
            },
            {
              $lookup: {
                from: "users",
                localField: "actor_id",
                foreignField: "_id",
                as: "_actor",
              },
            },
            {
              $addFields: {
                project_name: { $arrayElemAt: ["$_project.project_name", 0] },
                actor_name: {
                  $let: {
                    vars: { actor: { $arrayElemAt: ["$_actor", 0] } },
                    in: {
                      $cond: [
                        { $ifNull: ["$$actor", false] },
                        {
                          $cond: [
                            { $and: [
                              { $eq: [{ $ifNull: ["$$actor.first_name", ""] }, ""] },
                              { $eq: [{ $ifNull: ["$$actor.last_name", ""] }, ""] }
                            ] },
                            { $ifNull: ["$$actor.name", "Unknown"] },
                            {
                              $trim: {
                                input: {
                                  $concat: [
                                    { $ifNull: ["$$actor.first_name", ""] },
                                    " ",
                                    { $ifNull: ["$$actor.last_name", ""] },
                                  ]
                                }
                              }
                            }
                          ]
                        },
                        "Unknown",
                      ],
                    },
                  },
                },
              },
            },
            { $project: { _project: 0, _actor: 0 } },
          ],
          total: [{ $count: "count" }],
        },
      },
    ];

    const [result] = await this.collection().aggregate(pipeline).toArray();
    const logs = (result.data || []).map(normalizeForRead);
    const total = result.total?.[0]?.count || 0;

    return { logs, total, count: logs.length, limit, skip };
  }

  static async getBusinessFilterOptions(businessId) {
    if (!ObjectId.isValid(businessId)) return { log_types: [], execution_states: [] };
    const match = { business_id: new ObjectId(businessId) };
    const [log_types, execution_states, to_statuses] = await Promise.all([
      this.collection().distinct("log_type", match),
      this.collection().distinct("execution_state", match),
      this.collection().distinct("to_status", match)
    ]);
    
    const combined_states = Array.from(new Set([...execution_states, ...to_statuses].filter(Boolean)));
    
    return {
      log_types: log_types.filter(Boolean),
      execution_states: combined_states
    };
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
