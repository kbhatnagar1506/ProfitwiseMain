const { Pool } = require("pg");

async function main() {
  const itemId = process.argv[2] || "5KEb88yDEdS93Y4RyQnvU3aYzq59kXcBgAOvq";
  
  const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false } 
  });

  try {
    const { rows } = await pool.query(
      "SELECT item_id, access_token FROM plaid_items WHERE item_id = $1", 
      [itemId]
    );
    
    if (!rows[0]) { 
      console.log("Item not found:", itemId); 
      return; 
    }
    
    console.log("Found item:", rows[0].item_id);
    
    const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
    const config = new Configuration({
      basePath: PlaidEnvironments.production,
      baseOptions: { 
        headers: { 
          "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID, 
          "PLAID-SECRET": process.env.PLAID_SECRET 
        } 
      }
    });
    const client = new PlaidApi(config);
    
    console.log("Triggering Plaid refresh...");
    await client.transactionsRefresh({ access_token: rows[0].access_token });
    console.log("✓ Refresh triggered! Plaid will send a webhook to your app soon.");
    console.log("  Check Plaid dashboard logs to see the webhook delivery.");
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await pool.end();
  }
}

main();
