const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

const logAuditEvent = async (userId, eventType, eventData = {}, businessId = null) => {
  try {
    const db = getDB();
    const auditEntry = {
      user_id: new ObjectId(userId),
      business_id: businessId ? new ObjectId(businessId) : null,
      event_type: eventType,
      event_data: eventData,
      timestamp: new Date(),
      ip_address: null,
      user_agent: null
    };

    if (eventType === 'analysis_generated') {
      auditEntry.additional_info = {
        data_stored: true,
        analysis_phase: eventData.phase,
        analysis_type: eventData.analysis_type,
        logged_at: new Date().toISOString()
      };
    }

    await db.collection('audit_trail').insertOne(auditEntry);
    console.log(`✅ Audit event logged: ${eventType} for user ${userId}`);
  } catch (error) {
    console.error('Failed to log audit event:', error);
  }
};

const runAuditTrailMigration = async () => {
  try {
    const db = getDB();
    const auditTrail = db.collection('audit_trail');
    const conversations = db.collection('user_business_conversations');

    const entriesToUpdate = await auditTrail.find({
      event_type: { $in: ['question_answered', 'question_edited'] },
      'event_data.answer_preview': { $regex: /\.\.\.$/ }
    }).toArray();

    if (entriesToUpdate.length === 0) {
      console.log('ℹ️ No truncated audit entries found for migration.');
      return;
    }

    console.log(`🚀 Starting migration for ${entriesToUpdate.length} truncated audit entries...`);

    let updatedCount = 0;

    for (const entry of entriesToUpdate) {
      const { business_id, question_id } = entry.event_data;

      if (!business_id || !question_id) continue;

      const conversation = await conversations.findOne({
        business_id: new ObjectId(business_id),
        question_id: new ObjectId(question_id),
        answer_text: { $exists: true, $ne: null, $ne: "[Question Skipped]" }
      }, { sort: { created_at: -1 } });

      if (conversation && conversation.answer_text) {
        await auditTrail.updateOne(
          { _id: entry._id },
          { $set: { 'event_data.answer_preview': conversation.answer_text } }
        );
        updatedCount++;
      }
    }

    console.log(`✅ Migration complete. Updated ${updatedCount} audit entries.`);
  } catch (error) {
    console.error('❌ Audit trail migration failed:', error);
  }
};

const createAuditIndexes = async () => {
  try {
    const db = getDB();
    await db.collection('audit_trail').createIndexes([
      { key: { user_id: 1 } },
      { key: { timestamp: -1 } },
      { key: { event_type: 1 } },
      { key: { user_id: 1, timestamp: -1 } },
      { key: { event_type: 1, timestamp: -1 } },
      { key: { timestamp: 1 }, expireAfterSeconds: 31536000 }
    ]);
    console.log('Audit trail indexes created successfully');
  } catch (error) {
    console.error('Failed to create audit trail indexes:', error);
  }
};

module.exports = { logAuditEvent, createAuditIndexes, runAuditTrailMigration };