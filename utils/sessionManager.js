const db = require('../config/database');

async function getSession(phoneNumber) {
    try {
        const result = await db.query(
            `SELECT * FROM sessions WHERE user_phone = $1`,
            [phoneNumber]
        );
        
        if (result.rows.length > 0) {
            const session = result.rows[0];
            await db.query(
                `UPDATE sessions SET last_activity = NOW() WHERE user_phone = $1`,
                [phoneNumber]
            );
            
            return {
                stage: session.stage,
                language: session.language,
                data: session.session_data || {},
                lastActivity: session.last_activity
            };
        }
        
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
        return { stage: 'initial', language: 'en', data: {}, lastActivity: new Date() };
    }
}

async function updateSession(phoneNumber, updates) {
    try {
        const { stage, language, data } = updates;
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
            `UPDATE sessions SET ${fields.join(', ')} WHERE user_phone = $${paramCount}`,
            values
        );
    } catch (error) {
        console.error('Update session error:', error);
        throw error;
    }
}

async function cleanupSessions() {
    try {
        const result = await db.query(
            `DELETE FROM sessions WHERE last_activity < NOW() - INTERVAL '30 minutes' RETURNING user_phone`
        );
        console.log(`🧹 Cleaned up ${result.rowCount} inactive sessions`);
        return result.rowCount;
    } catch (error) {
        console.error('Cleanup sessions error:', error);
        return 0;
    }
}

module.exports = {
    getSession,
    updateSession,
    cleanupSessions
};
