/**
 * Neon Database Configuration
 * Optimized for serverless PostgreSQL
 */

const { neon, neonConfig } = require('@neondatabase/serverless');

// Configure connection pooling for Neon
neonConfig.fetchConnectionCache = true;

// Set query timeout (Neon default is 60 seconds)
neonConfig.fetchOptions = {
    timeout: 30000 // 30 seconds
};

// Initialize SQL client
const sql = neon(process.env.DATABASE_URL, {
    fullResults: true,
    arrayMode: false
});

/**
 * Execute query with retry logic for Neon
 */
async function executeQuery(queryFn, maxRetries = 3) {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await queryFn();
        } catch (error) {
            lastError = error;
            
            // Retry on connection errors
            if (error.message.includes('connection') || error.message.includes('timeout')) {
                console.warn(`Query retry ${i + 1}/${maxRetries}:`, error.message);
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
                continue;
            }
            
            // Don't retry other errors
            throw error;
        }
    }
    
    throw lastError;
}

module.exports = {
    sql,
    executeQuery
};
