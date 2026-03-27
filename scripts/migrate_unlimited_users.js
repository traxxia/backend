const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const client = new MongoClient(uri);

async function migrateUsersToAdvanced() {
    try {
        await client.connect();
        const dbName = uri.split('/').pop().split('?')[0] || 'traxxia';
        const db = client.db(dbName);
        console.log(`Connected to Database: ${dbName}`);

        // Get the Advanced Plan Document
        const advancedPlan = await db.collection('plans').findOne({
            name: new RegExp(`^advanced$`, 'i')
        });

        if (!advancedPlan) {
            console.error('CRITICAL ERROR: Advanced plan not found in database.');
            process.exit(1);
        }

        console.log(`Found Advanced Plan ID: ${advancedPlan._id}`);

        // Find all companies that have NO plan_id
        const companiesWithoutPlan = await db.collection('companies').find({
            $or: [
                { plan_id: { $exists: false } },
                { plan_id: null }
            ]
        }).toArray();

        console.log(`Found ${companiesWithoutPlan.length} companies without a plan_id.`);

        let updatedCount = 0;

        // Iterate and Update
        for (const company of companiesWithoutPlan) {
            await db.collection('companies').updateOne(
                { _id: company._id },
                {
                    $set: {
                        plan_id: advancedPlan._id,
                        subscription_plan: advancedPlan.name,
                        updated_at: new Date()
                    }
                }
            );
            console.log(`Migrated Company ${company._id} (${company.company_name}) to Advanced.`);
            updatedCount++;
        }

        console.log(`\nMigration completed successfully. Migrated ${updatedCount} companies out of ${companiesWithoutPlan.length}.`);

    } catch (error) {
        console.error('Migration failed:', error);
    } finally {
        await client.close();
        process.exit(0);
    }
}

migrateUsersToAdvanced();
