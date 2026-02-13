const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

class AiHistoryModel {
    static collection() {
        return getDB().collection('ai_chat_history');
    }

    static async create(chatData) {
        const coll = this.collection();
        const result = await coll.insertOne({
            ...chatData,
            project_id: new ObjectId(chatData.project_id),
            user_id: new ObjectId(chatData.user_id),
            created_at: new Date(),
            updated_at: new Date()
        });
        return result.insertedId;
    }

    static async findByProjectAndUser(projectId, userId) {
        const coll = this.collection();
        return await coll
            .find({
                project_id: new ObjectId(projectId),
                user_id: new ObjectId(userId)
            })
            .sort({ created_at: 1 })
            .toArray();
    }

    static async deleteByProjectId(projectId) {
        const coll = this.collection();
        return await coll.deleteMany({ project_id: new ObjectId(projectId) });
    }
}

module.exports = AiHistoryModel;
