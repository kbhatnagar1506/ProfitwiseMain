import { query } from './lib/db.ts';

async function checkStatus() {
  try {
    console.log('\n=== CASH EVENTS STATUS CHECK ===\n');
    
    // Get all cash events with status info
    const result = await query(`
      SELECT 
        ce.id,
        ce.entity_id,
        ce.event_type,
        ce.amount::numeric,
        ce.outstanding_amount::numeric,
        ce.status,
        ce.display_status,
        ce.last_reconciled_at,
        ce.metadata->>'manual_paid' as manual_paid,
        ce.voided_at,
        ce.updated_at
      FROM cash_events ce
      WHERE ce.status IN ('paid', 'open', 'partially_paid')
      ORDER BY ce.updated_at DESC
      LIMIT 30
    `);
    
    console.log(`Total records: ${result.rows.length}\n`);
    
    result.rows.forEach((row, idx) => {
      console.log(`${idx + 1}. Entity: ${row.entity_id}`);
      console.log(`   Type: ${row.event_type} | Status: ${row.status} | Display: ${row.display_status}`);
      console.log(`   Amount: $${row.amount} | Outstanding: $${row.outstanding_amount}`);
      console.log(`   Manual Paid: ${row.manual_paid} | Last Reconciled: ${row.last_reconciled_at}`);
      console.log(`   Updated: ${row.updated_at}\n`);
    });
    
    // Summary stats
    const stats = {
      paid: result.rows.filter(r => r.status === 'paid').length,
      open: result.rows.filter(r => r.status === 'open').length,
      partially_paid: result.rows.filter(r => r.status === 'partially_paid').length,
      manual_paid_true: result.rows.filter(r => r.manual_paid === 'true').length,
      reconciled: result.rows.filter(r => r.last_reconciled_at).length
    };
    
    console.log('=== SUMMARY ===');
    console.log(`Paid: ${stats.paid}`);
    console.log(`Open: ${stats.open}`);
    console.log(`Partially Paid: ${stats.partially_paid}`);
    console.log(`Manually Marked Paid: ${stats.manual_paid_true}`);
    console.log(`Reconciled (has last_reconciled_at): ${stats.reconciled}`);
    
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

checkStatus();
