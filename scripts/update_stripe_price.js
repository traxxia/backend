const { MongoClient } = require('mongodb');

const uri = "mongodb+srv://kavitha:Piquota1234@cluster0.yxi1t.mongodb.net/traxxia-development?retryWrites=true&w=majority&appName=Cluster0";
const dbName = "traxxia-development";

const updates = [
    { name: "Essential", priceId: "price_1T24iS7HejrxamrDzuzY8wjl" },
    { name: "Advanced", priceId: "price_1T24jE7HejrxamrDXb1zuILc" }
];

async function updatePlanPrices() {
    const client = new MongoClient(uri);

    try {
        await client.connect();
        console.log("Connected to database:", dbName);
        const db = client.db(dbName);
        const plansCollection = db.collection('plans');

        for (const update of updates) {
            const result = await plansCollection.updateOne(
                { name: update.name },
                { $set: { stripe_price_id: update.priceId } },
                { upsert: false }
            );

            if (result.matchedCount === 0) {
                console.log(`[WARNING] Plan '${update.name}' not found in database.`);
            } else {
                console.log(`[SUCCESS] Updated '${update.name}' with Price ID: ${update.priceId}`);
            }
        }

        console.log("\n--- Verification ---");
        const allPlans = await plansCollection.find({}, { projection: { name: 1, stripe_price_id: 1 } }).toArray();
        allPlans.forEach(p => console.log(`${p.name}: ${p.stripe_price_id}`));

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await client.close();
    }
}

updatePlanPrices();
