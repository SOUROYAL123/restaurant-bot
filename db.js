// src/db.js
const { neon } = require('@neondatabase/serverless');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const sql = neon(process.env.DATABASE_URL);

/**
 * Minimal pg-like wrapper for Neon
 * Supports: pool.query(text, params)
 */
async function query(text, params = []) {
  // Convert $1, $2 ... to template placeholders
  let queryText = text;

  params.forEach((_, i) => {
    queryText = queryText.replace(`$${i + 1}`, `\${params[${i}]}`);
  });

  // Execute via Function constructor to preserve template literals
  const fn = new Function('sql', 'params', `return sql\`${queryText}\`;`);
  const rows = await fn(sql, params);

  return { rows };
}

module.exports = { query };
