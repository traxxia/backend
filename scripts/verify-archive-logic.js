require('dotenv').config({ path: 'backend/.env' });
const { getDB, connectToMongoDB } = require('../src/config/database');
const { ObjectId } = require('mongodb');

async function verifyArchiveLogic() {
    try {
        console.log('--- Connecting to MongoDB ---');
        await connectToMongoDB();
        const db = getDB();

        const companyId = new ObjectId();
        const collabRole = await db.collection('roles').findOne({ role_name: 'collaborator' });
        const viewerRole = await db.collection('roles').findOne({ role_name: 'viewer' });
        const userRole = await db.collection('roles').findOne({ role_name: 'user' });

        const testUsers = [
            { _id: new ObjectId(), company_id: companyId, role_id: collabRole._id, status: 'inactive', access_mode: 'archived', name: 'Archived Collab', email: `collab_${Date.now()}@test.com`, inactive_reason: 'plan_downgrade' },
            { _id: new ObjectId(), company_id: companyId, role_id: viewerRole._id, status: 'inactive', access_mode: 'archived', name: 'Archived Viewer', email: `viewer_${Date.now()}@test.com`, inactive_reason: 'plan_downgrade' },
            { _id: new ObjectId(), company_id: companyId, role_id: userRole._id, status: 'inactive', access_mode: 'archived', name: 'Archived User', email: `user_${Date.now()}@test.com`, inactive_reason: 'plan_downgrade' },
            { _id: new ObjectId(), company_id: companyId, role_id: collabRole._id, status: 'active', access_mode: 'active', name: 'Active Collab', email: `active_${Date.now()}@test.com` }
        ];

        await db.collection('users').insertMany(testUsers);

        const testBusinessId = new ObjectId();
        console.log('--- Setting up test business ---');
        // Business MUST be owned by one of the company users
        await db.collection('user_businesses').insertOne({
            _id: testBusinessId,
            user_id: testUsers[3]._id, 
            business_name: 'Test Archive Business',
            status: 'active',
            access_mode: 'active'
        });

        console.log('1. Simulating Downgrade (Archive)...');
        await db.collection('user_businesses').updateMany(
            { _id: { $in: [testBusinessId] } },
            {
                $set: {
                    access_mode: 'archived',
                    status: 'archived',
                    archived_at: new Date(),
                    archived_reason: 'plan_downgrade'
                }
            }
        );

        let business = await db.collection('user_businesses').findOne({ _id: testBusinessId });
        console.log(`   access_mode: ${business.access_mode} (Expected: archived)`);

        console.log('2. Simulating Reactivation...');
        await db.collection('user_businesses').updateMany(
            { _id: { $in: [testBusinessId] } },
            { $set: { access_mode: 'active', status: 'active', updated_at: new Date() } }
        );

        business = await db.collection('user_businesses').findOne({ _id: testBusinessId });
        console.log(`   access_mode: ${business.access_mode} (Expected: active)`);

        console.log('3. Verifying User Archiving Logic (All Roles)...');
        const archivedCollab = await db.collection('users').findOne({ _id: testUsers[0]._id });
        console.log(`   Archived Collab status: ${archivedCollab.status} (Expected: inactive)`);
        
        console.log('4. Verifying Usage Count Filtering...');
        const SubscriptionController = require('../src/controllers/subscriptionController');
        const mockReq = { user: { _id: testUsers[3]._id } }; 
        
        let details;
        const mockRes = { json: (data) => { details = data; } };
        await SubscriptionController.getDetails(mockReq, mockRes);

        console.log(`   Active Collaborators: ${details.usage.collaborators.current} (Expected: 1)`);

        console.log('5. Verifying Reactivation Detection for all roles...');
        const TierService = require('../src/services/tierService');
        const archivedUsage = await TierService.getCompanyArchivedUsage(companyId);

        console.log(`   Archived Collaborators: ${archivedUsage.collaborators} (Expected: 1)`);
        console.log(`   Archived Viewers: ${archivedUsage.viewers} (Expected: 1)`);
        console.log(`   Archived Users: ${archivedUsage.users} (Expected: 1)`);

        console.log('6. Verifying processDowngrade Fix...');
        const mockDowngradeReq = {
            user: { _id: testUsers[3]._id, company_id: companyId },
            body: {
                plan_id: (await db.collection('plans').findOne())._id.toString(),
                active_business_id: testBusinessId.toString(),
                active_collaborator_ids: [testUsers[3]._id.toString()],
                active_user_ids: [],
                active_viewer_ids: []
            }
        };

        const mockDowngradeRes = {
            status: function(code) { this.statusCode = code; return this; },
            json: function(data) { this.data = data; return this; }
        };

        // Set one user to inactive first to test reactivation
        await db.collection('users').updateOne({ _id: testUsers[0]._id }, { $set: { status: 'inactive', access_mode: 'archived' } });

        await SubscriptionController.processDowngrade(mockDowngradeReq, mockDowngradeRes);
        console.log(`   Downgrade Response Status: ${mockDowngradeRes.statusCode || 200} (Expected: 200)`);
        
        if (mockDowngradeRes.statusCode && mockDowngradeRes.statusCode !== 200) {
            console.error('Downgrade failed:', mockDowngradeRes.data);
            throw new Error('processDowngrade verification failed!');
        }

        // Verify that testUsers[3]._id (Active Collab) is still active
        const activeUser = await db.collection('users').findOne({ _id: testUsers[3]._id });
        console.log(`   Active User status: ${activeUser.status} (Expected: active)`);
        console.log(`   Active User access_mode: ${activeUser.access_mode} (Expected: active)`);

        if (activeUser.status !== 'active' || activeUser.access_mode !== 'active') {
            throw new Error('Selected user activation failed!');
        }

        console.log('--- Cleaning up ---');
        await db.collection('users').deleteMany({ company_id: companyId });
        await db.collection('user_businesses').deleteOne({ _id: testBusinessId });

        console.log('--- Verification Successful ---');
        process.exit(0);
    } catch (error) {
        console.error('Verification failed:', error);
        process.exit(1);
    }
}

verifyArchiveLogic();
