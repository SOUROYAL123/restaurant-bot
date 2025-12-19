const db = require('../config/database');

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
                `UPDATE sessions SET last_activity = NOW() WHERE user_phone = $1`,
                [phoneNumber]
            );
            
            return {
                stage: session.current_step || session.stage || 'initial',
                language: session.language || 'en',
                data: session.temp_data || session.session_data || {},
                lastActivity: session.last_activity
            };
        }
        
        // Create new session
        await db.query(
            `INSERT INTO sessions (user_phone, current_step, language, temp_data, last_activity)
             VALUES ($1, $2, $3, $4, NOW())`,
            [phoneNumber, 'initial', 'en', JSON.stringify({})]
        );
        
        return {
            stage: 'initial',
            language: 'en',
            data: {},
            lastActivity: new Date()
        };
    } catch (error) {
        console.error('Get session error:', error.message);
        return { 
            stage: 'initial', 
            language: 'en', 
            data: {}, 
            lastActivity: new Date() 
        };
    }
}

async function updateSession(phoneNumber, updates) {
    try {
        const { stage, language, data } = updates;
        const fields = [];
        const values = [];
        let paramCount = 1;
        
        if (stage !== undefined) {
            fields.push(`current_step = $${paramCount++}`);
            values.push(stage);
        }
        
        if (language !== undefined) {
            fields.push(`language = $${paramCount++}`);
            values.push(language);
        }
        
        if (data !== undefined) {
            fields.push(`temp_data = $${paramCount++}`);
            values.push(JSON.stringify(data));
        }
        
        if (fields.length === 0) return;
        
        fields.push(`last_activity = NOW()`);
        fields.push(`updated_at = NOW()`);
        values.push(phoneNumber);
        
        await db.query(
            `UPDATE sessions SET ${fields.join(', ')} WHERE user_phone = $${paramCount}`,
            values
        );
    } catch (error) {
        console.error('Update session error:', error.message);
        throw error;
    }
}

async function cleanupSessions() {
    try {
        const result = await db.query(
            `DELETE FROM sessions 
             WHERE sessions.last_activity < NOW() - INTERVAL '30 minutes' 
             RETURNING user_phone`
        );
        
        if (result.rowCount > 0) {
            console.log(`🧹 Cleaned up ${result.rowCount} inactive sessions`);
        }
        
        return result.rowCount;
    } catch (error) {
        console.error('❌ Cleanup sessions error:', error.message);
        return 0;
    }
}

async function getSessionStats() {
    try {
        const result = await db.query(
            `SELECT 
                COUNT(*) as total_sessions,
                COUNT(CASE WHEN last_activity > NOW() - INTERVAL '5 minutes' THEN 1 END) as active_last_5min,
                COUNT(CASE WHEN last_activity > NOW() - INTERVAL '30 minutes' THEN 1 END) as active_last_30min
             FROM sessions`
        );
        return result.rows[0];
    } catch (error) {
        console.error('Get session stats error:', error.message);
        return { total_sessions: 0 };
    }
}

module.exports = {
    getSession,
    updateSession,
    cleanupSessions,
    getSessionStats
};
