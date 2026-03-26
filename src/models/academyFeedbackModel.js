const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

class AcademyFeedbackModel {
    static async create(feedbackData) {
        const db = getDB();

        // Ensure userId is stored as ObjectId if present
        if (feedbackData.userId && typeof feedbackData.userId === 'string') {
            try {
                feedbackData.userId = new ObjectId(feedbackData.userId);
            } catch (e) {
                // Handle invalid ObjectId
            }
        }

        const result = await db.collection('academy_feedbacks').insertOne({
            ...feedbackData,
            created_at: new Date(),
            updated_at: new Date()
        });

        return result.insertedId;
    }

    static async getAll(filter = {}) {
        const db = getDB();

        return await db.collection('academy_feedbacks').aggregate([
            { $match: filter },
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'user'
                }
            },
            {
                $unwind: {
                    path: '$user',
                    preserveNullAndEmptyArrays: true
                }
            },
            {
                $project: {
                    _id: 1,
                    articleId: 1,
                    helpful: 1,
                    feedback: 1,
                    created_at: 1,
                    updated_at: 1,
                    userId: 1,
                    userName: '$user.name'
                }
            },
            { $sort: { created_at: -1 } }
        ]).toArray();
    }
}

module.exports = AcademyFeedbackModel;
