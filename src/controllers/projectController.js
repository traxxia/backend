const { ObjectId } = require("mongodb");
const ProjectModel = require("../models/projectModel");
const BusinessModel = require("../models/businessModel");

const VALID_STATUS = ["draft", "prioritizing", "prioritized", "launched"];
const ADMIN_ROLES = ["company_admin", "super_admin"];

// Permission matrix for ALL project actions
function getProjectPermissions({
  businessStatus,
  isOwner,
  isCollaborator,
  isAdmin,
}) {
  switch (businessStatus) {
    case "draft":
      return {
        canCreate: isAdmin || isCollaborator,
        canEdit: isAdmin || isCollaborator,
      };
    case "prioritizing":
      return {
        canCreate: false,
        canEdit: isAdmin || isCollaborator,
      };

    case "prioritized":
      return {
        canCreate: false,
        canEdit: isAdmin || isCollaborator,
      };

    // fully locked
    case "launched":
      return {
        canCreate: false,
        canEdit: false,
      };

    default:
      return { canCreate: false, canEdit: false };
  }
}

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
      } = req.body;

      // Required fields
      if (!business_id || !project_name) {
        return res.status(400).json({
          error: "business_id and project_name required",
        });
      }

      if (!VALID_STATUS.includes(status)) {
        return res.status(400).json({ error: "Invalid status value" });
      }

      // Check business
      const business = await BusinessModel.findById(business_id);
      if (!business)
        return res.status(404).json({ error: "Business not found" });

      // Permission
      const isOwner = business.user_id.toString() === req.user._id.toString();
      const isCollaborator = business.collaborators?.some(
        (id) => id.toString() === req.user._id.toString()
      );
      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);

      // NOTE: Owner alone cannot work on projects unless also collaborator
      const permissions = getProjectPermissions({
        businessStatus: business.status,
        isOwner,
        isCollaborator,
        isAdmin,
      });

      if (!permissions.canCreate) {
        return res.status(403).json({
          error: `You cannot create a project when business is in '${business.status}' state`,
        });
      }

      if (!(isAdmin || isCollaborator)) {
        return res.status(403).json({
          error: "Only collaborators or admins can create or edit projects",
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
        budget_estimate:
          budget_estimate === "" ||
          budget_estimate === null ||
          budget_estimate === undefined
            ? ""
            : String(Number(budget_estimate)),
        status: "draft",
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

      const isOwner = business.user_id.toString() === req.user._id.toString();
      const isCollaborator = business.collaborators?.some(
        (id) => id.toString() === req.user._id.toString()
      );
      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);

      const permissions = getProjectPermissions({
        businessStatus: business.status,
        isOwner,
        isCollaborator,
        isAdmin,
      });

      if (!permissions.canEdit) {
        return res.status(403).json({
          error: `You cannot edit projects when business is in '${business.status}' state`,
        });
      }

      if (req.body.status && !VALID_STATUS.includes(req.body.status)) {
        return res.status(400).json({ error: "Invalid status value" });
      }

      // === FIXED: Normalize fields safely for strict string-only schema ===
      const updateData = {
        updated_at: new Date(),
      };

      // Only include fields if they are provided and valid
      if (req.body.description !== undefined)
        updateData.description = normalizeString(req.body.description);

      if (req.body.why_this_matters !== undefined)
        updateData.why_this_matters = normalizeString(
          req.body.why_this_matters
        );

      if (req.body.impact !== undefined)
        updateData.impact = normalizeString(req.body.impact);

      if (req.body.effort !== undefined)
        updateData.effort = normalizeString(req.body.effort);

      if (req.body.risk !== undefined)
        updateData.risk = normalizeString(req.body.risk);

      if (req.body.strategic_theme !== undefined)
        updateData.strategic_theme = normalizeString(req.body.strategic_theme);

      if (req.body.dependencies !== undefined)
        updateData.dependencies = normalizeString(req.body.dependencies);

      if (req.body.high_level_requirements !== undefined)
        updateData.high_level_requirements = normalizeString(
          req.body.high_level_requirements
        );

      if (req.body.scope_definition !== undefined)
        updateData.scope_definition = normalizeString(
          req.body.scope_definition
        );

      if (req.body.expected_outcome !== undefined)
        updateData.expected_outcome = normalizeString(
          req.body.expected_outcome
        );

      if (req.body.success_metrics !== undefined)
        updateData.success_metrics = normalizeString(req.body.success_metrics);

      if (req.body.estimated_timeline !== undefined)
        updateData.estimated_timeline = normalizeString(
          req.body.estimated_timeline
        );

      //budget_estimate must ALWAYS be a string (never null)
      if (req.body.budget_estimate !== undefined) {
        const budget = req.body.budget_estimate;
        if (budget === "" || budget === null || budget === undefined) {
          updateData.budget_estimate = ""; // empty string is acceptable as "no budget set"
        } else {
          const num = Number(budget);
          updateData.budget_estimate = isNaN(num) ? "" : String(num);
        }
      }

      if (req.body.status) {
        updateData.status = req.body.status;
      }

      delete updateData._id;
      delete updateData.business_id;
      delete updateData.created_at;
      await ProjectModel.update(id, updateData);

      const updated = await ProjectModel.findById(id);
      const [project] = await ProjectModel.populateCreatedBy(updated);

      res.json({
        message: "Project updated successfully",
        project,
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
