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
            message += `   📅 Date: ${apt.appointment_date}\n`;
            message += `   ⏰ Time: ${apt.appointment_time}\n`;
            if (apt.doctor_name) {
                message += `   👨‍⚕️ Doctor: ${apt.doctor_name}\n`;
            }
            if (apt.status === 'pending') {
                message += `   ℹ️ Awaiting doctor confirmation\n`;
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
        version: '2.0.0'
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
                            `Clinic: ${clinic.name}\n` +
                            `Address: ${clinic.address || 'N/A'}\n` +
                            `Phone: ${clinic.contact_phone || 'N/A'}\n\n` +
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
        const menuMessage = 
            `👋 Welcome to *${clinic.name}*\n\n` +
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Webhook: https://your-domain.com/webhook`);
    console.log(`📞 Voice: https://your-domain.com/voice`);
    console.log('✅ All features active');
});

// Helper function
async function sendWhatsAppMessage(phoneNumber, message) {
    const { sendWhatsAppMessage: sendMessage } = require('./utils/twilioClient');
    return await sendMessage(phoneNumber, message);
}

module.exports = { sendWhatsAppMessage };
