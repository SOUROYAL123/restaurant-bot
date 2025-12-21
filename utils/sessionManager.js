// utils/sessionManager.js
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

class SessionManager {
    async getSession(userPhone, clinicId) {
        try {
            const sessions = await sql`
                SELECT * FROM sessions 
                WHERE user_phone = ${userPhone} 
                AND clinic_id = ${clinicId}
                LIMIT 1
            `;

            if (sessions.length > 0) {
                return {
                    ...sessions[0],
                    temp_data: sessions[0].temp_data || {}
                };
            }

            // Create new session
            const newSession = await sql`
                INSERT INTO sessions (user_phone, clinic_id, current_step, language, temp_data)
                VALUES (${userPhone}, ${clinicId}, 'main_menu', 'en', '{}')
                ON CONFLICT (user_phone, clinic_id) 
                DO UPDATE SET last_activity = NOW()
                RETURNING *
            `;

            return {
                ...newSession[0],
                temp_data: {}
            };

        } catch (error) {
            console.error('❌ Get session error:', error.message);
            return {
                user_phone: userPhone,
                clinic_id: clinicId,
                current_step: 'main_menu',
                language: 'en',
                temp_data: {}
            };
        }
    }

    async updateSession(userPhone, clinicId, updates) {
        try {
            const { current_step, language, temp_data } = updates;

            await sql`
                UPDATE sessions 
                SET 
                    current_step = COALESCE(${current_step}, current_step),
                    language = COALESCE(${language}, language),
                    temp_data = COALESCE(${JSON.stringify(temp_data || {})}, temp_data),
                    last_activity = NOW(),
                    updated_at = NOW()
                WHERE user_phone = ${userPhone} 
                AND clinic_id = ${clinicId}
            `;

        } catch (error) {
            console.error('❌ Update session error:', error.message);
        }
    }

    async clearSession(userPhone, clinicId) {
        try {
            await sql`
                UPDATE sessions 
                SET 
                    current_step = 'main_menu',
                    temp_data = '{}',
                    updated_at = NOW()
                WHERE user_phone = ${userPhone} 
                AND clinic_id = ${clinicId}
            `;
        } catch (error) {
            console.error('Error clearing session:', error.message);
        }
    }
}

module.exports = new SessionManager();
