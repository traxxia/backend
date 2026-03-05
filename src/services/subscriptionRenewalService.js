const StripeService = require('./stripeService');
const CompanyModel = require('../models/companyModel');
const { getDB } = require('../config/database');
const { ObjectId } = require('mongodb');

class SubscriptionRenewalService {
    /**
     * Periodically checks all companies in the DB.
     * If their subscription_end_date is in the past, it commands Stripe to renew immediately.
     */
    static async checkAndRenewExpiredSubscriptions() {
        const db = getDB();
        const now = new Date();

        // 1. Find companies that are "Active" but their DB end_date has passed
        // We also check "last_renewal_attempt" to avoid spamming Stripe if the webhook is slow.
        const expiredCompanies = await db.collection('companies').find({
            stripe_subscription_id: { $ne: null },
            subscription_status: 'active',
            subscription_end_date: { $lt: now },
            $or: [
                { last_renewal_attempt: { $exists: false } },
                { last_renewal_attempt: { $lt: new Date(now.getTime() - 10 * 60 * 1000) } } // Only retry after 10 mins
            ]
        }).toArray();

        if (expiredCompanies.length === 0) {
            console.log(`[Auto-Renewal] No expired subscriptions found in this cycle.`);
            return;
        }

        console.log(`[Auto-Renewal] Found ${expiredCompanies.length} subscriptions that need renewal in Stripe...`);

        for (const company of expiredCompanies) {
            try {
                console.log(`[Auto-Renewal] Found Expired: ${company.company_name}`);
                console.log(`[Auto-Renewal] Triggering Stripe...`);

                const updatedSub = await StripeService.updateSubscription(company.stripe_subscription_id, {
                    billing_cycle_anchor: 'now',
                    proration_behavior: 'none'
                });

                console.log(`[Auto-Renewal] Stripe Success for ${company.company_name}.`);

                // Inspect the response structure to debug the 1970 date issue
                console.log(`[Auto-Renewal] Stripe Sub Object: Period Start: ${updatedSub.current_period_start}, End: ${updatedSub.current_period_end}`);

                // PROACTIVE SYNC: Update DB immediately as a fallback for missing webhooks
                // Use robust fallbacks to avoid 1970-01-01 (NaN/undefined * 1000)
                const periodStart = updatedSub.current_period_start
                    ? new Date(updatedSub.current_period_start * 1000)
                    : new Date();

                const periodEnd = updatedSub.current_period_end
                    ? new Date(updatedSub.current_period_end * 1000)
                    : (() => {
                        const d = new Date();
                        d.setMonth(d.getMonth() + 1);
                        return d;
                    })();

                await db.collection('companies').updateOne(
                    { _id: company._id },
                    {
                        $set: {
                            subscription_start_date: periodStart,
                            subscription_end_date: periodEnd,
                            expires_at: periodEnd,
                            status: 'active',
                            subscription_status: 'active',
                            last_renewal_attempt: new Date(),
                            updated_at: new Date()
                        }
                    }
                );
                console.log(`[Auto-Renewal] Proactive Date Sync Complete. Start: ${periodStart.toISOString()}, End: ${periodEnd.toISOString()}`);

                // PROACTIVE BILLING HISTORY: Log entry immediately
                const amount = (updatedSub.plan?.amount || updatedSub.items?.data[0]?.price?.unit_amount || 2900) / 100;
                await db.collection('billing_history').insertOne({
                    company_id: company._id,
                    stripe_subscription_id: updatedSub.id,
                    amount: amount,
                    currency: updatedSub.currency || 'usd',
                    date: new Date(),
                    type: 'renewal',
                    plan_name: company.subscription_plan || 'Advanced',
                    invoice_url: updatedSub.latest_invoice?.hosted_invoice_url || null
                });
                console.log(`[Auto-Renewal] Proactive Billing Entry Logged. Amount: $${amount}`);
            } catch (error) {
                console.error(`[Auto-Renewal] Failed for ${company.company_name}:`, error.message);
                await db.collection('companies').updateOne(
                    { _id: company._id },
                    { $set: { last_renewal_attempt: now } }
                );
            }
        }
    }
}

module.exports = SubscriptionRenewalService;
