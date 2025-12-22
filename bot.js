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

// ✅ AUTO-FIX DATABASE ON STARTUP
async function initializeDatabase() {
    try {
        console.log('🔧 Checking database schema...');
        
        // Add waba_number column if it doesn't exist
        await sql`
            ALTER TABLE clinics 
            ADD COLUMN IF NOT EXISTS waba_number VARCHAR(50)
        `;
        
        // Expand doctors.whatsapp column
        await sql`
            ALTER TABLE doctors 
            ALTER COLUMN whatsapp TYPE VARCHAR(50)
        `;
        
        // Set waba_number to WABA_NUMBER from env if not set
        await sql`
            UPDATE clinics 
            SET waba_number = ${process.env.WABA_NUMBER}
            WHERE id = 1 
            AND (waba_number IS NULL OR waba_number = '')
        `;
        
        // Ensure doctor_whatsapp is set correctly
        await sql`
            UPDATE clinics 
            SET doctor_whatsapp = 'whatsapp:+919748006945',
                auto_approve = false
            WHERE id = 1 
            AND doctor_whatsapp != 'whatsapp:+919748006945'
        `;
        
        // Add doctor if not exists
        await sql`
            INSERT INTO doctors (name, whatsapp, clinic_id, specialization, status)
            VALUES ('Dr. Sharma', 'whatsapp:+919748006945', 1, 'General Physician', 'active')
            ON CONFLICT (whatsapp) 
            DO UPDATE SET status = 'active'
        `;
        
        console.log('✅ Database schema verified');
        
        // Verify setup
        const clinic = await sql`
            SELECT waba_number, doctor_whatsapp FROM clinics WHERE id = 1
        `;
        
        if (clinic.length > 0) {
            console.log('📊 Clinic Configuration:');
            console.log('   Bot (WABA):', clinic[0].waba_number);
            console.log('   Doctor:', clinic[0].doctor_whatsapp);
        }
        
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
    }
}

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
        version: '2.0.1',
        features: [
            'Google Sheets Integration',
            'Auto-Approval Toggle',
            '24-Hour Cancellation Window',
            'Multi-Clinic Support',
            'Doctor Dashboard',
            'Auto Database Migration'
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

        // Look up clinic by WABA number
        console.log(`🔍 Looking up clinic with botNumber: ${botNumber}`);
        const clinics = await sql`
            SELECT * FROM clinics 
            WHERE waba_number = ${botNumber}
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

// API endpoint to toggle auto-approval
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

// Initialize queue table
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
    console.log(`📱 Webhook: https://clinis-database-bot.onrender.com/webhook`);
    console.log(`📞 Voice: https://clinis-database-bot.onrender.com/voice`);
    console.log(`🔗 API: https://clinis-database-bot.onrender.com/api/clinic/:id/status`);
    console.log('');
    
    // Initialize database schema
    await initializeDatabase();
    await initializeQueueTable();
    
    console.log('');
    console.log('✅ All systems ready!');
});

// Helper function
async function sendWhatsAppMessage(phoneNumber, message) {
    const { sendWhatsAppMessage: sendMessage } = require('./utils/twilioClient');
    return await sendMessage(phoneNumber, message);
}

module.exports = { sendWhatsAppMessage };
