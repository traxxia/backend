const cron = require('node-cron');
const { getDB } = require('../config/database');
const NotificationModel = require('../models/notificationModel');
const { ObjectId } = require('mongodb');

const getHoursDifference = (targetDate) => {
  const target = new Date(targetDate);
  const now = new Date();

  const diffTime = target.getTime() - now.getTime();
  return diffTime / (1000 * 60 * 60);
};

const runStaleBetCheck = async () => {
  console.log('[Cron] 🕒 Running stale bet check...');

  try {
    const db = getDB();
    if (!db) {
      console.log('[Cron] DB not initialized yet, skipping stale bet check.');
      return;
    }

    if (!NotificationModel._indexesCreated) {
      await NotificationModel.setupIndexes();
      NotificationModel._indexesCreated = true;
    }

    const projects = await db.collection("projects").find({
      launch_status: 'launched',
      status: { $nin: ['archived', 'deleted'] }
    }).toArray();

    for (const project of projects) {
      if (!project.next_review_date) continue;

      const diffHours = getHoursDifference(project.next_review_date);

      let notificationType = null;

      if (diffHours <= 24 && diffHours > 0) {
        notificationType = 'review_reminder';
      } else if (diffHours <= 0) {
        notificationType = 'stale_bet';
      }

      if (notificationType) {
        let ownerId = null;
        let companyId = null;
        let businessName = "Unknown Business";

        const business = await db.collection("user_businesses").findOne({
          _id: new ObjectId(String(project.business_id)),
          status: { $ne: 'deleted' }
        });

        // Skip projects if their parent business was soft-deleted
        if (!business) continue;

        companyId = business.company_id;
        ownerId = business.user_id;
        businessName = business.business_name || businessName;

        let title = '';
        let message = '';

        if (notificationType === 'review_reminder') {
          title = `Reminder: Project Review Tomorrow`;
          message = `Friendly Reminder: Project "${project.project_name}" under "${businessName}" is scheduled for review tomorrow.`;
        } else {
          title = `Overdue: Stale Project`;
          message = `Project "${project.project_name}" under "${businessName}" is stale and requires an immediate review.`;
        }

        // Prioritize accountable_owner_id if assigned, otherwise fallback to project creator (user_id)
        if (project.accountable_owner_id) {
          ownerId = new ObjectId(String(project.accountable_owner_id));
        } else if (project.user_id) {
          ownerId = new ObjectId(String(project.user_id));
        }

        const notificationRecipients = new Set();

        if (ownerId && ObjectId.isValid(ownerId)) {
          notificationRecipients.add(ownerId.toString());
        }

        if (companyId && ObjectId.isValid(String(companyId))) {
          const companyAdmins = await db.collection("users").aggregate([
            { $match: { company_id: new ObjectId(String(companyId)) } },
            { $lookup: { from: 'roles', localField: 'role_id', foreignField: '_id', as: 'role' } },
            { $unwind: '$role' },
            { $match: { 'role.role_name': 'company_admin' } }
          ]).toArray();

          for (const admin of companyAdmins) {
            notificationRecipients.add(admin._id.toString());
          }
        }

        for (const recipientId of notificationRecipients) {
          const existing = await NotificationModel.findExistingNotificationForTarget(
            recipientId,
            notificationType,
            project._id,
            project.next_review_date
          );

          if (!existing) {
            await NotificationModel.create({
              user_id: recipientId,
              type: notificationType,
              title: title,
              message: message,
              action_data: {
                project_id: project._id.toString(),
                target_date: new Date(project.next_review_date).toISOString()
              }
            });
            console.log(`[Cron] Sent ${notificationType} to user ${recipientId} for project ${project._id}`);
          }
        }
      }
    }

  } catch (error) {
    if (error.message === 'Database not initialized') {
      console.log(`[Cron] Database not ready yet for stale bets, skipping this cycle.`);
    } else {
      console.error('[Cron] Error checking stale bets:', error);
    }
  }
};

// For robust global timezones, the cron *must* run reliably every hour ('0 * * * *')
// Testing phase: running every minute
cron.schedule('0 * * * *', runStaleBetCheck);

module.exports = { runStaleBetCheck };
