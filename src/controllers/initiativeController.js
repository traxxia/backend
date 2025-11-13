const { ObjectId } = require("mongodb");
const InitiativeModel = require("../models/initiativeModel");

const VALID_TYPES = [
  "Immediate Actions",
  "Short-term Initiatives",
  "Long-term Strategic Shifts",
];
const VALID_STATUSES = ["Draft", "Approved", "Rejected"];

class InitiativeController {
  static async getAll(req, res) {
    try {
      const { type, status, phase, company_id, user_id } = req.query;
      const filter = {};

      if (company_id) {
        if (!ObjectId.isValid(company_id)) {
          return res.status(400).json({ error: "Invalid company_id format" });
        }
        filter.company_id = new ObjectId(company_id);
      }

      if (user_id) {
        if (!ObjectId.isValid(user_id)) {
          return res.status(400).json({ error: "Invalid user_id format" });
        }
        filter.user_id = new ObjectId(user_id);
      }

      if (type) filter.type = type;
      if (status) filter.status = status;
      if (phase) filter.phase = phase;

      const initiatives = await InitiativeModel.findAll(filter);
      const total = await InitiativeModel.count(filter);

      res.json({
        initiatives,
        filters_applied: { type, status, phase, company_id, user_id },
        total,
        count: initiatives.length,
        message:
          initiatives.length === 0
            ? "No initiatives found matching filters"
            : undefined,
      });
    } catch (error) {
      console.error("Failed to fetch initiatives:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  static async getById(req, res) {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid initiative ID" });
      }

      const initiative = await InitiativeModel.findById(id);
      if (!initiative) {
        return res.status(404).json({ error: "Initiative not found" });
      }

      res.json({ initiative });
    } catch (error) {
      console.error("Failed to fetch initiative:", error);
      res.status(500).json({ error: "Failed to fetch initiative" });
    }
  }

  static async create(req, res) {
    try {
      const {
        company_id,
        user_id,
        type,
        phase = "initial",
        status = "Draft",
        action,
        rationale,
        timeline,
        resources_required,
        success_metrics,
        initiative,
        strategic_pillar,
        expected_outcome,
        risk_mitigation,
        shift,
        transformation_required,
        competitive_advantage,
        sustainability,
      } = req.body;

      if (!company_id || !user_id || !type) {
        return res.status(400).json({
          error: "company_id, user_id, and type are required",
        });
      }

      if (!ObjectId.isValid(company_id) || !ObjectId.isValid(user_id)) {
        return res.status(400).json({ error: "Invalid company_id or user_id" });
      }

      if (!VALID_TYPES.includes(type)) {
        return res.status(400).json({
          error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`,
        });
      }

      if (status && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
        });
      }

      const initiativeData = {
        company_id: new ObjectId(company_id),
        user_id: new ObjectId(user_id),
        type,
        phase,
        status: status || "Draft",
        action: action || null,
        rationale: rationale || null,
        timeline: timeline || null,
        resources_required: Array.isArray(resources_required)
          ? resources_required
          : null,
        success_metrics: Array.isArray(success_metrics)
          ? success_metrics
          : null,
        initiative: initiative || null,
        strategic_pillar: strategic_pillar || null,
        expected_outcome: expected_outcome || null,
        risk_mitigation: risk_mitigation || null,
        shift: shift || null,
        transformation_required: transformation_required || null,
        competitive_advantage: competitive_advantage || null,
        sustainability: sustainability || null,
      };

      const insertedId = await InitiativeModel.create(initiativeData);

      res.status(201).json({
        message: "Initiative created successfully",
        initiative_id: insertedId.toString(),
      });
    } catch (error) {
      console.error("Failed to create initiative:", error);
      res.status(500).json({ error: "Failed to create initiative" });
    }
  }

  static async update(req, res) {
    try {
      const { id } = req.params;
      const updateData = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid initiative ID" });
      }

      // Prevent updating _id, company_id, created_at
      delete updateData._id;
      delete updateData.company_id;
      delete updateData.created_at;

      if (updateData.type && !VALID_TYPES.includes(updateData.type)) {
        return res.status(400).json({
          error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`,
        });
      }

      if (updateData.status && !VALID_STATUSES.includes(updateData.status)) {
        return res.status(400).json({
          error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
        });
      }

      if (updateData.resources_required !== undefined) {
        updateData.resources_required = Array.isArray(
          updateData.resources_required
        )
          ? updateData.resources_required
          : null;
      }
      if (updateData.success_metrics !== undefined) {
        updateData.success_metrics = Array.isArray(updateData.success_metrics)
          ? updateData.success_metrics
          : null;
      }

      const result = await InitiativeModel.update(id, updateData);

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "Initiative not found" });
      }

      if (result.modifiedCount === 0) {
        return res.status(200).json({ message: "No changes made" });
      }

      const updated = await InitiativeModel.findById(id);

      res.json({
        message: "Initiative updated successfully",
        initiative: updated,
      });
    } catch (error) {
      console.error("Failed to update initiative:", error);
      res.status(500).json({ error: "Failed to update initiative" });
    }
  }

  static async delete(req, res) {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid initiative ID" });
      }

      const initiative = await InitiativeModel.findById(id);
      if (!initiative) {
        return res.status(404).json({ error: "Initiative not found" });
      }

      const result = await InitiativeModel.delete(id);

      if (result.deletedCount === 0) {
        return res.status(500).json({ error: "Failed to delete initiative" });
      }

      res.json({
        message: "Initiative deleted successfully",
        deleted_initiative: {
          id: id,
          type: initiative.type,
          status: initiative.status,
        },
      });
    } catch (error) {
      console.error("Failed to delete initiative:", error);
      res.status(500).json({ error: "Failed to delete initiative" });
    }
  }
}

module.exports = InitiativeController;
