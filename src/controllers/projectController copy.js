const { ObjectId } = require("mongodb");
const ProjectModel = require("../models/projectModel");

class ProjectController {
  static async getAll(req, res) {
    try {
      const { business_id, user_id, impact, effort, risk, strategic_theme, q } =
        req.query;

      const filter = {};

      if (business_id && ObjectId.isValid(business_id))
        filter.business_id = new ObjectId(business_id);
      if (user_id && ObjectId.isValid(user_id))
        filter.user_id = new ObjectId(user_id);

      if (impact) filter.impact = impact;
      if (effort) filter.effort = effort;
      if (risk) filter.risk = risk;
      if (strategic_theme) filter.strategic_theme = strategic_theme;

      if (q && typeof q === "string") {
        filter.$or = [
          { project_name: { $regex: q, $options: "i" } },
          { description: { $regex: q, $options: "i" } },
        ];
      }

      const raw = await ProjectModel.findAll(filter);
      const total = await ProjectModel.count(filter);
      const projects = await ProjectModel.populateCreatedBy(raw);

      res.json({
        projects,
        filters_applied: {
          business_id,
          user_id,
          impact,
          effort,
          risk,
          strategic_theme,
          q,
        },
        total,
        count: projects.length,
      });
    } catch (err) {
      console.error("PROJECT GET ALL error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async getById(req, res) {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id))
        return res.status(400).json({ error: "Invalid project ID" });

      const raw = await ProjectModel.findById(id);
      if (!raw) return res.status(404).json({ error: "Project not found" });

      const [project] = await ProjectModel.populateCreatedBy(raw);
      res.json({ project });
    } catch (err) {
      console.error("PROJECT GET BY ID error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async create(req, res) {
    try {
      const {
        business_id,
        user_id,
        project_name,
        description,
        why_this_matters,
        impact,
        effort,
        risk,
        strategic_theme,
        dependencies,
        high_level_requirements,
        scope_definition,
        expected_outcome,
        success_metrics,
        estimated_timeline,
        budget_estimate,
      } = req.body;

      if (!business_id || !user_id || !project_name) {
        return res.status(400).json({
          error: "business_id, user_id and project_name are required",
        });
      }

      if (!ObjectId.isValid(business_id) || !ObjectId.isValid(user_id)) {
        return res
          .status(400)
          .json({ error: "Invalid business_id or user_id" });
      }

      const data = {
        business_id: new ObjectId(business_id),
        user_id: new ObjectId(user_id),

        collaborators: [],

        project_name: project_name.trim(),
        description: description || null,
        why_this_matters: why_this_matters || null,
        impact: impact || null,
        effort: effort || null,
        risk: risk || null,
        strategic_theme: strategic_theme || null,
        dependencies: dependencies || null,
        high_level_requirements: high_level_requirements || null,
        scope_definition: scope_definition || null,
        expected_outcome: expected_outcome || null,
        success_metrics: success_metrics || null,
        estimated_timeline: estimated_timeline || null,
        budget_estimate: budget_estimate || null,
      };

      const insertedId = await ProjectModel.create(data);
      const raw = await ProjectModel.findById(insertedId);
      const [project] = await ProjectModel.populateCreatedBy(raw);

      res
        .status(201)
        .json({ message: "Project created successfully", project });
    } catch (err) {
      console.error("PROJECT CREATE error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async update(req, res) {
    try {
      const { id } = req.params;
      const updateData = { ...req.body };

      if (!ObjectId.isValid(id))
        return res.status(400).json({ error: "Invalid ID" });

      delete updateData._id;
      delete updateData.business_id;
      delete updateData.created_at;

      // normalize collaborators if present
      if (updateData.collaborators !== undefined) {
        updateData.collaborators = Array.isArray(updateData.collaborators)
          ? updateData.collaborators
              .filter(Boolean)
              .map((c) => (ObjectId.isValid(c) ? new ObjectId(c) : null))
              .filter(Boolean)
          : [];
      }

      // trim project_name if provided
      if (
        updateData.project_name &&
        typeof updateData.project_name === "string"
      ) {
        updateData.project_name = updateData.project_name.trim();
      }

      const result = await ProjectModel.update(id, updateData);
      if (result.matchedCount === 0)
        return res.status(404).json({ error: "Not found" });

      const updated = await ProjectModel.findById(id);
      res.json({ message: "Project updated successfully", project: updated });
    } catch (err) {
      console.error("PROJECT UPDATE error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async delete(req, res) {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id))
        return res.status(400).json({ error: "Invalid ID" });

      const doc = await ProjectModel.findById(id);
      if (!doc) return res.status(404).json({ error: "Not found" });

      await ProjectModel.delete(id);

      res.json({
        message: "Project deleted successfully",
        deleted: {
          id,
          project_name: doc.project_name,
        },
      });
    } catch (err) {
      console.error("PROJECT DELETE error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
}

module.exports = ProjectController;
