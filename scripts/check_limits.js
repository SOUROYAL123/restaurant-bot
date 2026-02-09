// Run this weekly
const { Pool } = require('pg');

async function checkLimits() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  
  // Check DB size
  const sizeQuery = await pool.query(`
    SELECT pg_size_pretty(pg_database_size(current_database())) as size;
  `);
  
  // Check client count
  const clientCount = await pool.query(`
    SELECT COUNT(*) FROM businesses;
  `);
  
  console.log('=== INFRASTRUCTURE HEALTH ===');
  console.log('DB Size:', sizeQuery.rows[0].size);
  console.log('Active Clients:', clientCount.rows[0].count);
  console.log('Neon Free Limit: 0.5 GB');
  console.log('⚠️  Upgrade at 12 clients or 0.3 GB');
  
  pool.end();
}

checkLimits();
```
