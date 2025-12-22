// db.js
const { neon } = require('@neondatabase/serverless');

if (!process.env.DATABASE_URL) {
  throw new Error('❌ DATABASE_URL is not set');
}

const sql = neon(process.env.DATABASE_URL);

module.exports = {
  query: async (text, params = []) => {
    // Neon uses template literals, so we map pg-style calls
    if (!params.length) {
      return sql.unsafe(text);
    }

    // Convert $1, $2... to Neon placeholders
    let q = text;
    params.forEach((_, i) => {
      q = q.replace(`$${i + 1}`, `$${i + 1}`);
    });

    return sql.unsafe(q, params);
  }
};
