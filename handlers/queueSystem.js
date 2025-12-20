// handlers/queueSystem.js
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

class QueueSystem {
    constructor() {
        this.initializeTable();
    }

    async initializeTable() {
        try {
            await sql`
                CREATE TABLE IF NOT EXISTS queue_tokens (
                    id SERIAL PRIMARY KEY,
                    token_number INTEGER NOT NULL,
                    customer_id INTEGER REFERENCES customers(id),
                    clinic_id INTEGER REFERENCES clinics(id),
                    status VARCHAR(20) DEFAULT 'waiting',
                    created_at TIMESTAMP DEFAULT NOW(),
                    called_at TIMESTAMP,
                    completed_at TIMESTAMP
                )
            `;
            
            await sql`
                CREATE INDEX IF NOT EXISTS idx_queue_clinic_status 
                ON queue_tokens(clinic_id, status)
            `;
            
            console.log('✅ Queue table initialized');
        } catch (error) {
            console.error('❌ Error initializing queue table:', error);
        }
    }

    async generateToken(customerId, clinicId) {
        try {
            // Get today's date
            const today = new Date().toISOString().split('T')[0];
            
            // Get the last token number for today
            const lastToken = await sql`
                SELECT MAX(token_number) as last_number
                FROM queue_tokens
                WHERE clinic_id = ${clinicId}
                AND DATE(created_at) = ${today}
            `;
            
            const newTokenNumber = (lastToken[0]?.last_number || 0) + 1;
            
            // Create new token
            const result = await sql`
                INSERT INTO queue_tokens 
                (token_number, customer_id, clinic_id, status)
                VALUES (${newTokenNumber}, ${customerId}, ${clinicId}, 'waiting')
                RETURNING id, token_number
            `;
            
            return result[0];
            
        } catch (error) {
            console.error('Error generating token:', error);
            throw error;
        }
    }

    async getPosition(tokenId) {
        try {
            const token = await sql`
                SELECT * FROM queue_tokens WHERE id = ${tokenId}
            `;
            
            if (token.length === 0) {
                return null;
            }
            
            const position = await sql`
                SELECT COUNT(*) as position
                FROM queue_tokens
                WHERE clinic_id = ${token[0].clinic_id}
                AND status = 'waiting'
                AND id < ${tokenId}
            `;
            
            return {
                tokenNumber: token[0].token_number,
                position: parseInt(position[0].position) + 1,
                status: token[0].status
            };
            
        } catch (error) {
            console.error('Error getting position:', error);
            throw error;
        }
    }

    async getQueueStatus(clinicId) {
        try {
            const waiting = await sql`
                SELECT COUNT(*) as count
                FROM queue_tokens
                WHERE clinic_id = ${clinicId}
                AND status = 'waiting'
            `;
            
            const currentToken = await sql`
                SELECT token_number
                FROM queue_tokens
                WHERE clinic_id = ${clinicId}
                AND status = 'serving'
                ORDER BY called_at DESC
                LIMIT 1
            `;
            
            return {
                waiting: parseInt(waiting[0].count),
                current: currentToken[0]?.token_number || null
            };
            
        } catch (error) {
            console.error('Error getting queue status:', error);
            throw error;
        }
    }
}

module.exports = new QueueSystem();
