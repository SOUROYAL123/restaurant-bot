/**
 * ═══════════════════════════════════════════════════════════
 * WhatsApp Multi-Clinic Appointment Bot - Production v3.0
 * 
 * Features:
 * - Multi-clinic support with data segregation
 * - Auto-approval/rejection workflow
 * - Doctor approval via WhatsApp commands
 * - Google Sheets logging per clinic
 * - Session management
 * - Message queue for reliability
 * - Rate limiting & security
 * - Comprehensive logging
 * 
 * Author: Sourav Roy (Legacylens Automation)
 * Repository: https://github.com/SOUROYAL123/clinis_database_bot-.git
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { neon } = require('@neondatabase/serverless');

// ═══════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════

const app = express();
const sql = neon(process.env.DATABASE_URL);

// Trust proxy for Render.com
app.set('trust proxy', 1);

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ═══════════════════════════════════════════════════════════
// IMPORT UTILITIES WITH FALLBACKS
// ═══════════════════════════════════════════════════════════

const { sendWhatsAppMessage } = require('./utils/twilioClient');
const GoogleSheetsLogger = require('./utils/googleSheetsLogger');

// Logger with fallback
let logger;
try {
    logger = require('./utils/logger');
} catch (e) {
    logger = {
        info: (msg, data) => console.log('[INFO]', msg, data || ''),
        success: (msg, data) => console.log('[SUCCESS]', msg, data || ''),
        warning: (msg, data) => console.log('[WARNING]', msg, data || ''),
        error: (msg, err) => console.error('[ERROR]', msg, err?.message || err),
        appointment: (action, id, data) => console.log('[APPOINTMENT]', action, id, data || '')
    };
}

// Message Queue with fallback
let messageQueue;
try {
    messageQueue = require('./utils/messageQueue');
} catch (e) {
    logger.warning('Message queue not available, using fallback');
    messageQueue = {
        enqueue: async (phone, msg) => {
            logger.info('Message queue unavailable, sending directly');
            try {
                await sendWhatsAppMessage(phone, msg);
            } catch (error) {
                logger.error('Failed to send message', error);
            }
            return null;
        }
    };
}

// Security middleware with fallback
let webhookLimiter, verifyTwilioSignature;
try {
    const security = require('./middleware/security');
    webhookLimiter = security.webhookLimiter;
    verifyTwilioSignature = security.verifyTwilioSignature;
} catch (e) {
    logger.warning('Security middleware not found, using passthrough');
    webhookLimiter = (req, res, next) => next();
    verifyTwilioSignature = (req, res, next) => next();
}

// Admin routes with fallback
try {
    const adminRoutes = require('./routes/admin');
    app.use('/api/admin', adminRoutes);
    logger.info('Admin routes loaded successfully');
} catch (e) {
    logger.warning('Admin routes not found, skipping');
}

// ═══════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════

async function getOrCreateSession(userPhone) {
    try {
        let sessions = await sql`
            SELECT * FROM sessions WHERE user_phone = ${userPhone}
        `;
        
        if (sessions.length === 0) {
            await sql`
                INSERT INTO sessions (user_phone, stage, session_data)
                VALUES (${userPhone}, 'select_clinic', '{}')
            `;
            
            sessions = await sql`
                SELECT * FROM sessions WHERE user_phone = ${userPhone}
            `;
        } else {
            // Update last activity
            await sql`
                UPDATE sessions 
                SET last_activity = NOW()
                WHERE user_phone = ${userPhone}
            `;
        }
        
        return sessions[0];
        
    } catch (error) {
        logger.error('Session management error', error);
        throw error;
    }
}

async function updateSession(userPhone, updates) {
    try {
        const { stage, clinic_id, session_data } = updates;
        
        await sql`
            UPDATE sessions
            SET 
                stage = COALESCE(${stage}, stage),
                clinic_id = COALESCE(${clinic_id}, clinic_id),
                session_data = COALESCE(${session_data ? JSON.stringify(session_data) : null}::jsonb, session_data),
                last_activity = NOW(),
                updated_at = NOW()
            WHERE user_phone = ${userPhone}
        `;
        
    } catch (error) {
        logger.error('Session update error', error);
        throw error;
    }
}

async function clearSession(userPhone) {
    try {
        await sql`
            UPDATE sessions
            SET 
                stage = 'select_clinic',
                clinic_id = NULL,
                session_data = '{}'::jsonb,
                updated_at = NOW()
            WHERE user_phone = ${userPhone}
        `;
    } catch (error) {
        logger.error('Session clear error', error);
    }
}

// ═══════════════════════════════════════════════════════════
// CUSTOMER MANAGEMENT
// ═══════════════════════════════════════════════════════════

async function getOrCreateCustomer(userPhone, clinicId, name = null) {
    try {
        let customers = await sql`
            SELECT * FROM customers 
            WHERE phone = ${userPhone} 
            AND clinic_id = ${clinicId}
        `;
        
        if (customers.length === 0) {
            const result = await sql`
                INSERT INTO customers (clinic_id, phone, name, status)
                VALUES (${clinicId}, ${userPhone}, ${name || `User ${userPhone.slice(-4)}`}, 'active')
                RETURNING id
            `;
            
            return result[0].id;
        } else {
            // Update name if provided
            if (name) {
                await sql`
                    UPDATE customers
                    SET name = ${name}, last_contact_date = NOW()
                    WHERE id = ${customers[0].id}
                `;
            }
            
            return customers[0].id;
        }
        
    } catch (error) {
        logger.error('Customer management error', error);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════
// DOCTOR COMMANDS (APPROVE/REJECT)
// ═══════════════════════════════════════════════════════════

async function handleDoctorCommand(userPhone, message) {
    try {
        const upperMessage = message.toUpperCase();
        
        if (!upperMessage.startsWith('APPROVE #') && !upperMessage.startsWith('REJECT #')) {
            return null;
        }
        
        const match = upperMessage.match(/#(\d+)/);
        if (!match) {
            return '❌ Invalid format. Use: APPROVE #123 or REJECT #123';
        }
        
        const appointmentId = match[1];
        const isApprove = upperMessage.startsWith('APPROVE');
        
        // Verify doctor and get appointment
        const appointments = await sql`
            SELECT a.*, c.doctor_whatsapp, c.google_sheet_id, c.name as clinic_name
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE a.id = ${appointmentId}
        `;
        
        if (appointments.length === 0) {
            return `❌ Appointment #${appointmentId} not found.`;
        }
        
        const appt = appointments[0];
        const doctorPhone = appt.doctor_whatsapp.replace('whatsapp:', '');
        
        if (userPhone !== doctorPhone) {
            return '❌ You are not authorized to manage this appointment.';
        }
        
        if (appt.status !== 'pending') {
            return `⚠️ Appointment #${appointmentId} is already ${appt.status}.`;
        }
        
        const newStatus = isApprove ? 'confirmed' : 'rejected';
        const timestamp = new Date();
        
        // Update appointment status
        if (isApprove) {
            await sql`
                UPDATE appointments
                SET 
                    status = 'confirmed',
                    approved_at = ${timestamp},
                    updated_at = NOW()
                WHERE id = ${appointmentId}
            `;
        } else {
            await sql`
                UPDATE appointments
                SET 
                    status = 'rejected',
                    rejected_at = ${timestamp},
                    updated_at = NOW()
                WHERE id = ${appointmentId}
            `;
        }
        
        logger.appointment(isApprove ? 'approved' : 'rejected', appointmentId, {
            doctor: userPhone,
            clinic: appt.clinic_name
        });
        
        // Update Google Sheets
        if (appt.google_sheet_id) {
            try {
                await GoogleSheetsLogger.updateAppointmentStatus(
                    appt.google_sheet_id,
                    appointmentId,
                    newStatus,
                    timestamp.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
                );
            } catch (error) {
                logger.warning('Google Sheets update failed', { error: error.message });
            }
        }
        
        // Notify patient
        const patientMessage = isApprove
            ? `✅ *Appointment Confirmed*\n\n` +
              `📋 Booking #${appointmentId}\n` +
              `🏥 ${appt.clinic_name}\n` +
              `📅 ${appt.appointment_date}\n` +
              `🕒 ${appt.appointment_time}\n\n` +
              `Your appointment has been confirmed!\n` +
              `Please arrive 10 minutes early.`
            : `❌ *Appointment Not Available*\n\n` +
              `📋 Booking #${appointmentId}\n\n` +
              `Unfortunately, this slot is not available.\n` +
              `Please book a different time.\n\n` +
              `Reply "1" to book again.`;
        
        // Queue or send message to patient
        try {
            await sendWhatsAppMessage(appt.patient_phone, patientMessage);
        } catch (error) {
            logger.warning('Failed to send patient notification, queuing', { error: error.message });
            await messageQueue.enqueue(appt.patient_phone, patientMessage);
        }
        
        return `✅ Appointment #${appointmentId} ${isApprove ? 'APPROVED' : 'REJECTED'}\n\n` +
               `Patient will be notified automatically.`;
        
    } catch (error) {
        logger.error('Doctor command error', error);
        return '❌ Error processing command. Please try again.';
    }
}

// ═══════════════════════════════════════════════════════════
// DOCTOR NOTIFICATION
// ═══════════════════════════════════════════════════════════

async function notifyDoctor(appointmentId) {
    try {
        const appointments = await sql`
            SELECT 
                a.*,
                c.name as clinic_name,
                c.doctor_name,
                c.doctor_whatsapp,
                c.auto_approve,
                c.auto_approve_after_hours
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE a.id = ${appointmentId}
        `;
        
        if (appointments.length === 0) {
            logger.warning('Appointment not found for notification', { appointmentId });
            return false;
        }
        
        const appt = appointments[0];
        
        const date = new Date(appt.appointment_date).toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
            timeZone: 'Asia/Kolkata'
        });
        
        const autoApproveInfo = appt.auto_approve 
            ? `\n⏰ Will auto-approve in ${appt.auto_approve_after_hours} hours if no response`
            : '';
        
        const message = `🔔 *New Appointment Request*\n\n` +
            `📋 ID: #${appt.id}\n` +
            `🏥 Clinic: ${appt.clinic_name}\n` +
            `👤 Patient: ${appt.patient_name}\n` +
            `📞 Phone: ${appt.patient_phone}\n` +
            `📅 Date: ${date}\n` +
            `🕒 Time: ${appt.appointment_time}\n` +
            `${appt.service ? `💊 Service: ${appt.service}\n` : ''}` +
            `\n━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `To approve: *APPROVE #${appt.id}*\n` +
            `To reject: *REJECT #${appt.id}*${autoApproveInfo}`;
        
        await sendWhatsAppMessage(appt.doctor_whatsapp, message);
        
        logger.success('Doctor notification sent', { 
            appointmentId, 
            doctor: appt.doctor_whatsapp 
        });
        
        return true;
        
    } catch (error) {
        logger.error('Doctor notification error', error);
        return false;
    }
}

// ═══════════════════════════════════════════════════════════
// MAIN WEBHOOK HANDLER
// ═══════════════════════════════════════════════════════════

app.post('/webhook', webhookLimiter, verifyTwilioSignature, async (req, res) => {
    try {
        const from = req.body.From;
        const body = req.body.Body || '';
        
        if (!from) {
            return res.sendStatus(200);
        }
        
        const userPhone = from.replace('whatsapp:', '');
        const message = body.trim();
        
        logger.info('Webhook received', { 
            from: userPhone, 
            message: message.substring(0, 50) 
        });
        
        // Get or create session
        const session = await getOrCreateSession(userPhone);
        let reply = '';
        
        // ═══════════════════════════════════════════════════════════
        // DOCTOR COMMANDS (APPROVE/REJECT)
        // ═══════════════════════════════════════════════════════════
        
        const doctorResponse = await handleDoctorCommand(userPhone, message);
        if (doctorResponse) {
            res.set('Content-Type', 'text/xml');
            return res.send(`
                <Response>
                    <Message>${doctorResponse}</Message>
                </Response>
            `);
        }
        
        // ═══════════════════════════════════════════════════════════
        // PATIENT BOOKING FLOW
        // ═══════════════════════════════════════════════════════════
        
        if (message.toLowerCase() === 'hi' || message === '1') {
            // Show clinic list
            const clinics = await sql`
                SELECT id, name, doctor_name
                FROM clinics
                WHERE status = 'active'
                ORDER BY id
            `;
            
            if (clinics.length === 0) {
                reply = `❌ No clinics available at the moment.\n\nPlease contact support.`;
            } else if (clinics.length === 1) {
                // Auto-select single clinic
                await updateSession(userPhone, { 
                    stage: 'booking_name', 
                    clinic_id: clinics[0].id 
                });
                
                reply = `🏥 Welcome to ${clinics[0].name}\n` +
                        `👨‍⚕️ Dr. ${clinics[0].doctor_name}\n\n` +
                        `👤 What is your full name?`;
            } else {
                // Multiple clinics - show selection
                reply = `🏥 *Select Your Clinic*\n\n`;
                clinics.forEach((clinic, i) => {
                    reply += `${i + 1}. ${clinic.name}\n   👨‍⚕️ Dr. ${clinic.doctor_name}\n\n`;
                });
                reply += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
                reply += `Reply with number (1-${clinics.length})`;
                
                await updateSession(userPhone, { stage: 'select_clinic' });
            }
        }
        
        // ═══════════════════════════════════════════════════════════
        // CLINIC SELECTION
        // ═══════════════════════════════════════════════════════════
        
        else if (session.stage === 'select_clinic') {
            const clinicIndex = parseInt(message) - 1;
            
            const clinics = await sql`
                SELECT id, name
                FROM clinics
                WHERE status = 'active'
                ORDER BY id
            `;
            
            if (clinicIndex >= 0 && clinicIndex < clinics.length) {
                const selectedClinic = clinics[clinicIndex];
                
                await updateSession(userPhone, { 
                    stage: 'booking_name', 
                    clinic_id: selectedClinic.id 
                });
                
                reply = `✅ ${selectedClinic.name} selected\n\n` +
                        `👤 What is your full name?`;
            } else {
                reply = `❌ Invalid selection.\n\n` +
                        `Please reply with a number between 1 and ${clinics.length}`;
            }
        }
        
        // ═══════════════════════════════════════════════════════════
        // BOOKING NAME
        // ═══════════════════════════════════════════════════════════
        
        else if (session.stage === 'booking_name') {
            if (message.length < 2) {
                reply = `❌ Please enter a valid name.\n\nExample: John Doe`;
            } else {
                const sessionData = session.session_data || {};
                sessionData.name = message;
                
                await updateSession(userPhone, { 
                    stage: 'booking_date',
                    session_data: sessionData
                });
                
                reply = `📅 Enter appointment date\n\n` +
                        `Format: DD-MM-YYYY\n` +
                        `Example: 28-12-2025`;
            }
        }
        
        // ═══════════════════════════════════════════════════════════
        // BOOKING DATE
        // ═══════════════════════════════════════════════════════════
        
        else if (session.stage === 'booking_date') {
            const dateMatch = message.match(/^(\d{2})-(\d{2})-(\d{4})$/);
            
            if (!dateMatch) {
                reply = `❌ Invalid format.\n\n` +
                        `Use: DD-MM-YYYY\n` +
                        `Example: 28-12-2025`;
            } else {
                const [, day, month, year] = dateMatch;
                const dateStr = `${year}-${month}-${day}`;
                const appointmentDate = new Date(dateStr);
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                
                if (appointmentDate < today) {
                    reply = `❌ Cannot book appointments in the past.\n\n` +
                            `Please enter a future date.`;
                } else {
                    const sessionData = session.session_data || {};
                    sessionData.date = dateStr;
                    
                    await updateSession(userPhone, { 
                        stage: 'booking_time',
                        session_data: sessionData
                    });
                    
                    const formattedDate = appointmentDate.toLocaleDateString('en-IN', {
                        weekday: 'long',
                        day: '2-digit',
                        month: 'long',
                        year: 'numeric',
                        timeZone: 'Asia/Kolkata'
                    });
                    
                    reply = `📅 ${formattedDate}\n\n` +
                            `🕒 Enter preferred time\n\n` +
                            `Format: HH:MM AM/PM\n` +
                            `Example: 2:00 PM`;
                }
            }
        }
        
        // ═══════════════════════════════════════════════════════════
        // BOOKING TIME + CREATE APPOINTMENT
        // ═══════════════════════════════════════════════════════════
        
        else if (session.stage === 'booking_time') {
            const sessionData = session.session_data || {};
            const name = sessionData.name;
            const date = sessionData.date;
            
            // Create customer
            const customerId = await getOrCreateCustomer(userPhone, session.clinic_id, name);
            
            // Create appointment
            const result = await sql`
                INSERT INTO appointments (
                    clinic_id,
                    customer_id,
                    patient_name,
                    patient_phone,
                    appointment_date,
                    appointment_time,
                    appointment_slot,
                    status,
                    created_at
                )
                VALUES (
                    ${session.clinic_id},
                    ${customerId},
                    ${name},
                    ${userPhone},
                    ${date},
                    ${message},
                    ${message},
                    'pending',
                    NOW()
                )
                RETURNING id
            `;
            
            const appointmentId = result[0].id;
            
            logger.appointment('created', appointmentId, {
                clinic: session.clinic_id,
                patient: name,
                date,
                time: message
            });
            
            // Get clinic info
            const clinics = await sql`
                SELECT name, google_sheet_id
                FROM clinics
                WHERE id = ${session.clinic_id}
            `;
            
            const clinic = clinics[0];
            
            // Log to Google Sheets
            if (clinic.google_sheet_id) {
                try {
                    await GoogleSheetsLogger.logAppointment(clinic.google_sheet_id, {
                        id: appointmentId,
                        appointment_date: date,
                        appointment_time: message,
                        patient_name: name,
                        patient_phone: userPhone,
                        status: 'pending',
                        doctor_name: '',
                        created_at: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
                    });
                } catch (error) {
                    logger.warning('Google Sheets logging failed', { error: error.message });
                }
            }
            
            // Notify doctor
            await notifyDoctor(appointmentId);
            
            // Clear session
            await clearSession(userPhone);
            
            const formattedDate = new Date(date).toLocaleDateString('en-IN', {
                day: '2-digit',
                month: 'long',
                year: 'numeric',
                timeZone: 'Asia/Kolkata'
            });
            
            reply = `✅ *Booking Request Submitted*\n\n` +
                    `📋 Booking ID: #${appointmentId}\n` +
                    `🏥 ${clinic.name}\n` +
                    `👤 ${name}\n` +
                    `📅 ${formattedDate}\n` +
                    `🕒 ${message}\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `⏳ Waiting for doctor approval...\n\n` +
                    `You'll receive confirmation soon!\n\n` +
                    `To book another appointment, reply "1"`;
        }
        
        // ═══════════════════════════════════════════════════════════
        // DEFAULT
        // ═══════════════════════════════════════════════════════════
        
        else {
            reply = `👋 Welcome to our clinic!\n\n` +
                    `Reply "hi" or "1" to book an appointment.`;
        }
        
        // Send reply
        res.set('Content-Type', 'text/xml');
        res.send(`
            <Response>
                <Message>${reply}</Message>
            </Response>
        `);
        
    } catch (error) {
        logger.error('Webhook error', error);
        
        res.set('Content-Type', 'text/xml');
        res.send(`
            <Response>
                <Message>❌ An error occurred. Please try again or contact support.</Message>
            </Response>
        `);
    }
});

// ═══════════════════════════════════════════════════════════
// HEALTH CHECK ENDPOINTS
// ═══════════════════════════════════════════════════════════

// Simple ping endpoint for quick health checks
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// Detailed health check with database verification
app.get('/health', async (req, res) => {
    try {
        // Quick database check with 5 second timeout
        const dbCheck = await Promise.race([
            sql`SELECT NOW() as server_time, 1 as healthy`,
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Database timeout')), 5000)
            )
        ]);
        
        res.status(200).json({ 
            status: 'healthy',
            service: 'WhatsApp Multi-Clinic Bot',
            version: '3.0.0',
            database: {
                status: 'connected',
                server_time: dbCheck[0].server_time
            },
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime()),
            memory: {
                used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
            }
        });
    } catch (error) {
        logger.warning('Health check database error', error);
        
        // Return 200 even on DB error to keep service running
        res.status(200).json({ 
            status: 'degraded',
            service: 'WhatsApp Multi-Clinic Bot',
            version: '3.0.0',
            database: {
                status: 'error',
                error: error.message
            },
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime())
        });
    }
});

// Root endpoint with stats
app.get('/', async (req, res) => {
    try {
        const dbCheck = await sql`SELECT NOW() as server_time`;
        const clinicCount = await sql`SELECT COUNT(*) as count FROM clinics WHERE status = 'active'`;
        const pendingCount = await sql`SELECT COUNT(*) as count FROM appointments WHERE status = 'pending'`;
        
        res.json({
            status: 'ok',
            service: 'WhatsApp Multi-Clinic Bot',
            version: '3.0.0',
            timestamp: new Date().toISOString(),
            database: {
                connected: true,
                server_time: dbCheck[0].server_time
            },
            stats: {
                active_clinics: parseInt(clinicCount[0].count),
                pending_appointments: parseInt(pendingCount[0].count)
            },
            endpoints: {
                webhook: '/webhook',
                health: '/health',
                ping: '/ping',
                admin: '/api/admin'
            }
        });
    } catch (error) {
        logger.error('Root endpoint error', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════
// ERROR HANDLING MIDDLEWARE
// ═══════════════════════════════════════════════════════════

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        message: `Cannot ${req.method} ${req.path}`,
        endpoints: {
            webhook: 'POST /webhook',
            health: 'GET /health',
            ping: 'GET /ping',
            root: 'GET /'
        }
    });
});

// Global error handler
app.use((err, req, res, next) => {
    logger.error('Unhandled error', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
    });
});

// ═══════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // CRITICAL: Bind to all interfaces for Render.com

const server = app.listen(PORT, HOST, () => {
    logger.success('Server started', { 
        port: PORT,
        host: HOST,
        environment: process.env.NODE_ENV || 'production',
        nodeVersion: process.version
    });
    
    console.log('');
    console.log('═══════════════════════════════════════════════');
    console.log('🚀 WhatsApp Multi-Clinic Bot - Production v3.0');
    console.log('═══════════════════════════════════════════════');
    console.log('');
    console.log(`✅ Server running on ${HOST}:${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'production'}`);
    console.log(`📦 Node.js: ${process.version}`);
    console.log(`🕐 Started: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    console.log('');
    console.log('📍 Endpoints:');
    console.log(`   Webhook:  POST http://localhost:${PORT}/webhook`);
    console.log(`   Health:   GET  http://localhost:${PORT}/health`);
    console.log(`   Ping:     GET  http://localhost:${PORT}/ping`);
    console.log(`   Admin:    GET  http://localhost:${PORT}/api/admin`);
    console.log('');
    console.log('═══════════════════════════════════════════════');
    console.log('');
    
    // Signal readiness to Render
    console.log('✅ Server is ready to accept connections');
});

// Handle server startup errors
server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${PORT} is already in use`, error);
        process.exit(1);
    } else if (error.code === 'EACCES') {
        logger.error(`Port ${PORT} requires elevated privileges`, error);
        process.exit(1);
    } else {
        logger.error('Server error', error);
        process.exit(1);
    }
});

// ═══════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════

function gracefulShutdown(signal) {
    logger.info(`${signal} received, shutting down gracefully`);
    
    server.close(() => {
        logger.info('Server closed, exiting process');
        process.exit(0);
    });
    
    // Force shutdown after 30 seconds
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 30000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ═══════════════════════════════════════════════════════════
// UNCAUGHT ERROR HANDLERS
// ═══════════════════════════════════════════════════════════

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception - Server will exit', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', new Error(reason));
    // Don't exit on unhandled rejections in production
    if (process.env.NODE_ENV === 'development') {
        process.exit(1);
    }
});

// ═══════════════════════════════════════════════════════════
// EXPORTS (for testing)
// ═══════════════════════════════════════════════════════════

module.exports = {
    app,
    server
};
