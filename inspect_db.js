const { MongoClient } = require('mongodb');
require('dotenv').config();

const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/traxxia_survey';

async function main() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    const db = client.db();

    // List collections
    const collections = await db.listCollections().toArray();
    console.log('Collections:', collections.map(c => c.name));

    // Inspect businesses
    const businesses = await db.collection('user_businesses').find({}).toArray();
    console.log(`\nBusinesses found: ${businesses.length}`);
    for (const bus of businesses) {
      console.log(`- ID: ${bus._id}, Name: ${bus.business_name}, Financial Doc: ${bus.has_financial_document}`);
      if (bus.financial_document) {
        console.log(`  Doc filename: ${bus.financial_document.original_name || bus.financial_document.filename}`);
      }
    }

    // Inspect answers
    const answers = await db.collection('answers').find({}).toArray();
    console.log(`\nAnswers found in total: ${answers.length}`);
    
    // Group answers by business_id
    const answersByBusiness = {};
    answers.forEach(ans => {
      const bid = String(ans.business_id);
      if (!answersByBusiness[bid]) answersByBusiness[bid] = [];
      answersByBusiness[bid].push(ans);
    });

    for (const [bid, list] of Object.entries(answersByBusiness)) {
      console.log(`\nBusiness ID: ${bid} has ${list.length} answers`);
      const withEvidence = list.filter(a => a.evidence && a.evidence.length > 0);
      console.log(`  Answers with evidence: ${withEvidence.length}`);
      
      const docNames = new Set();
      withEvidence.forEach(a => {
        a.evidence.forEach(ev => {
          if (ev.document_name) docNames.add(ev.document_name);
        });
      });
      console.log(`  Strategic docs mentioned in evidence:`, Array.from(docNames));
      
      // Let's print one sample answer with evidence
      if (withEvidence.length > 0) {
        console.log(`  Sample answer with evidence:`);
        console.log(`    Question ID: ${withEvidence[0].question_id}`);
        console.log(`    Answer: ${withEvidence[0].answer}`);
        console.log(`    Evidence:`, JSON.stringify(withEvidence[0].evidence));
      }
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
  }
}

main();
