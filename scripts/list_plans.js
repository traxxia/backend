const { MongoClient } = require('mongodb');

const uri = "mongodb+srv://kavitha:Piquota1234@cluster0.yxi1t.mongodb.net/traxxia-development?retryWrites=true&w=majority&appName=Cluster0";
const dbName = "traxxia-development";

async function listPlans() {
    const client = new MongoClient(uri);

    try {
        await client.connect();
        console.log("Connected to database:", dbName);
        const db = client.db(dbName);

        const plans = await db.collection('plans').find({}).toArray();

        console.log("\n--- Plans in Database ---");
        if (plans.length === 0) {
            console.log("No plans found!");
        } else {
            plans.forEach(plan => {
                console.log(`Name: '${plan.name}', ID: ${plan._id}, StripePriceID: ${plan.stripe_price_id || 'NOT SET'}`);
            });
        }
        console.log("-------------------------\n");

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await client.close();
    }
}

listPlans();
