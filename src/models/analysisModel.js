const { ObjectId } = require("mongodb");
const { getDB } = require("../config/database");

class AnalysisModel {
  static collection() {
    return getDB().collection("analysis");
  }

  static async create(analysisData) {
    const { business_id } = analysisData;
    const result = await this.collection().insertOne({
      ...analysisData,
      business_id: new ObjectId(business_id),
      created_at: new Date(),
      updated_at: new Date()
    });
    return result.insertedId;
  }

  static async update(businessId, analysisType, updateData) {
    return await this.collection().updateOne(
      { 
        business_id: new ObjectId(businessId),
        analysis_type: analysisType
      },
      {
        $set: {
          ...updateData,
          updated_at: new Date()
        }
      }
    );
  }

  static async findByType(businessId, analysisType) {
    return await this.collection().findOne({
      business_id: new ObjectId(businessId),
      analysis_type: analysisType
    });
  }

  static async getAll(businessId) {
    return await this.collection()
      .find({ business_id: new ObjectId(businessId) })
      .sort({ created_at: -1 })
      .toArray();
  }

  static async getByPhase(businessId, phase) {
    return await this.collection()
      .find({ 
        business_id: new ObjectId(businessId),
        phase: phase
      })
      .sort({ created_at: -1 })
      .toArray();
  }

  static async getByFilter(businessId, filter = {}) {
    // filter can contain analysis_type, analysis_name, or both
    const query = {
      business_id: new ObjectId(businessId),
      ...filter
    };
    
    return await this.collection()
      .find(query)
      .sort({ created_at: -1 })
      .toArray();
  }
}

module.exports = AnalysisModel;
