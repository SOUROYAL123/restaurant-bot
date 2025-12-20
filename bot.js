require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const db = require('./config/database');

const { handleAppointmentBooking } = require('./handlers/appointmentBooking');
const DoctorCommandsHandler = require('./handlers/doctorCommands');
const PatientCommandsHandler = require('./handlers/patientCommands');
const DoctorSelection = require('./handlers/doctorSelection');
const SlotManager = require('./handlers/slotManager');
const QueueSystem = require('./handlers/queueSystem');

const { updateSession, getSession, clearSession } = require('./utils/sessionManager');
const { syncCustomer } = require('./utils/customerSync');

const app = express();
const PORT = process.env.PORT || 3000;

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
    try {
        const { Body, From, To } = req.body;
        
        // ========================================
        // TEMPORARY DEBUG - Remove after fixing
        // ========================================
        console.log('=== DEBUG INFO ===');
        console.log('From:', From);
        console.log('To:', To);
        console.log('Expected:', 'whatsapp:+917980407413');
        console.log('Match:', To === 'whatsapp:+917980407413');
        console.log('Body:', Body);
        console.log('==================');
        // ========================================
        
        const userPhone = From.replace('whatsapp:', '').replace('+', '');
        const botNumber = To;
        const messageBody = (Body || '').trim();
        
        console.log(`📨 Message from ${userPhone}: ${messageBody}`);
        
        const doctorInfo = await DoctorCommandsHandler.isDoctor(userPhone);
        
        if (doctorInfo) {
            console.log(`🩺 Doctor detected: ${doctorInfo.doctor_name}`);
            
            const result = await DoctorCommandsHandler.handleCommand(
                doctorInfo, 
                messageBody, 
                userPhone
            );
            
            if (result.message) {
                await sendWhatsAppMessage(userPhone, result.message);
            }
            
            res.sendStatus(200);
            return;
        }
        
        // ========================================
        // DEBUG: Check clinic lookup
        // ========================================
        console.log('🔍 Looking up clinic with botNumber:', botNumber);
        
        const clinicResult = await db.query(
            `SELECT id, name, doctor_whatsapp FROM clinics WHERE doctor_whatsapp = $1 LIMIT 1`,
            [botNumber]
        );
        
        console.log('📊 Clinic query result:', clinicResult.rows);
        // ========================================
        
        if (clinicResult.rows.length === 0) {
            console.log('❌ No clinic found for this number:', botNumber);
            
            // TEMPORARY: Show all clinics for debugging
            const allClinics = await db.query(`SELECT id, name, doctor_whatsapp FROM clinics`);
            console.log('📋 All clinics in database:', allClinics.rows);
            
            res.sendStatus(200);
            return;
        }
        
        const clinicId = clinicResult.rows[0].id;
        console.log('✅ Clinic found:', clinicResult.rows[0].name, '(ID:', clinicId + ')');
        
        if (PatientCommandsHandler.isPatientCommand(messageBody)) {
            console.log('📋 Patient command detected');
            
            const result = await PatientCommandsHandler.handleCommand(
                userPhone, 
                clinicId, 
                messageBody
            );
            
            if (result && result.message) {
                await sendWhatsAppMessage(userPhone, result.message);
            }
            
            if (result && result.nextStage) {
                await updateSession(userPhone, clinicId, result.nextStage, result.tempData || {});
            }
            
            res.sendStatus(200);
            return;
        }
        
        if (messageBody.toUpperCase() === 'GET TOKEN' || messageBody.toUpperCase() === 'TOKEN') {
            await handleTokenRequest(userPhone, clinicId);
            res.sendStatus(200);
            return;
        }
        
        if (messageBody.toUpperCase() === 'TOKEN STATUS' || messageBody.toUpperCase() === 'MY TOKEN') {
            await handleTokenStatus(userPhone, clinicId);
            res.sendStatus(200);
            return;
        }
        
        let session = await getSession(userPhone, clinicId);
        
        if (!session) {
            session = await createSession(userPhone, clinicId);
        }
        
        await syncCustomer(userPhone, clinicId, session.language || 'en');
        
        const stage = session.current_step;
        
        console.log(`📍 Current stage: ${stage}`);
        
        if (stage === 'main_menu' || messageBody.toUpperCase() === 'HI' || 
            messageBody.toUpperCase() === 'HELLO' || messageBody === '0') {
            await handleMainMenu(userPhone, clinicId, session);
        }
        else if (stage === 'main_menu' && ['1', '2', '3', '4'].includes(messageBody.trim())) {
            await handleMenuOption(userPhone, clinicId, messageBody);
        }
        else if (stage === 'select_doctor') {
            await handleDoctorSelectionStage(userPhone, clinicId, session, messageBody);
        }
        else if (stage.startsWith('booking_')) {
            await handleBookingFlow(userPhone, clinicId, session, messageBody);
        }
        else if (stage.startsWith('reschedule_')) {
            await handleRescheduleFlow(userPhone, clinicId, session, messageBody);
        }
        else if (messageBody.toUpperCase() === 'HELP') {
            await handleHelp(userPhone, clinicId);
        }
        else {
            await handleMainMenu(userPhone, clinicId, session);
        }
        
        res.sendStatus(200);
        
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        res.sendStatus(500);
    }
});

async function handleMainMenu(userPhone, clinicId, session) {
    try {
        const clinic = await db.query(
            `SELECT name, doctor_name FROM clinics WHERE id = $1`,
            [clinicId]
        );
        
        const clinicInfo = clinic.rows[0];
        
        const customer = await db.query(
            `SELECT name, total_appointments FROM customers 
             WHERE phone = $1 AND clinic_id = $2 LIMIT 1`,
            [userPhone, clinicId]
        );
        
        let greeting = '👋 *Welcome to ' + clinicInfo.name + '!*\n\n';
        
        if (customer.rows.length > 0 && customer.rows[0].name) {
            greeting = `👋 *Welcome back, ${customer.rows[0].name}!*\n\n`;
        }
        
        const message = greeting +
            `I'm your 24/7 appointment assistant. 🤖\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `*What would you like to do?*\n\n` +
            `1️⃣ 📅 Book Appointment\n` +
            `2️⃣ 📋 My Appointments\n` +
            `3️⃣ 🎫 Get Token (Walk-in)\n` +
            `4️⃣ 💬 Contact Us\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `*Quick Commands:*\n` +
            `• MY APPOINTMENTS - View bookings\n` +
            `• CANCEL [ID] - Cancel appointment\n` +
            `• TOKEN STATUS - Check queue\n` +
            `• HELP - Show all commands\n\n` +
            `Reply with number (1-4) or command`;
        
        await sendWhatsAppMessage(userPhone, message);
        await updateSession(userPhone, clinicId, 'main_menu', {});
        
    } catch (error) {
        console.error('Error in main menu:', error.message);
    }
}

async function handleMenuOption(userPhone, clinicId, selection) {
    try {
        const option = selection.trim();
        
        if (option === '1') {
            const hasMultiple = await DoctorSelection.hasMultipleDoctors(clinicId);
            
            if (hasMultiple) {
                const result = await DoctorSelection.showDoctorMenu(clinicId);
                
                if (result.autoSelect) {
                    await updateSession(userPhone, clinicId, 'booking_start', {
                        doctor_id: result.doctorId
                    });
                    
                    const session = await getSession(userPhone, clinicId);
                    const bookingResult = await handleAppointmentBooking(session, '', userPhone);
                    
                    if (bookingResult.message) {
                        await sendWhatsAppMessage(userPhone, bookingResult.message);
                    }
                    
                    await updateSession(userPhone, clinicId, bookingResult.nextStage, bookingResult.tempData);
                } else {
                    await sendWhatsAppMessage(userPhone, result.message);
                    await updateSession(userPhone, clinicId, 'select_doctor', {
                        doctors: result.doctors
                    });
                }
            } else {
                const defaultDoctor = await DoctorSelection.getDefaultDoctor(clinicId);
                await updateSession(userPhone, clinicId, 'booking_start', {
                    doctor_id: defaultDoctor
                });
                
                const session = await getSession(userPhone, clinicId);
                const result = await handleAppointmentBooking(session, '', userPhone);
                
                if (result.message) {
                    await sendWhatsAppMessage(userPhone, result.message);
                }
                
                await updateSession(userPhone, clinicId, result.nextStage, result.tempData);
            }
        }
        else if (option === '2') {
            const result = await PatientCommandsHandler.handleViewAppointments(userPhone, clinicId);
            await sendWhatsAppMessage(userPhone, result.message);
        }
        else if (option === '3') {
            await handleTokenRequest(userPhone, clinicId);
        }
        else if (option === '4') {
            const clinic = await db.query(
                `SELECT name, doctor_name, doctor_whatsapp, address, city 
                 FROM clinics WHERE id = $1`,
                [clinicId]
            );
            
            const info = clinic.rows[0];
            const phone = info.doctor_whatsapp.replace('whatsapp:', '');
            
            const message = `📞 *Contact ${info.name}*\n\n` +
                `👨‍⚕️ Dr. ${info.doctor_name}\n` +
                `📱 ${phone}\n` +
                `📍 ${info.address || ''}, ${info.city || 'Kolkata'}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `You can call us directly or book via WhatsApp!\n\n` +
                `Reply "1" to book appointment`;
            
            await sendWhatsAppMessage(userPhone, message);
        }
        else {
            await handleMainMenu(userPhone, clinicId, { current_step: 'main_menu' });
        }
        
    } catch (error) {
        console.error('Error handling menu option:', error.message);
    }
}

async function handleDoctorSelectionStage(userPhone, clinicId, session, messageBody) {
    try {
        const tempData = session.temp_data || {};
        const doctors = tempData.doctors || [];
        
        const result = await DoctorSelection.handleDoctorSelection(
            clinicId, 
            messageBody, 
            doctors
        );
        
        if (!result.success) {
            await sendWhatsAppMessage(userPhone, result.message);
            return;
        }
        
        await sendWhatsAppMessage(userPhone, result.message);
        
        await updateSession(userPhone, clinicId, result.nextStage, {
            doctor_id: result.doctorId,
            doctor_name: result.doctorName
        });
        
    } catch (error) {
        console.error('Error in doctor selection stage:', error.message);
    }
}

async function handleBookingFlow(userPhone, clinicId, session, messageBody) {
    try {
        if (messageBody.trim() === '1' || messageBody.trim() === '2' || 
            messageBody.trim() === '3' || messageBody.trim() === '4') {
            await handleMenuOption(userPhone, clinicId, messageBody);
            return;
        }
        
        const result = await handleAppointmentBooking(session, messageBody, userPhone);
        
        if (result.message) {
            await sendWhatsAppMessage(userPhone, result.message);
        }
        
        await updateSession(userPhone, clinicId, result.nextStage, result.tempData || {});
        
    } catch (error) {
        console.error('Error in booking flow:', error.message);
    }
}

async function handleRescheduleFlow(userPhone, clinicId, session, messageBody) {
    try {
        const stage = session.current_step;
        const tempData = session.temp_data || {};
        
        if (stage === 'reschedule_date') {
            const { parseDate } = require('./handlers/appointmentBooking');
            const parsedDate = parseDate(messageBody);
            
            if (!parsedDate.valid) {
                await sendWhatsAppMessage(userPhone, `❌ ${parsedDate.error}\n\nPlease enter date (DD-MM-YYYY):`);
                return;
            }
            
            const doctorId = tempData.doctor_id || null;
            const slots = await SlotManager.suggestSlots(clinicId, parsedDate.date, doctorId);
            
            const slotsMessage = SlotManager.formatSlotsMessage(slots, parsedDate.date);
            
            await sendWhatsAppMessage(userPhone, slotsMessage);
            await updateSession(userPhone, clinicId, 'reschedule_time', {
                ...tempData,
                new_date: parsedDate.date
            });
        }
        else if (stage === 'reschedule_time') {
            const { parseTime } = require('./handlers/appointmentBooking');
            const parsedTime = parseTime(messageBody);
            
            if (!parsedTime.valid) {
                await sendWhatsAppMessage(userPhone, `❌ ${parsedTime.error}\n\nPlease enter time (HH:MM AM/PM):`);
                return;
            }
            
            await db.query(
                `UPDATE appointments 
                 SET appointment_date = $1, 
                     appointment_slot = $2,
                     status = 'pending',
                     updated_at = NOW()
                 WHERE id = $3`,
                [tempData.new_date, parsedTime.time, tempData.reschedule_appointment_id]
            );
            
            const displayDate = new Date(tempData.new_date).toLocaleDateString('en-IN');
            
            const message = `✅ *Appointment Rescheduled!*\n\n` +
                `📋 Booking ID: #${tempData.reschedule_appointment_id}\n` +
                `📅 New Date: ${displayDate}\n` +
                `🕒 New Time: ${parsedTime.time}\n\n` +
                `⏳ Pending doctor approval\n\n` +
                `You'll receive confirmation shortly! 📱`;
            
            await sendWhatsAppMessage(userPhone, message);
            await updateSession(userPhone, clinicId, 'main_menu', {});
        }
        
    } catch (error) {
        console.error('Error in reschedule flow:', error.message);
    }
}

async function handleTokenRequest(userPhone, clinicId) {
    try {
        const customer = await db.query(
            `SELECT name FROM customers WHERE phone = $1 AND clinic_id = $2 LIMIT 1`,
            [userPhone, clinicId]
        );
        
        const patientName = customer.rows.length > 0 ? customer.rows[0].name : null;
        
        const tokenInfo = await QueueSystem.issueToken(clinicId, userPhone, patientName);
        
        if (!tokenInfo.success) {
            await sendWhatsAppMessage(userPhone, '❌ Error issuing token. Please try again.');
            return;
        }
        
        const status = await QueueSystem.getTokenStatus(clinicId);
        
        const message = QueueSystem.formatTokenMessage(tokenInfo, status);
        
        await sendWhatsAppMessage(userPhone, message);
        
    } catch (error) {
        console.error('Error handling token request:', error.message);
    }
}

async function handleTokenStatus(userPhone, clinicId) {
    try {
        const tokenInfo = await QueueSystem.checkMyToken(clinicId, userPhone);
        
        if (!tokenInfo) {
            await sendWhatsAppMessage(userPhone, 
                `📋 *No Active Token*\n\n` +
                `You don't have any token for today.\n\n` +
                `Reply "GET TOKEN" to get one now!`
            );
            return;
        }
        
        let statusIcon = '⏳';
        let statusText = 'Waiting';
        
        if (tokenInfo.status === 'serving') {
            statusIcon = '🔔';
            statusText = 'Your Turn!';
        }
        
        const message = `🎫 *Your Token Status*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `🔢 Your Token: *#${tokenInfo.tokenNumber}*\n` +
            `${statusIcon} Status: *${statusText}*\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `📊 Queue Status:\n` +
            `• Now Serving: ${tokenInfo.currentServing ? `#${tokenInfo.currentServing}` : 'None'}\n` +
            `• Your Position: ${tokenInfo.position}\n` +
            `• Estimated Wait: ${tokenInfo.estimatedWait} minutes\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `We'll notify you when it's your turn! 📱`;
        
        await sendWhatsAppMessage(userPhone, message);
        
    } catch (error) {
        console.error('Error handling token status:', error.message);
    }
}

async function handleHelp(userPhone, clinicId) {
    try {
        const message = `💡 *Help & Commands*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `*Quick Actions:*\n` +
            `• Reply "1" - Book appointment\n` +
            `• Reply "2" - View my appointments\n` +
            `• Reply "3" - Get walk-in token\n` +
            `• Reply "4" - Contact clinic\n\n` +
            `*Appointment Commands:*\n` +
            `• MY APPOINTMENTS - View all bookings\n` +
            `• CANCEL [ID] - Cancel appointment\n` +
            `• RESCHEDULE [ID] - Change date/time\n\n` +
            `*Token Commands:*\n` +
            `• GET TOKEN - Get queue token\n` +
            `• TOKEN STATUS - Check position\n\n` +
            `*Other:*\n` +
            `• HELP - Show this message\n` +
            `• HI - Back to main menu\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Need assistance? Reply "4" to contact us!`;
        
        await sendWhatsAppMessage(userPhone, message);
        
    } catch (error) {
        console.error('Error in help:', error.message);
    }
}

async function createSession(userPhone, clinicId) {
    await db.query(
        `INSERT INTO sessions (user_phone, clinic_id, current_step, temp_data, language, updated_at, last_activity)
         VALUES ($1, $2, 'main_menu', '{}', 'en', NOW(), NOW())
         ON CONFLICT (user_phone, clinic_id) DO UPDATE 
         SET current_step = 'main_menu', updated_at = NOW(), last_activity = NOW()`,
        [userPhone, clinicId]
    );
    
    return await getSession(userPhone, clinicId);
}

async function sendWhatsAppMessage(phoneNumber, message) {
    try {
        await twilioClient.messages.create({
            from: process.env.WABA_NUMBER,
            to: `whatsapp:+${phoneNumber}`,
            body: message
        });
        
        console.log(`✅ Message sent to ${phoneNumber}`);
        
    } catch (error) {
        console.error(`❌ Error sending message to ${phoneNumber}:`, error.message);
    }
}

app.post('/voice', async (req, res) => {
    try {
        const { From, To } = req.body;
        const callerNumber = From.replace('+', '');
        const missedCallNumber = To.replace('+', '');
        
        console.log(`📞 Missed call from ${callerNumber} to ${missedCallNumber}`);
        
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Hangup/>
</Response>`;
        
        sendMissedCallSMS(callerNumber, missedCallNumber).catch(err => {
            console.error('SMS error:', err.message);
        });
        
        res.type('text/xml');
        res.send(twiml);
        
    } catch (error) {
        console.error('Voice webhook error:', error.message);
        res.sendStatus(500);
    }
});

async function sendMissedCallSMS(callerNumber, missedCallNumber) {
    try {
        const whatsappNumber = process.env.WABA_NUMBER.replace('whatsapp:', '');
        
        const smsBody = `✨ Thank you for calling!\n\n` +
            `📱 Book appointment on WhatsApp:\n` +
            `👉 wa.me/${whatsappNumber.replace('+', '')}?text=Hi\n\n` +
            `Or save ${whatsappNumber} and message "Hi"\n\n` +
            `- Legacylens Clinic`;
        
        await twilioClient.messages.create({
            from: missedCallNumber,
            to: `+${callerNumber}`,
            body: smsBody
        });
        
        console.log(`✅ SMS sent to ${callerNumber}`);
        
    } catch (error) {
        console.error('SMS error:', error.message);
    }
}

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        features: [
            'Multi-Doctor Selection',
            'Appointment Booking',
            'Doctor Approval Workflow',
            'Cancel/Reschedule',
            'View Appointments',
            'Smart Slot Suggestions',
            'Queue/Token System',
            'Missed Call Handler'
        ]
    });
});

app.get('/api/analytics', async (req, res) => {
    try {
        const stats = await db.query(`
            SELECT 
                (SELECT COUNT(*) FROM appointments WHERE created_at > NOW() - INTERVAL '24 hours') as appointments_today,
                (SELECT COUNT(*) FROM appointments WHERE status = 'pending') as pending_approvals,
                (SELECT COUNT(*) FROM appointments WHERE status = 'confirmed') as confirmed_appointments,
                (SELECT COUNT(*) FROM queue_tokens WHERE queue_date = CURRENT_DATE) as tokens_today,
                (SELECT COUNT(*) FROM customers) as total_customers
        `);
        
        res.json({
            success: true,
            data: stats.rows[0]
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Webhook: https://your-domain.com/webhook`);
    console.log(`📞 Voice: https://your-domain.com/voice`);
    console.log(`✅ All features active`);
});

module.exports = app;
