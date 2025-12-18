const db = require('./config/database');

/**
 * Database-backed session manager
 * Replaces in-memory Map for persistent sessions
 */

/**
 * Get or create user session
 */
async function getSession(phoneNumber) {
    try {
        const result = await db.query(
            `SELECT * FROM sessions WHERE user_phone = $1`,
            [phoneNumber]
        );
        
        if (result.rows.length > 0) {
            const session = result.rows[0];
            
            // Update last activity
            await db.query(
                `UPDATE sessions 
                 SET last_activity = NOW() 
                 WHERE user_phone = $1`,
                [phoneNumber]
            );
            
            return {
                stage: session.stage,
                language: session.language,
                data: session.session_data || {},
                lastActivity: session.last_activity
            };
        }
        
        // Create new session
        await db.query(
            `INSERT INTO sessions (user_phone, stage, language, session_data)
             VALUES ($1, $2, $3, $4)`,
            [phoneNumber, 'initial', 'en', JSON.stringify({})]
        );
        
        return {
            stage: 'initial',
            language: 'en',
            data: {},
            lastActivity: new Date()
        };
        
    } catch (error) {
        console.error('Get session error:', error);
        // Fallback to default session
        return {
            stage: 'initial',
            language: 'en',
            data: {},
            lastActivity: new Date()
        };
    }
}

/**
 * Update user session
 */
async function updateSession(phoneNumber, updates) {
    try {
        const { stage, language, data } = updates;
        
        // Build update query dynamically
        const fields = [];
        const values = [];
        let paramCount = 1;
        
        if (stage !== undefined) {
            fields.push(`stage = $${paramCount++}`);
            values.push(stage);
        }
        
        if (language !== undefined) {
            fields.push(`language = $${paramCount++}`);
            values.push(language);
        }
        
        if (data !== undefined) {
            fields.push(`session_data = $${paramCount++}`);
            values.push(JSON.stringify(data));
        }
        
        if (fields.length === 0) return;
        
        fields.push(`last_activity = NOW()`);
        values.push(phoneNumber);
        
        await db.query(
            `UPDATE sessions 
             SET ${fields.join(', ')}
             WHERE user_phone = $${paramCount}`,
            values
        );
        
    } catch (error) {
        console.error('Update session error:', error);
        throw error;
    }
}

/**
 * Clear user session
 */
async function clearSession(phoneNumber) {
    try {
        await db.query(
            `DELETE FROM sessions WHERE user_phone = $1`,
            [phoneNumber]
        );
    } catch (error) {
        console.error('Clear session error:', error);
    }
}

/**
 * Cleanup old sessions (>30 minutes inactive)
 * Run this periodically or as cron job
 */
async function cleanupSessions() {
    try {
        const result = await db.query(
            `DELETE FROM sessions 
             WHERE last_activity < NOW() - INTERVAL '30 minutes'
             RETURNING user_phone`
        );
        
        console.log(`🧹 Cleaned up ${result.rowCount} inactive sessions`);
        return result.rowCount;
        
    } catch (error) {
        console.error('Cleanup sessions error:', error);
        return 0;
    }
}

/**
 * Get session statistics
 */
async function getSessionStats() {
    try {
        const result = await db.query(`
            SELECT 
                COUNT(*) as total_sessions,
                COUNT(CASE WHEN last_activity > NOW() - INTERVAL '5 minutes' THEN 1 END) as active_5min,
                COUNT(CASE WHEN last_activity > NOW() - INTERVAL '30 minutes' THEN 1 END) as active_30min,
                COUNT(CASE WHEN stage != 'initial' THEN 1 END) as in_conversation
            FROM sessions
        `);
        
        return result.rows[0];
        
    } catch (error) {
        console.error('Get session stats error:', error);
        return null;
    }
}

module.exports = {
    getSession,
    updateSession,
    clearSession,
    cleanupSessions,
    getSessionStats
};
