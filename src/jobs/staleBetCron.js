const cron = require('node-cron');
const { getDB } = require('../config/database');
const NotificationModel = require('../models/notificationModel');
const { ObjectId } = require('mongodb');

const getDaysDifference = (targetDateStr) => {
  const target = new Date(targetDateStr);
  const now = new Date();

  // Normalize both dates to midnight to only compare calendar days
  const targetMidnight = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const diffTime = targetMidnight - nowMidnight;
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
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
      status: { $ne: 'archived' }
    }).toArray();

    for (const project of projects) {
      if (!project.next_review_date) continue;

      const diffDays = getDaysDifference(project.next_review_date);

      let notificationType = null;

      if (diffDays === 1) {
        notificationType = 'review_reminder';
      } else if (diffDays <= 0) {
        notificationType = 'stale_bet';
      }

      if (notificationType) {
        let ownerId = null;
        let companyId = null;
        let businessName = "Unknown Business";

        const business = await db.collection("user_businesses").findOne({ _id: new ObjectId(String(project.business_id)) });
        if (business) {
          companyId = business.company_id;
          ownerId = business.user_id;
          businessName = business.business_name || businessName;
        }

        let title = '';
        let message = '';

        if (notificationType === 'review_reminder') {
          title = `Reminder: Project Review Tomorrow`;
          message = `Friendly Reminder: Project "${project.project_name}" under "${businessName}" is scheduled for review tomorrow.`;
        } else {
          title = `Overdue: Stale Project`;
          message = `Project "${project.project_name}" under "${businessName}" is stale and requires an immediate review.`;
        }

        // Project often stores user_id for the owner
        if (project.user_id) {
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
          const existing = await NotificationModel.findExistingUnreadNotification(
            recipientId,
            notificationType,
            project._id
          );

          if (!existing) {
            await NotificationModel.create({
              user_id: recipientId,
              type: notificationType,
              title: title,
              message: message,
              action_data: { project_id: project._id.toString() }
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
cron.schedule('* * * * *', runStaleBetCheck);

module.exports = { runStaleBetCheck };
