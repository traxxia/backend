const StripeService = require('../services/stripeService');
const CompanyModel = require('../models/companyModel');
const { getDB } = require('../config/database');
const TierService = require('../services/tierService');

class WebhookController {
    static async handleWebhook(req, res) {
        console.log(`[Webhook] Received Stripe Event: ${req.headers['stripe-signature'] ? 'Signed' : 'UNSIGNED'}`);
        const sig = req.headers['stripe-signature'];
        let event;

        try {
            event = StripeService.constructEvent(
                req.body,
                sig,
                process.env.STRIPE_WEBHOOK_SECRET
            );
        } catch (err) {
            console.error(`Webhook Error: ${err.message}`);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        const db = getDB();

        console.log(`[Webhook] Processing Event Type: ${event.type}`);

        try {
            switch (event.type) {
                case 'customer.subscription.created':
                case 'customer.subscription.updated': {
                    const stripeSub = event.data.object;
                    console.log(`[Webhook] Sub Updated: ${stripeSub.id} (Status: ${stripeSub.status})`);

                    const periodStart = stripeSub.current_period_start
                        ? new Date(stripeSub.current_period_start * 1000)
                        : new Date();
                    const periodEnd = stripeSub.current_period_end
                        ? new Date(stripeSub.current_period_end * 1000)
                        : (() => {
                            const d = new Date();
                            d.setMonth(d.getMonth() + 1);
                            return d;
                        })();

                    const result = await CompanyModel.updateSubscriptionByStripeId(stripeSub.id, {
                        status: 'active',
                        subscription_status: stripeSub.status,
                        subscription_start_date: periodStart,
                        subscription_end_date: periodEnd,
                        expires_at: periodEnd,
                        updated_at: new Date()
                    });

                    console.log(`[Webhook] Update Result: matched=${result.matchedCount}, modified=${result.modifiedCount}`);

                    if (result.matchedCount === 0) {
                        console.error(`[Webhook] CRITICAL: No company found with stripe_subscription_id: ${stripeSub.id}`);
                    }
                    break;
                }

                case 'invoice.paid': {
                    const invoice = event.data.object;
                    console.log(`[Webhook] Invoice Paid: ${invoice.id} (Amount: ${invoice.amount_paid}, Total: ${invoice.total})`);

                    if (invoice.subscription) {
                        const company = await db.collection('companies').findOne({
                            stripe_customer_id: invoice.customer
                        });

                        if (company) {
                            const amount = (invoice.amount_paid || invoice.total || 0) / 100;
                            console.log(`[Webhook] Final Amount to Log: $${amount} for ${company.company_name}`);

                            await db.collection('billing_history').insertOne({
                                company_id: company._id,
                                stripe_subscription_id: invoice.subscription,
                                amount: amount,
                                currency: invoice.currency,
                                date: new Date(),
                                type: 'renewal',
                                plan_name: company.subscription_plan || 'Advanced',
                                invoice_url: invoice.hosted_invoice_url
                            });
                            console.log(`[Webhook] Billing entry created.`);

                            // Re-snapshot plan limits on renewal so the customer receives
                            // any plan changes that were made since their last subscription.
                            if (company.plan_id) {
                                const { ObjectId } = require('mongodb');
                                const planObjId = typeof company.plan_id === 'string'
                                    ? new ObjectId(company.plan_id)
                                    : company.plan_id;
                                const plan = await db.collection('plans').findOne({ _id: planObjId });
                                if (plan) {
                                    const planSnapshot = TierService.buildPlanSnapshot(plan);
                                    await db.collection('companies').updateOne(
                                        { _id: company._id },
                                        { $set: { plan_snapshot: planSnapshot } }
                                    );
                                    console.log(`[Webhook] Plan snapshot refreshed for ${company.company_name}.`);
                                }
                            }
                        } else {
                            console.warn(`[Webhook] Company not found for customer ${invoice.customer}`);
                        }
                    }
                    break;
                }

                case 'customer.subscription.deleted': {
                    const subscription = event.data.object;
                    await CompanyModel.updateSubscriptionByStripeId(subscription.id, {
                        subscription_status: 'canceled',
                        status: 'expired'
                    });
                    console.log(`Canceled subscription ${subscription.id}.`);
                    break;
                }

                default:
                    console.log(`Unhandled event type ${event.type}`);
            }

            res.json({ received: true });
        } catch (error) {
            console.error('Error processing webhook:', error);
            res.status(500).json({ error: 'Webhook processing failed' });
        }
    }
}

module.exports = WebhookController;
