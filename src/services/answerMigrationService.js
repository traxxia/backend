const { getDB } = require('../config/database');

async function runAnswerMigration() {
  try {
    const db = getDB();
    console.log('[Migration] Checking for missing history fields in answers collection...');

    // Find all answers where either ai_answer, user_answer, or previous_answer is missing
    const cursor = db.collection('answers').find({
      $or: [
        { ai_answer: { $exists: false } },
        { user_answer: { $exists: false } },
        { previous_answer: { $exists: false } }
      ]
    });

    const docs = await cursor.toArray();
    if (docs.length === 0) {
      console.log('[Migration] All answers already have history fields.');
      return;
    }

    console.log(`[Migration] Found ${docs.length} answers missing history fields. Running migration...`);

    const bulkOps = docs.map(doc => {
      const updateData = {};
      
      if (doc.ai_answer === undefined) {
        updateData.ai_answer = doc.answer || '';
      }
      if (doc.user_answer === undefined) {
        updateData.user_answer = null;
      }
      if (doc.previous_answer === undefined) {
        updateData.previous_answer = null;
      }

      return {
        updateOne: {
          filter: { _id: doc._id },
          update: {
            $set: updateData
          }
        }
      };
    });

    if (bulkOps.length > 0) {
      const result = await db.collection('answers').bulkWrite(bulkOps);
      console.log(`[Migration] Successfully migrated ${result.modifiedCount} answers.`);
    }
  } catch (error) {
    console.error('[Migration] Failed to run answers migration:', error);
  }
}

module.exports = { runAnswerMigration };
