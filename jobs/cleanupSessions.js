require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const logger = require('../utils/logger');

const sql = neon(process.env.DATABASE_URL);

async function cleanupSessions() {
    try {
        logger.info('Starting session cleanup job');
        
        // Delete sessions inactive for more than 24 hours
        const result = await sql`
            DELETE FROM sessions
            WHERE last_activity < NOW() - INTERVAL '24 hours'
            RETURNING id
        `;
        
        logger.success(`Cleaned up ${result.length} inactive sessions`);
        
        // Delete old pending messages
        const messages = await sql`
            DELETE FROM pending_messages
            WHERE status = 'sent' 
            AND sent_at < NOW() - INTERVAL '7 days'
            RETURNING id
        `;
        
        logger.success(`Cleaned up ${messages.length} old messages`);
        
        return {
            sessions: result.length,
            messages: messages.length
        };
        
    } catch (error) {
        logger.error('Session cleanup failed', error);
        throw error;
    }
}

// Run if executed directly
if (require.main === module) {
    cleanupSessions()
        .then(result => {
            console.log('✅ Cleanup completed:', result);
            process.exit(0);
        })
        .catch(error => {
            console.error('❌ Cleanup failed:', error);
            process.exit(1);
        });
}

module.exports = { cleanupSessions };
