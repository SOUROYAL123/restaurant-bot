const db = require('../config/database');

async function getSession(phoneNumber, clinicId) {
    try {
        const result = await db.query(
            `SELECT * FROM sessions WHERE user_phone = $1 AND clinic_id = $2`,
            [phoneNumber, clinicId]
        );
        
        if (result.rows.length > 0) {
            const session = result.rows[0];
            
            // Update last activity
            await db.query(
                `UPDATE sessions SET last_activity = NOW() WHERE user_phone = $1 AND clinic_id = $2`,
                [phoneNumber, clinicId]
            );
            
            return {
                user_phone: phoneNumber,
                clinic_id: clinicId,
                current_step: session.current_step || 'main_menu',
                language: session.language || 'en',
                temp_data: session.temp_data || {},
                last_activity: session.last_activity
            };
        }
        
        // Create new session if doesn't exist
        await db.query(
            `INSERT INTO sessions (user_phone, clinic_id, current_step, language, temp_data, last_activity, created_at, updated_at)
             VALUES ($1, $2, 'main_menu', 'en', '{}', NOW(), NOW(), NOW())
             ON CONFLICT (user_phone, clinic_id) DO NOTHING`,
            [phoneNumber, clinicId]
        );
        
        return {
            user_phone: phoneNumber,
            clinic_id: clinicId,
            current_step: 'main_menu',
            language: 'en',
            temp_data: {},
            last_activity: new Date()
        };
    } catch (error) {
        console.error('❌ Get session error:', error.message);
        return { 
            user_phone: phoneNumber,
            clinic_id: clinicId,
            current_step: 'main_menu', 
            language: 'en', 
            temp_data: {}, 
            last_activity: new Date() 
        };
    }
}

async function updateSession(phoneNumber, clinicId, stage, tempData = {}) {
    try {
        await db.query(
            `UPDATE sessions 
             SET current_step = $3, 
                 temp_data = $4,
                 last_activity = NOW(),
                 updated_at = NOW()
             WHERE user_phone = $1 AND clinic_id = $2`,
            [phoneNumber, clinicId, stage, JSON.stringify(tempData)]
        );
    } catch (error) {
        console.error('❌ Update session error:', error.message);
    }
}

async function clearSession(phoneNumber, clinicId) {
    try {
        await db.query(
            `DELETE FROM sessions WHERE user_phone = $1 AND clinic_id = $2`,
            [phoneNumber, clinicId]
        );
    } catch (error) {
        console.error('❌ Clear session error:', error.message);
    }
}

async function cleanupSessions() {
    try {
        const result = await db.query(
            `DELETE FROM sessions 
             WHERE last_activity < NOW() - INTERVAL '30 minutes' 
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
        console.error('❌ Get session stats error:', error.message);
        return { total_sessions: 0 };
    }
}

module.exports = {
    getSession,
    updateSession,
    clearSession,
    cleanupSessions,
    getSessionStats
};
