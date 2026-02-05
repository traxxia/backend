const AnalysisModel = require("../models/analysisModel");
const BusinessModel = require("../models/businessModel");
const { ObjectId } = require("mongodb");

class AnalysisController {
  
  static async create(req, res) {
    try {
      const { business_id, phase, analysis_type, analysis_name, analysis_data } = req.body;

      if (!business_id || !phase || !analysis_type || !analysis_name) {
        return res.status(400).json({ 
          success: false, 
          error: "Missing required fields: business_id, phase, analysis_type, analysis_name" 
        });
      }
      
      if (!ObjectId.isValid(business_id)) {
        return res.status(400).json({ success: false, error: "Invalid business_id format" });
      }

      // Check if business exists
      const business = await BusinessModel.findById(business_id);
      if (!business) {
        return res.status(404).json({ success: false, error: "Business not found" });
      }

      // Check if analysis of this type already exists for this business
      const existingAnalysis = await AnalysisModel.findByType(business_id, analysis_type);

      if (existingAnalysis) {
        // Update existing analysis
        await AnalysisModel.update(business_id, analysis_type, {
          phase,
          analysis_name,
          analysis_data: analysis_data || {}
        });

        return res.status(200).json({
          success: true,
          message: "Analysis updated successfully",
          id: existingAnalysis._id,
          is_update: true
        });
      } else {
        // Create new analysis
        const newId = await AnalysisModel.create({
          business_id,
          phase,
          analysis_type,
          analysis_name,
          analysis_data: analysis_data || {}
        });

        return res.status(201).json({
          success: true,
          message: "Analysis created successfully",
          id: newId,
          is_update: false
        });
      }

    } catch (error) {
      console.error("Create/Update analysis error:", error);
      res.status(500).json({ success: false, error: "Failed to process analysis" });
    }
  }

  static async getAll(req, res) {
    try {
      const { businessId } = req.params;
      
      if (!ObjectId.isValid(businessId)) {
        return res.status(400).json({ success: false, error: "Invalid business_id format" });
      }

      // Check if business exists
      const business = await BusinessModel.findById(businessId);
      if (!business) {
        return res.status(404).json({ success: false, error: "Business not found" });
      }

      const data = await AnalysisModel.getAll(businessId);
      
      res.json({
        success: true,
        count: data.length,
        data
      });
    } catch (error) {
      console.error("Get all analysis error:", error);
      res.status(500).json({ success: false, error: "Failed to fetch analysis data" });
    }
  }

  static async getByPhase(req, res) {
    try {
      const { businessId, phase } = req.params;

      if (!ObjectId.isValid(businessId)) {
        return res.status(400).json({ success: false, error: "Invalid business_id format" });
      }

      // Check if business exists
      const business = await BusinessModel.findById(businessId);
      if (!business) {
        return res.status(404).json({ success: false, error: "Business not found" });
      }

      const data = await AnalysisModel.getByPhase(businessId, phase);

      res.json({
        success: true,
        count: data.length,
        data
      });
    } catch (error) {
      console.error("Get by phase analysis error:", error);
      res.status(500).json({ success: false, error: "Failed to fetch analysis data by phase" });
    }
  }

  static async getByFilter(req, res) {
    try {
      const { businessId } = req.params;
      const { type, name } = req.query; // query params: type=foo&name=bar

      if (!ObjectId.isValid(businessId)) {
        return res.status(400).json({ success: false, error: "Invalid business_id format" });
      }

      // Check if business exists
      const business = await BusinessModel.findById(businessId);
      if (!business) {
        return res.status(404).json({ success: false, error: "Business not found" });
      }

      const filter = {};
      if (type) filter.analysis_type = type;
      if (name) filter.analysis_name = name;

      const data = await AnalysisModel.getByFilter(businessId, filter);

      res.json({
        success: true,
        count: data.length,
        data
      });
    } catch (error) {
      console.error("Get by filter analysis error:", error);
      res.status(500).json({ success: false, error: "Failed to fetch analysis data by filter" });
    }
  }
}

module.exports = AnalysisController;
