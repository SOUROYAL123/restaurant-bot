// src/db.js
const { neon } = require('@neondatabase/serverless');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const sql = neon(process.env.DATABASE_URL);

/**
 * Compatibility wrapper so existing code using pool.query(...)
 * continues to work without installing `pg`
 */
module.exports = {
  query: async (text, params = []) => {
    // Simple case: no params
    if (!params || params.length === 0) {
      const rows = await sql.unsafe(text);
      return { rows };
    }

    // Replace $1, $2... with Neon parameters
    let queryText = text;
    params.forEach((_, i) => {
      queryText = queryText.replace(`$${i + 1}`, `$${i + 1}`);
    });

    const rows = await sql.unsafe(queryText, params);
    return { rows };
  }
};
