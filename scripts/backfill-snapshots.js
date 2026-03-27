require('dotenv').config();
const { getDB, connectToMongoDB } = require('../src/config/database');
const { ObjectId } = require('mongodb');
const TierService = require('../src/services/tierService');

async function backfillSnapshots() {
    try {
        console.log('--- Connecting to MongoDB ---');
        await connectToMongoDB();
        const db = getDB();

        console.log('--- Fetching all plans ---');
        const plans = await db.collection('plans').find().toArray();
        const planMap = plans.reduce((acc, plan) => {
            acc[plan._id.toString()] = plan;
            return acc;
        }, {});

        console.log('--- Finding companies missing snapshots ---');
        const companies = await db.collection('companies').find({
            plan_id: { $ne: null },
            $or: [
                { plan_snapshot: { $exists: false } },
                { 'plan_snapshot.snapshotted_at': { $exists: false } }
            ]
        }).toArray();

        console.log(`Found ${companies.length} companies that need a plan snapshot.`);

        let successCount = 0;
        let failCount = 0;

        for (const company of companies) {
            try {
                const planIdStr = company.plan_id.toString();
                const plan = planMap[planIdStr];

                if (!plan) {
                    console.warn(`[Warning] No plan found for company ${company.company_name} (Plan ID: ${planIdStr}). Skipping.`);
                    failCount++;
                    continue;
                }

                const snapshot = TierService.buildPlanSnapshot(plan);
                
                await db.collection('companies').updateOne(
                    { _id: company._id },
                    { 
                        $set: { 
                            plan_snapshot: snapshot,
                            subscription_plan: plan.name,
                            updated_at: new Date()
                        } 
                    }
                );

                console.log(`[Success] Created snapshot for ${company.company_name} (${plan.name})`);
                successCount++;
            } catch (err) {
                console.error(`[Error] Failed to update ${company.company_name}:`, err.message);
                failCount++;
            }
        }

        console.log('--- Backfill Complete ---');
        console.log(`Successfully updated: ${successCount}`);
        console.log(`Failed/Skipped: ${failCount}`);
        process.exit(0);
    } catch (error) {
        console.error('Backfill failed:', error);
        process.exit(1);
    }
}

backfillSnapshots();
