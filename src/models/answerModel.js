const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

class AnswerModel {
  static async create(answerData) {
    const db = getDB();
    const result = await db.collection('answers').insertOne({
      ...answerData,
      ai_answer: answerData.ai_answer !== undefined ? answerData.ai_answer : (answerData.answer || ''),
      user_answer: answerData.user_answer !== undefined ? answerData.user_answer : null,
      previous_answer: answerData.previous_answer !== undefined ? answerData.previous_answer : null,
      created_at: new Date(),
      updated_at: new Date()
    });
    return result.insertedId;
  }

  static async bulkCreate(answersData) {
    const db = getDB();
    const formattedAnswers = answersData.map(answer => ({
      ...answer,
      ai_answer: answer.ai_answer !== undefined ? answer.ai_answer : (answer.answer || ''),
      user_answer: answer.user_answer !== undefined ? answer.user_answer : null,
      previous_answer: answer.previous_answer !== undefined ? answer.previous_answer : null,
      created_at: new Date(),
      updated_at: new Date()
    }));
    const result = await db.collection('answers').insertMany(formattedAnswers);
    return result.insertedIds;
  }

  static async bulkUpdate(answersData) {
    const db = getDB();
    if (answersData.length === 0) return { modifiedCount: 0 };

    const answerIds = answersData.map(item => new ObjectId(item.answer_id));
    const currentDocs = await db.collection('answers').find({ _id: { $in: answerIds } }).toArray();
    const docsMap = {};
    currentDocs.forEach(doc => {
      docsMap[String(doc._id)] = doc;
    });

    const bulkOps = answersData.map(item => {
      const currentDoc = docsMap[String(item.answer_id)];
      const updateFields = {
        answer: item.answer,
        updated_at: new Date()
      };

      if (currentDoc) {
        if (currentDoc.answer !== item.answer) {
          updateFields.previous_answer = item.previous_answer !== undefined ? item.previous_answer : (currentDoc.answer || null);
          updateFields.user_answer = item.user_answer !== undefined ? item.user_answer : item.answer;
        } else {
          updateFields.previous_answer = item.previous_answer !== undefined ? item.previous_answer : (currentDoc.previous_answer || null);
          updateFields.user_answer = item.user_answer !== undefined ? item.user_answer : (currentDoc.user_answer || null);
        }
      } else {
        if (item.user_answer !== undefined) updateFields.user_answer = item.user_answer;
        if (item.previous_answer !== undefined) updateFields.previous_answer = item.previous_answer;
      }

      if (item.confidence !== undefined) updateFields.confidence = item.confidence;
      if (item.status !== undefined) updateFields.status = item.status;
      if (item.evidence !== undefined) updateFields.evidence = item.evidence;
      if (item.ai_answer !== undefined) updateFields.ai_answer = item.ai_answer;

      return {
        updateOne: {
          filter: { _id: new ObjectId(item.answer_id) },
          update: {
            $set: updateFields
          }
        }
      };
    });

    return await db.collection('answers').bulkWrite(bulkOps);
  }

  static async getById(id) {
    const db = getDB();
    return await db.collection('answers').findOne({ _id: new ObjectId(id) });
  }

  static async getByBusinessId(business_id) {
    const db = getDB();
    return await db.collection('answers')
      .find({ business_id: new ObjectId(business_id) })
      .toArray();
  }

  static async getByBusinessIds(business_ids) {
    const db = getDB();
    return await db.collection('answers')
      .find({ business_id: { $in: business_ids.map(id => new ObjectId(id)) } })
      .toArray();
  }

  static async update(id, updateData) {
    const db = getDB();

    if (updateData.answer !== undefined) {
      const currentDoc = await db.collection('answers').findOne({ _id: new ObjectId(id) });
      if (currentDoc) {
        if (currentDoc.answer !== updateData.answer) {
          updateData.previous_answer = updateData.previous_answer !== undefined ? updateData.previous_answer : (currentDoc.answer || null);
          updateData.user_answer = updateData.user_answer !== undefined ? updateData.user_answer : updateData.answer;
        } else {
          updateData.previous_answer = updateData.previous_answer !== undefined ? updateData.previous_answer : (currentDoc.previous_answer || null);
          updateData.user_answer = updateData.user_answer !== undefined ? updateData.user_answer : (currentDoc.user_answer || null);
        }
      }
    }

    return await db.collection('answers').updateOne(
      { _id: new ObjectId(id) },
      { 
        $set: {
          ...updateData,
          updated_at: new Date()
        } 
      }
    );
  }
}

module.exports = AnswerModel;
