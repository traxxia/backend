const { ObjectId } = require('mongodb');
const AnswerModel = require('../models/answerModel');

class AnswerController {
  
  static async create(req, res) {
    try {
      const { business_id, question_id, answer } = req.body;
      
      const answerData = {
        business_id: new ObjectId(business_id),
        question_id: new ObjectId(question_id),
        answer: answer
      };

      const result = await AnswerModel.create(answerData);
      
      res.status(201).json({
        message: 'Answer created successfully',
        data: { _id: result, ...answerData }
      });
    } catch (error) {
      console.error('Create answer error:', error);
      res.status(500).json({ error: 'Failed to create answer' });
    }
  }

  static async bulkCreate(req, res) {
    try {
      const { business_id, answers } = req.body;
      
      if (!business_id || !Array.isArray(answers) || answers.length === 0) {
        return res.status(400).json({ error: 'business_id and a non-empty array of answers are required' });
      }

      const answersData = answers.map(item => ({
        business_id: new ObjectId(business_id),
        question_id: new ObjectId(item.question_id),
        answer: item.answer
      }));

      const result = await AnswerModel.bulkCreate(answersData);
      
      res.status(201).json({
        message: `${answers.length} answers created successfully`,
        data: { insertedIds: result }
      });
    } catch (error) {
      console.error('Bulk create answers error:', error);
      res.status(500).json({ error: 'Failed to bulk create answers' });
    }
  }

  static async getByID(req, res) {
    try {
      const { id } = req.params;
      const answer = await AnswerModel.getById(id);
      
      if (!answer) {
        return res.status(404).json({ error: 'Answer not found' });
      }

      res.status(200).json({ data: answer });
    } catch (error) {
      console.error('Get answer by ID error:', error);
      res.status(500).json({ error: 'Failed to find answer' });
    }
  }

  static async getByBusinessID(req, res) {
    try {
      const { business_id } = req.params;
      const answers = await AnswerModel.getByBusinessId(business_id);
      
      res.status(200).json({ data: answers });
    } catch (error) {
      console.error('Get answers by business ID error:', error);
      res.status(500).json({ error: 'Failed to find answers' });
    }
  }

  static async update(req, res) {
    try {
      const { id } = req.params;
      const { answer } = req.body;
      
      const updateData = {};
      if (answer !== undefined) {
        updateData.answer = answer;
      }
      
      const result = await AnswerModel.update(id, updateData);
      
      if (result.matchedCount === 0) {
         return res.status(404).json({ error: 'Answer not found' });
      }

      res.status(200).json({ message: 'Answer updated successfully' });
    } catch (error) {
      console.error('Update answer error:', error);
      res.status(500).json({ error: 'Failed to update answer' });
    }
  }
}

module.exports = AnswerController;
