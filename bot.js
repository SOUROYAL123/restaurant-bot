// bot.js
require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { neon } = require('@neondatabase/serverless');

const app = express();
const sql = neon(process.env.DATABASE_URL);

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Import handlers
const SessionManager = require('./utils/sessionManager');
const CustomerSync = require('./utils/customerSync');
const AppointmentBooking = require('./handlers/appointmentBooking');
const QueueSystem = require('./handlers/queueSystem');
const DoctorCommandsHandler = require('./handlers/doctorCommands');
const PatientCancellation = require('./handlers/patientCancellation');

// Inline appointment viewing function
async function viewAppointments(userPhone, clinicId, twiml) {
    try {
        const customers = await sql`
            SELECT id FROM customers 
            WHERE whatsapp = ${userPhone} 
            AND clinic_id = ${clinicId}
            LIMIT 1
        `;

        if (customers.length === 0) {
            twiml.message('You have no appointments yet.\n\nReply 1 to book an appointment.');
            return;
        }

        const customerId = customers[0].id;
        const appointments = await sql`
            SELECT 
                a.*,
                d.name as doctor_name
            FROM appointments a
            LEFT JOIN doctors d ON a.doctor_id = d.id
            WHERE a.customer_id = ${customerId}
            AND a.status IN ('pending', 'confirmed')
            ORDER BY a.appointment_date, a.appointment_time
            LIMIT 10
        `;

        if (appointments.length === 0) {
            twiml.message('📅 You have no upcoming appointments.\n\nReply 1 to book an appointment.');
            return;
        }

        let message = '📅 *Your Appointments*\n\n';
        appointments.forEach((apt, index) => {
            const statusEmoji = apt.status === 'confirmed' ? '✅' : '⏳';
            const statusText = apt.status === 'confirmed' ? 'Confirmed' : 'Pending';
            message += `${index + 1}. ${statusEmoji} *${statusText}*\n`;
            message += `   📋 ID: #${apt.id}\n`;
            message += `   📅 Date: ${apt.appointment_date}\n`;
            message += `   ⏰ Time: ${apt.appointment_time}\n`;
            if (apt.doctor_name) {
                message += `   👨‍⚕️ Doctor: ${apt.doctor_name}\n`;
            }
            if (apt.status === 'pending') {
                message += `   ℹ️ Awaiting doctor confirmation\n`;
            }
            
            // Show cancellation info
            const deadline = new Date(apt.cancellation_deadline);
            const now = new Date();
            if (now < deadline) {
                message += `   ❌ To cancel: Reply CANCEL ${apt.id}\n`;
                message += `   ⏰ Cancel before: ${deadline.toLocaleString('en-IN')}\n`;
            } else {
                message += `   ⚠️ Cancellation deadline passed\n`;
            }
            message += '\n';
        });
        message += 'Reply 0 for main menu.';
        twiml.message(message);
    } catch (error) {
        console.error('Error viewing appointments:', error);
        twiml.message('❌ Error retrieving appointments. Please try again.');
    }
}

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'active',
        service: 'WhatsApp Clinic Bot',
        version: '2.0.0',
        features: [
            'Google Sheets Integration',
            'Auto-Approval Toggle',
            '24-Hour Cancellation Window',
            'Multi-Clinic Support',
            'Doctor Dashboard'
        ]
    });
});

// Main webhook endpoint
app.post('/webhook', async (req, res) => {
    try {
        console.log('=== DEBUG INFO ===');
        console.log('From:', req.body.From);
        console.log('To:', req.body.To);
        console.log('Body:', req.body.Body);
        console.log('==================');

        const twiml = new twilio.twiml.MessagingResponse();
        const userPhone = req.body.From;
        const botNumber = req.body.To;
        const message = req.body.Body?.trim() || '';

        console.log(`📨 Message from ${userPhone.replace('whatsapp:+', '')}: ${message}`);

        // Look up clinic by bot number
        console.log(`🔍 Looking up clinic with botNumber: ${botNumber}`);
        const clinics = await sql`
            SELECT * FROM clinics 
            WHERE doctor_whatsapp = ${botNumber}
            LIMIT 1
        `;
        
        console.log('📊 Clinic query result:', clinics);

        if (clinics.length === 0) {
            twiml.message('❌ Clinic not found. Please contact support.');
            return res.type('text/xml').send(twiml.toString());
        }

        const clinic = clinics[0];
        const clinicId = clinic.id;
        
        console.log(`✅ Clinic found: ${clinic.name} (ID: ${clinicId})`);
        console.log(`⚙️ Auto-approval: ${clinic.auto_approve ? 'ENABLED' : 'DISABLED'}`);

        // Check if it's a doctor command
        const isDoctorCommand = await DoctorCommandsHandler.handleDoctorCommands(
            userPhone, 
            clinicId, 
            message, 
            twiml
        );

        if (isDoctorCommand) {
            console.log('✅ Doctor command handled');
            return res.type('text/xml').send(twiml.toString());
        }

        // Check for patient cancellation command
        const isCancellation = await PatientCancellation.handlePatientCancellation(
            userPhone,
            clinicId,
            message,
            twiml
        );

        if (isCancellation) {
            console.log('✅ Patient cancellation handled');
            return res.type('text/xml').send(twiml.toString());
        }

        // Regular patient flow
        let session = await SessionManager.getSession(userPhone, clinicId);
        console.log(`📍 Current stage: ${session.current_step}`);

        await CustomerSync.syncCustomer(userPhone, clinicId, session);

        const normalizedMessage = message.trim().toUpperCase();

        // Check for explicit menu triggers FIRST
        if (['HI', 'HELLO', 'MENU', 'START', '0'].includes(normalizedMessage)) {
            await SessionManager.updateSession(userPhone, clinicId, {
                current_step: 'main_menu',
                temp_data: {}
            });
            session.current_step = 'main_menu';
        }

        // Handle menu options when in main_menu stage
        if (session.current_step === 'main_menu') {
            if (['1', '2', '3', '4'].includes(normalizedMessage)) {
                console.log(`🎯 Menu option selected: ${normalizedMessage}`);
                
                switch (normalizedMessage) {
                    case '1':
                        await SessionManager.updateSession(userPhone, clinicId, {
                            current_step: 'booking_start',
                            temp_data: {}
                        });
                        session.current_step = 'booking_start';
                        await AppointmentBooking.handleBooking(
                            userPhone, 
                            clinicId, 
                            session, 
                            message, 
                            twiml
                        );
                        return res.type('text/xml').send(twiml.toString());

                    case '2':
                        await viewAppointments(userPhone, clinicId, twiml);
                        await SessionManager.updateSession(userPhone, clinicId, {
                            current_step: 'main_menu'
                        });
                        return res.type('text/xml').send(twiml.toString());

                    case '3':
                        const customer = await CustomerSync.getCustomer(userPhone, clinicId);
                        if (customer) {
                            const token = await QueueSystem.generateToken(customer.id, clinicId);
                            const position = await QueueSystem.getPosition(token.id);
                            
                            twiml.message(
                                `🎫 *Token Generated*\n\n` +
                                `Token #: ${token.token_number}\n` +
                                `Position: ${position.position}\n\n` +
                                `Please wait for your turn.\n` +
                                `Reply 0 for main menu.`
                            );
                        }
                        await SessionManager.updateSession(userPhone, clinicId, {
                            current_step: 'main_menu'
                        });
                        return res.type('text/xml').send(twiml.toString());

                    case '4':
                        twiml.message(
                            `📞 *Contact Information*\n\n` +
                            `🏥 Clinic: ${clinic.name}\n` +
                            `👨‍⚕️ Doctor: ${clinic.doctor_name || 'N/A'}\n` +
                            `📍 Address: ${clinic.address || 'N/A'}\n` +
                            `📞 Phone: ${clinic.contact_phone || 'N/A'}\n\n` +
                            `⚙️ Auto-Approval: ${clinic.auto_approve ? 'Enabled ✅' : 'Disabled ❌'}\n\n` +
                            `Reply 0 for main menu.`
                        );
                        await SessionManager.updateSession(userPhone, clinicId, {
                            current_step: 'main_menu'
                        });
                        return res.type('text/xml').send(twiml.toString());
                }
            }
        }

        // Handle appointment booking flow
        if (session.current_step && session.current_step.startsWith('booking_')) {
            console.log(`📋 Appointment stage: ${session.current_step}, Message: ${message}`);
            await AppointmentBooking.handleBooking(
                userPhone, 
                clinicId, 
                session, 
                message, 
                twiml
            );
            return res.type('text/xml').send(twiml.toString());
        }

        // Default: Show main menu
        const autoApprovalStatus = clinic.auto_approve ? '✅ Auto-Approved' : '⏳ Manual Approval';
        
        const menuMessage = 
            `👋 Welcome to *${clinic.name}*\n\n` +
            `👨‍⚕️ ${clinic.doctor_name || 'Doctor'}\n` +
            `${autoApprovalStatus}\n\n` +
            `Please select an option:\n\n` +
            `1️⃣ Book Appointment\n` +
            `2️⃣ View My Appointments\n` +
            `3️⃣ Get Walk-in Token\n` +
            `4️⃣ Contact Information\n\n` +
            `Reply with a number (1-4)`;

        twiml.message(menuMessage);
        await SessionManager.updateSession(userPhone, clinicId, {
            current_step: 'main_menu'
        });

        console.log('✅ Message sent to', userPhone.replace('whatsapp:+', ''));
        return res.type('text/xml').send(twiml.toString());

    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        console.error('Stack:', error.stack);
        
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message('⚠️ Sorry, something went wrong. Please try again or contact support.');
        return res.type('text/xml').send(twiml.toString());
    }
});

// Voice endpoint
app.post('/voice', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Thank you for calling. Please use WhatsApp for appointments.');
    res.type('text/xml').send(twiml.toString());
});

// API endpoint to toggle auto-approval (for web dashboard)
app.post('/api/clinic/:clinicId/auto-approve', async (req, res) => {
    try {
        const { clinicId } = req.params;
        const { enabled } = req.body;

        await sql`
            UPDATE clinics 
            SET auto_approve = ${enabled}, 
                updated_at = NOW()
            WHERE id = ${clinicId}
        `;

        res.json({ 
            success: true, 
            message: `Auto-approval ${enabled ? 'enabled' : 'disabled'}`,
            auto_approve: enabled
        });

    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint to get clinic status
app.get('/api/clinic/:clinicId/status', async (req, res) => {
    try {
        const { clinicId } = req.params;

        const clinic = await sql`
            SELECT id, name, doctor_name, auto_approve, google_sheet_id
            FROM clinics 
            WHERE id = ${clinicId}
            LIMIT 1
        `;

        if (clinic.length === 0) {
            return res.status(404).json({ success: false, error: 'Clinic not found' });
        }

        // Get appointment stats
        const stats = await sql`
            SELECT 
                COUNT(*) FILTER (WHERE status = 'pending') as pending,
                COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed,
                COUNT(*) FILTER (WHERE status = 'completed') as completed,
                COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
                COUNT(*) FILTER (WHERE appointment_date = CURRENT_DATE AND status IN ('pending', 'confirmed')) as today
            FROM appointments 
            WHERE clinic_id = ${clinicId}
        `;

        res.json({
            success: true,
            clinic: {
                ...clinic[0],
                has_google_sheets: !!clinic[0].google_sheet_id
            },
            stats: stats[0]
        });

    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Initialize queue table on startup
async function initializeQueueTable() {
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Webhook: https://your-domain.com/webhook`);
    console.log(`📞 Voice: https://your-domain.com/voice`);
    console.log(`🔗 API: https://your-domain.com/api/clinic/:id/status`);
    console.log('');
    console.log('✅ Features enabled:');
    console.log('   • Google Sheets Integration');
    console.log('   • Auto-Approval Toggle');
    console.log('   • 24-Hour Cancellation Window');
    console.log('   • Multi-Clinic Support');
    console.log('   • Queue System');
    console.log('');
    
    await initializeQueueTable();
});

// Helper function
async function sendWhatsAppMessage(phoneNumber, message) {
    const { sendWhatsAppMessage: sendMessage } = require('./utils/twilioClient');
    return await sendMessage(phoneNumber, message);
}

module.exports = { sendWhatsAppMessage };
