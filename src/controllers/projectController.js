const { ObjectId } = require("mongodb");
const ProjectModel = require("../models/projectModel");
const BusinessModel = require("../models/businessModel");

const VALID_STATUS = ["draft", "prioritizing", "prioritized", "launched"];
const ADMIN_ROLES = ["company_admin", "super_admin"];

class ProjectController {
  static async getAll(req, res) {
    try {
      const {
        business_id,
        user_id,
        impact,
        effort,
        risk,
        strategic_theme,
        q,
        status,
      } = req.query;
      const filter = {};
      if (business_id && ObjectId.isValid(business_id))
        filter.business_id = new ObjectId(business_id);
      if (user_id && ObjectId.isValid(user_id))
        filter.user_id = new ObjectId(user_id);
      if (impact) filter.impact = impact;
      if (effort) filter.effort = effort;
      if (risk) filter.risk = risk;
      if (strategic_theme) filter.strategic_theme = strategic_theme;
      if (status) filter.status = status;
      if (q) {
        filter.$or = [
          { project_name: { $regex: q, $options: "i" } },
          { description: { $regex: q, $options: "i" } },
        ];
      }
      const raw = await ProjectModel.findAll(filter);
      const total = await ProjectModel.count(filter);
      const projects = await ProjectModel.populateCreatedBy(raw);
      res.json({ total, count: projects.length, projects });
    } catch (err) {
      console.error("PROJECT GET ALL ERR:", err);
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
      console.error("PROJECT GET BY ID ERR:", err);
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
        status,
      } = req.body;

      if (!business_id || !user_id || !project_name || !status) {
        return res.status(400).json({
          error: "business_id, user_id, project_name and status are required",
        });
      }
      if (!VALID_STATUS.includes(status)) {
        return res.status(400).json({ error: "Invalid status value" });
      }

      const business = await BusinessModel.findById(business_id);
      if (!business)
        return res.status(404).json({ error: "Business not found" });

      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);
      const isCollaborator = (business.collaborators || []).some(
        (id) => id.toString() === req.user._id.toString()
      );

      if (!(isCollaborator || isAdmin)) {
        return res
          .status(403)
          .json({ error: "Not allowed to create project in this business" });
      }

      const data = {
        business_id: new ObjectId(business_id),
        user_id: new ObjectId(user_id),
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
        status,
      };

      const insertedId = await ProjectModel.create(data);
      const raw = await ProjectModel.findById(insertedId);
      const [project] = await ProjectModel.populateCreatedBy(raw);

      res
        .status(201)
        .json({ message: "Project created successfully", project });
    } catch (err) {
      console.error("PROJECT CREATE ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async update(req, res) {
    try {
      const { id } = req.params;
      const updateData = { ...req.body };

      if (!ObjectId.isValid(id))
        return res.status(400).json({ error: "Invalid ID" });

      const existing = await ProjectModel.findById(id);
      if (!existing) return res.status(404).json({ error: "Not found" });

      if (existing.status === "launched") {
        return res.status(403).json({
          error:
            "This project has been launched and cannot be updated anymore.",
        });
      }

      if (updateData.status === "launched") {
        if (!ADMIN_ROLES.includes(req.user.role.role_name)) {
          return res.status(403).json({
            error: "Only company_admin or super_admin can launch projects",
          });
        }
      }

      const business = await BusinessModel.findById(existing.business_id);
      if (!business)
        return res.status(404).json({ error: "Parent business not found" });

      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);
      const isCollaborator = (business.collaborators || []).some(
        (id) => id.toString() === req.user._id.toString()
      );

      if (!(isCollaborator || isAdmin)) {
        return res
          .status(403)
          .json({ error: "Not allowed to update projects for this business" });
      }

      if (updateData.status && !VALID_STATUS.includes(updateData.status)) {
        return res.status(400).json({ error: "Invalid status value" });
      }

      delete updateData._id;
      delete updateData.business_id;
      delete updateData.created_at;

      await ProjectModel.update(id, updateData);
      const updated = await ProjectModel.findById(id);
      res.json({ message: "Project updated successfully", project: updated });
    } catch (err) {
      console.error("PROJECT UPDATE ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async delete(req, res) {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id))
        return res.status(400).json({ error: "Invalid ID" });

      const found = await ProjectModel.findById(id);
      if (!found) return res.status(404).json({ error: "Not found" });

      if (!ADMIN_ROLES.includes(req.user.role.role_name)) {
        return res
          .status(403)
          .json({ error: "Admin access required to delete project" });
      }

      await ProjectModel.delete(id);
      res.json({
        message: "Project deleted successfully",
        deleted: { id, project_name: found.project_name },
      });
    } catch (err) {
      console.error("PROJECT DELETE ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
}

module.exports = ProjectController;
