const { Pool } = require("pg");

async function main() {
  const itemId = process.argv[2];
  const newWebhookUrl = process.argv[3] || "https://dashboard.profitwise.app/api/plaid/webhook";
  
  if (!itemId) {
    console.log("Usage: node update-webhook-url.js <item_id> [webhook_url]");
    console.log("Default webhook URL: https://dashboard.profitwise.app/api/plaid/webhook");
    return;
  }
  
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
    
    console.log("Updating webhook URL to:", newWebhookUrl);
    await client.itemWebhookUpdate({ 
      access_token: rows[0].access_token,
      webhook: newWebhookUrl
    });
    console.log("✓ Webhook URL updated successfully!");
    console.log("  New webhooks will be sent to:", newWebhookUrl);
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await pool.end();
  }
}

main();
