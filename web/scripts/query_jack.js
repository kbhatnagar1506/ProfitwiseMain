const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function queryJack() {
  try {
    // Get jack's user ID
    const userRes = await pool.query(
      "SELECT id, email FROM users WHERE email = 'jack@performancesupply.co' LIMIT 1"
    );
    
    if (userRes.rows.length === 0) {
      console.log('❌ User not found');
      process.exit(1);
    }
    
    const userId = userRes.rows[0].id;
    const email = userRes.rows[0].email;
    
    console.log('\n' + '='.repeat(80));
    console.log(`📊 COMPLETE DATA FOR: ${email}`);
    console.log(`User ID: ${userId}`);
    console.log('='.repeat(80) + '\n');
    
    // 1. Movements (Classified Transactions)
    const movementsRes = await pool.query(
      `SELECT COUNT(*) as count, 
              SUM(CASE WHEN direction = 'inflow' THEN amount ELSE 0 END) as total_inflow,
              SUM(CASE WHEN direction = 'outflow' THEN amount ELSE 0 END) as total_outflow
       FROM movements WHERE user_id = $1`,
      [userId]
    );
    console.log('✅ CLASSIFIED MOVEMENTS:');
    console.log(`   Total: ${movementsRes.rows[0].count}`);
    console.log(`   Total Inflow: $${parseFloat(movementsRes.rows[0].total_inflow || 0).toFixed(2)}`);
    console.log(`   Total Outflow: $${parseFloat(movementsRes.rows[0].total_outflow || 0).toFixed(2)}`);
    
    // 2. Movement Tags
    const tagsRes = await pool.query(
      `SELECT COUNT(*) as count FROM movement_tags WHERE user_id = $1`,
      [userId]
    );
    console.log('\n✅ TAGGED MOVEMENTS:');
    console.log(`   Total: ${tagsRes.rows[0].count}`);
    
    // 3. Cash Events (Reconciled AR/AP)
    const cashEventsRes = await pool.query(
      `SELECT event_type, COUNT(*) as count, SUM(amount) as total
       FROM cash_events WHERE user_id = $1 GROUP BY event_type`,
      [userId]
    );
    console.log('\n✅ RECONCILED AR/AP:');
    for (const row of cashEventsRes.rows) {
      console.log(`   ${row.event_type.toUpperCase()}: ${row.count} items, $${parseFloat(row.total || 0).toFixed(2)}`);
    }
    
    // 4. Entities (Customer/Vendor Intelligence)
    const entitiesRes = await pool.query(
      `SELECT entity_type, COUNT(*) as count FROM entities WHERE user_id = $1 GROUP BY entity_type`,
      [userId]
    );
    console.log('\n✅ ENTITY GRAPH:');
    for (const row of entitiesRes.rows) {
      console.log(`   ${row.entity_type}: ${row.count}`);
    }
    
    // 5. State Snapshot
    const stateRes = await pool.query(
      `SELECT revenue_state, spend_state, liquidity_state, snapshot_at 
       FROM state_snapshots WHERE user_id = $1`,
      [userId]
    );
    console.log('\n✅ FINANCIAL STATE:');
    if (stateRes.rows.length > 0) {
      const state = stateRes.rows[0];
      const revenue = state.revenue_state;
      const spend = state.spend_state;
      const liquidity = state.liquidity_state;
      
      console.log(`   Snapshot At: ${state.snapshot_at}`);
      console.log(`   Gross Revenue: $${revenue.gross_revenue.toFixed(2)}`);
      console.log(`   Net Revenue: $${revenue.net_revenue.toFixed(2)}`);
      console.log(`   Total OpEx: $${spend.total_opex.toFixed(2)}`);
      console.log(`   Total COGS: $${spend.total_cogs.toFixed(2)}`);
      console.log(`   Customer Count: ${revenue.customer_count}`);
    } else {
      console.log('   No state snapshot found');
    }
    
    // 6. Forecast
    const forecastRes = await pool.query(
      `SELECT forecast_data, computed_at, movement_count, invoice_count, bill_count
       FROM forecast_cache WHERE user_id = $1`,
      [userId]
    );
    console.log('\n✅ FORECAST:');
    if (forecastRes.rows.length > 0) {
      const forecast = forecastRes.rows[0];
      console.log(`   Computed At: ${forecast.computed_at}`);
      console.log(`   Movements: ${forecast.movement_count}`);
      console.log(`   Invoices (AR): ${forecast.invoice_count}`);
      console.log(`   Bills (AP): ${forecast.bill_count}`);
      if (forecast.forecast_data && forecast.forecast_data.runway_estimate) {
        console.log(`   Runway Estimate: ${forecast.forecast_data.runway_estimate} days`);
      }
    } else {
      console.log('   No forecast found');
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ ALL DATA PERSISTED TO GCP POSTGRESQL');
    console.log('='.repeat(80) + '\n');
    
    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

queryJack();
