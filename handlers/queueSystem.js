/**
 * ═══════════════════════════════════════════════════════════
 * QUEUE/TOKEN SYSTEM
 * Walk-in patient token management
 * ═══════════════════════════════════════════════════════════
 */

const db = require('../config/database');
const { sendWhatsAppMessage } = require('../utils/twilioClient');

class QueueSystem {
    
    /**
     * Initialize queue table
     */
    static async initializeTable() {
        const query = `
            CREATE TABLE IF NOT EXISTS queue_tokens (
                id SERIAL PRIMARY KEY,
                clinic_id INTEGER REFERENCES clinics(id),
                token_number INTEGER NOT NULL,
                patient_name VARCHAR(100),
                patient_phone VARCHAR(20) NOT NULL,
                status VARCHAR(20) DEFAULT 'waiting',
                issue_time TIMESTAMP DEFAULT NOW(),
                called_time TIMESTAMP,
                completed_time TIMESTAMP,
                queue_date DATE DEFAULT CURRENT_DATE,
                estimated_wait_minutes INTEGER,
                UNIQUE(clinic_id, token_number, queue_date)
            );
            
            CREATE INDEX IF NOT EXISTS idx_queue_clinic_date ON queue_tokens(clinic_id, queue_date);
            CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_tokens(status);
        `;
        
        await db.query(query);
    }
    
    /**
     * Issue new token
     */
    static async issueToken(clinicId, patientPhone, patientName = null) {
        try {
            // Get current date
            const today = new Date().toISOString().split('T')[0];
            
            // Get last token number for today
            const lastToken = await db.query(
                `SELECT MAX(token_number) as last_number 
                 FROM queue_tokens 
                 WHERE clinic_id = $1 AND queue_date = $2`,
                [clinicId, today]
            );
            
            const tokenNumber = (lastToken.rows[0].last_number || 0) + 1;
            
            // Count waiting tokens
            const waiting = await db.query(
                `SELECT COUNT(*) as count 
                 FROM queue_tokens 
                 WHERE clinic_id = $1 
                 AND queue_date = $2 
                 AND status = 'waiting'`,
                [clinicId, today]
            );
            
            const waitingCount = parseInt(waiting.rows[0].count);
            
            // Calculate estimated wait (15 mins per patient average)
            const estimatedWait = waitingCount * 15;
            
            // Insert token
            const result = await db.query(
                `INSERT INTO queue_tokens 
                 (clinic_id, token_number, patient_name, patient_phone, 
                  queue_date, estimated_wait_minutes, status)
                 VALUES ($1, $2, $3, $4, $5, $6, 'waiting')
                 RETURNING id`,
                [clinicId, tokenNumber, patientName, patientPhone, today, estimatedWait]
            );
            
            return {
                success: true,
                tokenId: result.rows[0].id,
                tokenNumber: tokenNumber,
                position: waitingCount + 1,
                estimatedWait: estimatedWait
            };
            
        } catch (error) {
            console.error('Error issuing token:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Get current token status
     */
    static async getTokenStatus(clinicId, today = null) {
        try {
            if (!today) {
                today = new Date().toISOString().split('T')[0];
            }
            
            // Current serving token
            const current = await db.query(
                `SELECT token_number, patient_name 
                 FROM queue_tokens 
                 WHERE clinic_id = $1 
                 AND queue_date = $2 
                 AND status = 'serving'
                 LIMIT 1`,
                [clinicId, today]
            );
            
            // Count waiting
            const waiting = await db.query(
                `SELECT COUNT(*) as count 
                 FROM queue_tokens 
                 WHERE clinic_id = $1 
                 AND queue_date = $2 
                 AND status = 'waiting'`,
                [clinicId, today]
            );
            
            // Total tokens issued
            const total = await db.query(
                `SELECT COUNT(*) as count 
                 FROM queue_tokens 
                 WHERE clinic_id = $1 
                 AND queue_date = $2`,
                [clinicId, today]
            );
            
            return {
                currentToken: current.rows.length > 0 ? current.rows[0].token_number : null,
                waitingCount: parseInt(waiting.rows[0].count),
                totalIssued: parseInt(total.rows[0].count)
            };
            
        } catch (error) {
            console.error('Error getting token status:', error.message);
            return null;
        }
    }
    
    /**
     * Check patient's token position
     */
    static async checkMyToken(clinicId, patientPhone) {
        try {
            const today = new Date().toISOString().split('T')[0];
            
            const token = await db.query(
                `SELECT * FROM queue_tokens 
                 WHERE clinic_id = $1 
                 AND patient_phone = $2 
                 AND queue_date = $3 
                 AND status IN ('waiting', 'serving')
                 ORDER BY issue_time DESC 
                 LIMIT 1`,
                [clinicId, patientPhone, today]
            );
            
            if (token.rows.length === 0) {
                return null;
            }
            
            const myToken = token.rows[0];
            
            // Count tokens before me
            const ahead = await db.query(
                `SELECT COUNT(*) as count 
                 FROM queue_tokens 
                 WHERE clinic_id = $1 
                 AND queue_date = $2 
                 AND status = 'waiting'
                 AND token_number < $3`,
                [clinicId, today, myToken.token_number]
            );
            
            const status = await this.getTokenStatus(clinicId, today);
            
            return {
                tokenNumber: myToken.token_number,
                status: myToken.status,
                position: parseInt(ahead.rows[0].count) + 1,
                currentServing: status.currentToken,
                estimatedWait: parseInt(ahead.rows[0].count) * 15
            };
            
        } catch (error) {
            console.error('Error checking token:', error.message);
            return null;
        }
    }
    
    /**
     * Call next token (doctor command)
     */
    static async callNext(clinicId) {
        try {
            const today = new Date().toISOString().split('T')[0];
            
            // Mark current as completed
            await db.query(
                `UPDATE queue_tokens 
                 SET status = 'completed', completed_time = NOW()
                 WHERE clinic_id = $1 
                 AND queue_date = $2 
                 AND status = 'serving'`,
                [clinicId, today]
            );
            
            // Get next waiting token
            const next = await db.query(
                `SELECT * FROM queue_tokens 
                 WHERE clinic_id = $1 
                 AND queue_date = $2 
                 AND status = 'waiting'
                 ORDER BY token_number 
                 LIMIT 1`,
                [clinicId, today]
            );
            
            if (next.rows.length === 0) {
                return {
                    success: false,
                    message: 'No patients waiting in queue.'
                };
            }
            
            const nextToken = next.rows[0];
            
            // Mark as serving
            await db.query(
                `UPDATE queue_tokens 
                 SET status = 'serving', called_time = NOW()
                 WHERE id = $1`,
                [nextToken.id]
            );
            
            // Notify patient
            await this.notifyPatientTurn(nextToken);
            
            return {
                success: true,
                tokenNumber: nextToken.token_number,
                patientName: nextToken.patient_name,
                patientPhone: nextToken.patient_phone
            };
            
        } catch (error) {
            console.error('Error calling next token:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Notify patient their turn is next
     */
    static async notifyPatientTurn(token) {
        try {
            const message = `🔔 *Your Turn!*\n\n` +
                `🎫 Token #${token.token_number}\n\n` +
                `Please proceed to the consultation room.\n\n` +
                `Thank you for your patience! 🙏`;
            
            await sendWhatsAppMessage(token.patient_phone, message);
            
        } catch (error) {
            console.error('Error notifying patient:', error.message);
        }
    }
    
    /**
     * Format token message
     */
    static formatTokenMessage(tokenInfo, status) {
        const message = `🎫 *Token Issued!*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `🔢 Your Token: *#${tokenInfo.tokenNumber}*\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `📊 Current Status:\n` +
            `• Now Serving: ${status.currentToken ? `#${status.currentToken}` : 'None'}\n` +
            `• Your Position: ${tokenInfo.position}\n` +
            `• Waiting: ${status.waitingCount} patients\n\n` +
            `⏱️ Estimated Wait: *${tokenInfo.estimatedWait} minutes*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `📱 We'll notify you when it's your turn!\n\n` +
            `💡 Check status anytime: Reply "TOKEN STATUS"`;
        
        return message;
    }
}

// Initialize table on load
QueueSystem.initializeTable().catch(console.error);

module.exports = QueueSystem;
