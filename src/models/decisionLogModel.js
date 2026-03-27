const { ObjectId } = require("mongodb");
const { getDB } = require("../config/database");

class DecisionLogModel {
    static collection() {
        return getDB().collection("decision_logs");
    }

    static async create(data) {
        const coll = this.collection();
        const result = await coll.insertOne(data);
        return result.insertedId;
    }

    static async findByProjectId(projectId) {
        return await this.collection()
            .find({ project_id: new ObjectId(projectId) })
            .sort({ changed_at: -1 }) 
            .toArray();
    }
}

module.exports = DecisionLogModel;
