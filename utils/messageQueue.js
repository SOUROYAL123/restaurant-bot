const { neon } = require('@neondatabase/serverless');
const { sendWhatsAppMessage } = require('./twilioClient');
const logger = require('./logger');

const sql = neon(process.env.DATABASE_URL);

class MessageQueue {
    /**
     * Add message to queue
     */
    async enqueue(phone, message) {
        try {
            const result = await sql`
                INSERT INTO pending_messages (phone, message, status, attempts)
                VALUES (${phone}, ${message}, 'pending', 0)
                RETURNING id
            `;
            
            logger.info('Message queued', { 
                messageId: result[0].id, 
                phone 
            });
            
            return result[0].id;
            
        } catch (error) {
            logger.error('Failed to queue message', error);
            throw error;
        }
    }
    
    /**
     * Process pending messages
     */
    async processPending() {
        try {
            const pending = await sql`
                SELECT * FROM pending_messages
                WHERE status = 'pending'
                AND attempts < 3
                ORDER BY created_at ASC
                LIMIT 10
            `;
            
            logger.info(`Processing ${pending.length} pending messages`);
            
            let sent = 0;
            let failed = 0;
            
            for (const msg of pending) {
                try {
                    await sendWhatsAppMessage(msg.phone, msg.message);
                    
                    await sql`
                        UPDATE pending_messages
                        SET status = 'sent', sent_at = NOW()
                        WHERE id = ${msg.id}
                    `;
                    
                    sent++;
                    logger.success('Message sent', { messageId: msg.id });
                    
                } catch (error) {
                    await sql`
                        UPDATE pending_messages
                        SET 
                            attempts = attempts + 1,
                            last_error = ${error.message}
                        WHERE id = ${msg.id}
                    `;
                    
                    failed++;
                    logger.error('Message failed', error);
                }
                
                // Rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            return { sent, failed };
            
        } catch (error) {
            logger.error('Queue processing failed', error);
            throw error;
        }
    }
}

module.exports = new MessageQueue();
