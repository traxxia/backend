/**
 * One-time seed script to create the Observatory Account.
 * Run: node scripts/create-observatory-account.js
 *
 * Environment variables required (from .env):
 *   MONGO_URI, OBSERVATORY_PASSWORD
 */

require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

async function createObservatoryAccount() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('❌ MONGO_URI is not set in .env');
    process.exit(1);
  }

  const password = process.env.OBSERVATORY_PASSWORD;
  if (!password) {
    console.error('❌ OBSERVATORY_PASSWORD is not set in .env');
    process.exit(1);
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db();

    // 1. Check if already exists
    const existing = await db.collection('users').findOne({ email: 'observatory@traxxia.internal' });
    if (existing) {
      console.log('ℹ️  Observatory account already exists:', existing.email);
      console.log('   is_observatory:', existing.is_observatory);
      console.log('   _id:', existing._id.toString());
      return;
    }

    // 2. Find the 'user' role
    const userRole = await db.collection('roles').findOne({ role_name: 'user' });
    if (!userRole) {
      console.error('❌ Role "user" not found in the roles collection.');
      process.exit(1);
    }

    // 3. Find or create a placeholder company for the observatory account
    //    (Required if your system needs company_id for businesses)
    let company = await db.collection('companies').findOne({ company_name: 'Traxxia Internal' });
    if (!company) {
      const result = await db.collection('companies').insertOne({
        company_name: 'Traxxia Internal',
        created_at: new Date(),
        status: 'active'
      });
      company = { _id: result.insertedId };
      console.log('✅ Created internal company: Traxxia Internal');
    }

    // 4. Hash the password
    const hashedPassword = await bcrypt.hash(password, 12);

    // 5. Insert the observatory account
    const result = await db.collection('users').insertOne({
      name: 'Observatory Account',
      email: 'observatory@traxxia.internal',
      password: hashedPassword,
      role_id: userRole._id,
      company_id: company._id,
      is_observatory: true,          // ← THE FLAG that gates all LLM logging
      status: 'active',
      access_mode: 'active',
      tour_completed: true,          // skip onboarding tour
      created_at: new Date(),
      updated_at: new Date()
    });

    console.log('');
    console.log('✅ Observatory Account created successfully!');
    console.log('   Email   : observatory@traxxia.internal');
    console.log('   Role    : user (behaves like a normal user)');
    console.log('   Flag    : is_observatory = true');
    console.log('   _id     :', result.insertedId.toString());
    console.log('');
    console.log('ℹ️  Log in with this account to create businesses and trigger');
    console.log('   LLM analysis. All interactions will be captured in the');
    console.log('   Observatory UI (visible to super_admin only).');

  } finally {
    await client.close();
  }
}

createObservatoryAccount().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
