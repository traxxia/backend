const { ObjectId } = require("mongodb");
const InitiativeModel = require("../models/initiativeModel");

const VALID_TYPES = ["Immediate", "Short-term", "Long-term"];
const VALID_STATUSES = ["Draft", "Approved", "Rejected"];

class InitiativeController {
  static async getAll(req, res) {
    try {
      const { type, status, phase, business_id, user_id } = req.query;
      const filter = {};

      if (business_id && ObjectId.isValid(business_id))
        filter.business_id = new ObjectId(business_id);
      if (user_id && ObjectId.isValid(user_id))
        filter.user_id = new ObjectId(user_id);
      if (type) filter.type = type;
      if (status) filter.status = status;
      if (phase) filter.phase = phase;

      const raw = await InitiativeModel.findAll(filter);
      const total = await InitiativeModel.count(filter);

      const initiatives = await InitiativeModel.populateCreatedBy(raw);

      res.json({
        initiatives,
        filters_applied: { type, status, phase, business_id, user_id },
        total,
        count: initiatives.length,
      });
    } catch (err) {
      console.error("GET ALL error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async getById(req, res) {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id))
        return res.status(400).json({ error: "Invalid initiative ID" });

      const raw = await InitiativeModel.findById(id);
      if (!raw) return res.status(404).json({ error: "Initiative not found" });

      const [initiative] = await InitiativeModel.populateCreatedBy(raw);

      res.json({ initiative });
    } catch (err) {
      console.error("GET BY ID error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async create(req, res) {
    try {
      const {
        business_id,
        user_id,
        type,
        initiative,
        tags = [],
        phase = "initial",
        status = "Draft",
        rationale,
        timeline,
        resources_required,
        success_metrics,
        strategic_pillar,
        expected_outcome,
        risk_mitigation,
        transformation_required,
        competitive_advantage,
        sustainability,
      } = req.body;

      // Required fields
      if (!business_id || !user_id || !type || !initiative) {
        return res.status(400).json({
          error: "business_id, user_id, type, and initiative are required",
        });
      }

      if (!ObjectId.isValid(business_id) || !ObjectId.isValid(user_id)) {
        return res
          .status(400)
          .json({ error: "Invalid business_id or user_id" });
      }

      if (!VALID_TYPES.includes(type)) {
        return res.status(400).json({
          error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`,
        });
      }

      if (!Array.isArray(tags)) {
        return res
          .status(400)
          .json({ error: "tags must be an array of strings" });
      }

      const data = {
        business_id: new ObjectId(business_id),
        user_id: new ObjectId(user_id),
        type,
        initiative: initiative.trim(),
        tags,
        phase,
        status,
        rationale: rationale || null,
        timeline: timeline || null,
        resources_required: Array.isArray(resources_required)
          ? resources_required
          : null,
        success_metrics: Array.isArray(success_metrics)
          ? success_metrics
          : null,
        strategic_pillar: strategic_pillar || null,
        expected_outcome: expected_outcome || null,
        risk_mitigation: risk_mitigation || null,
        transformation_required: transformation_required || null,
        competitive_advantage: competitive_advantage || null,
        sustainability: sustainability || null,
      };

      const insertedId = await InitiativeModel.create(data);
      const raw = await InitiativeModel.findById(insertedId);
      const [initiativeObj] = await InitiativeModel.populateCreatedBy(raw);

      res.status(201).json({
        message: "Initiative created successfully",
        initiative: initiativeObj,
      });
    } catch (err) {
      console.error("CREATE error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async update(req, res) {
    try {
      const { id } = req.params;
      const updateData = req.body;
      if (!ObjectId.isValid(id))
        return res.status(400).json({ error: "Invalid ID" });

      delete updateData._id;
      delete updateData.business_id;
      delete updateData.created_at;

      if (updateData.type && !VALID_TYPES.includes(updateData.type))
        return res.status(400).json({ error: `Invalid type` });

      if (updateData.status && !VALID_STATUSES.includes(updateData.status))
        return res.status(400).json({ error: `Invalid status` });

      if (updateData.resources_required !== undefined)
        updateData.resources_required = Array.isArray(
          updateData.resources_required
        )
          ? updateData.resources_required
          : null;
      if (updateData.success_metrics !== undefined)
        updateData.success_metrics = Array.isArray(updateData.success_metrics)
          ? updateData.success_metrics
          : null;

      const result = await InitiativeModel.update(id, updateData);
      if (result.matchedCount === 0)
        return res.status(404).json({ error: "Not found" });

      const updated = await InitiativeModel.findById(id);

      res.json({
        message: "Initiative updated successfully",
        initiative: updated,
      });
    } catch (err) {
      console.error("UPDATE error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async delete(req, res) {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id))
        return res.status(400).json({ error: "Invalid ID" });

      const doc = await InitiativeModel.findById(id);
      if (!doc) return res.status(404).json({ error: "Not found" });

      await InitiativeModel.delete(id);

      res.json({
        message: "Initiative deleted successfully",
        deleted: {
          id,
          type: doc.type,
          status: doc.status,
        },
      });
    } catch (err) {
      console.error("DELETE error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
}

module.exports = InitiativeController;
