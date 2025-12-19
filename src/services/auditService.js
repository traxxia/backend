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

module.exports = { logAuditEvent, createAuditIndexes };