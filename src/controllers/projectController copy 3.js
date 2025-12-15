const { ObjectId } = require("mongodb");
const ProjectModel = require("../models/projectModel");
const BusinessModel = require("../models/businessModel");

const VALID_STATUS = ["draft", "prioritizing", "prioritized", "launched"];
const ADMIN_ROLES = ["company_admin", "super_admin"];

// Normalize string fields
function normalizeString(value) {
  return typeof value === "string" ? value : "";
}

// Normalize budget_estimate for Mongo validation
function normalizeBudget(value) {
  if (value === "" || value === undefined || value === null) {
    return null;
  }
  const num = Number(value);
  return isNaN(num) ? null : num;
}

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

      // Required fields
      if (!business_id || !project_name || !status) {
        return res.status(400).json({
          error: "business_id, project_name and status are required",
        });
      }

      if (!VALID_STATUS.includes(status)) {
        return res.status(400).json({ error: "Invalid status value" });
      }

      // Check business exists
      const business = await BusinessModel.findById(business_id);
      if (!business)
        return res.status(404).json({ error: "Business not found" });

      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);
      const isCollaborator = (business.collaborators || []).some(
        (id) => id.toString() === req.user._id.toString()
      );
      const isOwner = business.user_id.toString() === req.user._id.toString();

      if (!(isAdmin || isCollaborator || isOwner)) {
        return res.status(403).json({
          error: "Not allowed to create project in this business",
        });
      }

      // Normalize fields for MongoDB validation
      const data = {
        business_id: new ObjectId(business_id),
        user_id: new ObjectId(req.user._id),
        project_name: project_name.trim(),
        description: normalizeString(description),
        why_this_matters: normalizeString(why_this_matters),
        impact: normalizeString(impact),
        effort: normalizeString(effort),
        risk: normalizeString(risk),
        strategic_theme: normalizeString(strategic_theme),
        dependencies: normalizeString(dependencies),
        high_level_requirements: normalizeString(high_level_requirements),
        scope_definition: normalizeString(scope_definition),
        expected_outcome: normalizeString(expected_outcome),
        success_metrics: normalizeString(success_metrics),
        estimated_timeline: normalizeString(estimated_timeline),
        budget_estimate: normalizeBudget(budget_estimate),
        status,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const insertedId = await ProjectModel.create(data);
      const raw = await ProjectModel.findById(insertedId);
      const [project] = await ProjectModel.populateCreatedBy(raw);

      res.status(201).json({
        message: "Project created successfully",
        project,
      });
    } catch (err) {
      console.error("PROJECT CREATE ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async update(req, res) {
    try {
      const { id } = req.params;

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

      if (req.body.status === "launched") {
        if (!ADMIN_ROLES.includes(req.user.role.role_name)) {
          return res.status(403).json({
            error: "Only company_admin or super_admin can launch projects",
          });
        }
      }

      // Check access
      const business = await BusinessModel.findById(existing.business_id);
      if (!business)
        return res.status(404).json({ error: "Parent business not found" });

      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);
      const isCollaborator = (business.collaborators || []).some(
        (id) => id.toString() === req.user._id.toString()
      );
      const isOwner = business.user_id.toString() === req.user._id.toString();

      if (!(isAdmin || isCollaborator || isOwner)) {
        return res.status(403).json({
          error: "Not allowed to update projects for this business",
        });
      }

      if (req.body.status && !VALID_STATUS.includes(req.body.status)) {
        return res.status(400).json({ error: "Invalid status value" });
      }

      // Normalize update fields
      const updateData = {
        description: normalizeString(req.body.description),
        why_this_matters: normalizeString(req.body.why_this_matters),
        impact: normalizeString(req.body.impact),
        effort: normalizeString(req.body.effort),
        risk: normalizeString(req.body.risk),
        strategic_theme: normalizeString(req.body.strategic_theme),
        dependencies: normalizeString(req.body.dependencies),
        high_level_requirements: normalizeString(
          req.body.high_level_requirements
        ),
        scope_definition: normalizeString(req.body.scope_definition),
        expected_outcome: normalizeString(req.body.expected_outcome),
        success_metrics: normalizeString(req.body.success_metrics),
        estimated_timeline: normalizeString(req.body.estimated_timeline),
        budget_estimate: normalizeBudget(req.body.budget_estimate),
        updated_at: new Date(),
      };

      if (req.body.status) updateData.status = req.body.status;

      delete updateData._id;
      delete updateData.business_id;
      delete updateData.created_at;

      await ProjectModel.update(id, updateData);

      const updated = await ProjectModel.findById(id);
      res.json({
        message: "Project updated successfully",
        project: updated,
      });
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
        return res.status(403).json({
          error: "Admin access required to delete project",
        });
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
