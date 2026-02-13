require('dotenv').config();
const TierService = require('./src/services/tierService');
const { getDB, connectToMongoDB } = require('./src/config/database');
const { ObjectId } = require('mongodb');

async function testTierExemption() {
    try {
        await connectToMongoDB();
        const db = getDB();

        // 1. Create a legacy company (no plan_id)
        const legacyCompanyId = new ObjectId();
        await db.collection('companies').insertOne({
            _id: legacyCompanyId,
            company_name: 'Legacy Co',
            created_at: new Date(2025, 0, 1) // Way back
        });

        // 2. Create a new company (with plan_id)
        let plan = await db.collection('plans').findOne({ name: /essential/i });
        if (!plan) {
            // Mock a plan if it doesn't exist
            const planId = new ObjectId();
            await db.collection('plans').insertOne({
                _id: planId,
                name: 'essential'
            });
            plan = { _id: planId, name: 'essential' };
        }

        const newCompanyId = new ObjectId();
        await db.collection('companies').insertOne({
            _id: newCompanyId,
            company_name: 'New Co',
            plan_id: plan._id,
            created_at: new Date()
        });

        // 3. Create users for both
        const legacyUserId = new ObjectId();
        await db.collection('users').insertOne({
            _id: legacyUserId,
            company_id: legacyCompanyId,
            email: 'legacy@test.com'
        });

        const newUserId = new ObjectId();
        await db.collection('users').insertOne({
            _id: newUserId,
            company_id: newCompanyId,
            email: 'new@test.com'
        });

        // 4. Test TierService
        console.log('--- Testing TierService ---');
        const legacyTier = await TierService.getUserTier(legacyUserId);
        console.log(`Legacy User Tier: ${legacyTier} (Expected: unlimited)`);

        const newTier = await TierService.getUserTier(newUserId);
        console.log(`New User Tier: ${newTier} (Expected: essential)`);

        // Clean up
        await db.collection('companies').deleteMany({ _id: { $in: [legacyCompanyId, newCompanyId] } });
        await db.collection('users').deleteMany({ _id: { $in: [legacyUserId, newUserId] } });

        process.exit(0);
    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

testTierExemption();
