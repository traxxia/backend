const AcademyFeedbackModel = require('../models/academyFeedbackModel');
const { ObjectId } = require('mongodb');

exports.submitFeedback = async (req, res) => {
    try {
        const { articleId, helpful, feedback, userId } = req.body;

        if (!articleId || helpful === undefined) {
            return res.status(400).json({ success: false, message: 'articleId and helpful fields are required' });
        }

        if (feedback && feedback.trim().length > 0 && feedback.trim().length < 10) {
            return res.status(400).json({ success: false, message: 'Feedback must be at least 10 characters long' });
        }

        if (feedback && feedback.trim().length > 0 && !/[A-Za-z]/.test(feedback)) {
            return res.status(400).json({ success: false, message: 'Feedback must contain at least one letter' });
        }

        const newFeedback = {
            articleId,
            helpful,
            feedback: feedback ? feedback.trim() : ""
        };

        if (userId) {
            newFeedback.userId = userId;
        }

        const insertedId = await AcademyFeedbackModel.create(newFeedback);

        res.status(201).json({
            success: true,
            message: 'Feedback submitted successfully',
            data: {
                _id: insertedId,
                ...newFeedback,
                created_at: new Date(),
                updated_at: new Date()
            }
        });
    } catch (error) {
        console.error('Error submitting feedback:', error);
        res.status(500).json({ success: false, message: 'Server error while submitting feedback' });
    }
};

exports.getFeedback = async (req, res) => {
    try {
        const { articleId, helpful } = req.query;

        const filter = {};
        if (articleId) {
            filter.articleId = articleId;
        }

        if (helpful !== undefined) {
            filter.helpful = helpful === 'true';
        }

        const feedbacks = await AcademyFeedbackModel.getAll(filter);

        res.status(200).json({
            success: true,
            count: feedbacks.length,
            data: feedbacks
        });
    } catch (error) {
        console.error('Error fetching feedback:', error);
        res.status(500).json({ success: false, message: 'Server error while fetching feedback' });
    }
};

