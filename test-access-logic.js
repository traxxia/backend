require('dotenv').config();
const { getDB, connectToMongoDB } = require('./src/config/database');
const { ObjectId } = require('mongodb');
const BusinessModel = require('./src/models/businessModel');
const ProjectRankingModel = require('./src/models/projectRankingModel');

async function verifyAccessLogic() {
    try {
        console.log('--- Connecting to MongoDB ---');
        await connectToMongoDB();
        const db = getDB();

        const testBusinessId = new ObjectId();
        const testUserId = new ObjectId();
        const testProjectId = new ObjectId();

        console.log('--- Setting up test data ---');
        // Create a test business
        await db.collection('user_businesses').insertOne({
            _id: testBusinessId,
            status: 'launched',
            collaborators: [testUserId],
            allowed_ranking_collaborators: []
        });

        // Create a locked ranking
        await db.collection('project_rankings').insertOne({
            user_id: testUserId,
            business_id: testBusinessId,
            project_id: testProjectId,
            rank: 1,
            locked: true
        });

        console.log('1. Verifying unlockRankingByBusiness (Simulating Admin Action)...');
        await ProjectRankingModel.unlockRankingByBusiness(testBusinessId);
        const ranking = await db.collection('project_rankings').findOne({
            user_id: testUserId,
            business_id: testBusinessId
        });
        console.log(`   Ranking locked status: ${ranking.locked} (Expected: false)`);

        console.log('2. Verifying addAllowedRankingCollaborator (Simulating Collaborator Action)...');
        await BusinessModel.addAllowedRankingCollaborator(testBusinessId, testUserId);
        const business = await db.collection('user_businesses').findOne({ _id: testBusinessId });
        const isAllowed = business.allowed_ranking_collaborators.some(id => id.toString() === testUserId.toString());
        console.log(`   User in allowed_ranking_collaborators: ${isAllowed} (Expected: true)`);

        console.log('--- Cleaning up test data ---');
        await db.collection('user_businesses').deleteOne({ _id: testBusinessId });
        await db.collection('project_rankings').deleteMany({ business_id: testBusinessId });

        console.log('--- Verification Complete ---');
        process.exit(0);
    } catch (error) {
        console.error('Verification failed:', error);
        process.exit(1);
    }
}

verifyAccessLogic();
