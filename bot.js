/**
 * ═══════════════════════════════════════════════════════════
 * WHATSAPP CLINIC BOT - COMPLETE VERSION
 * Multi-feature clinic management system
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const db = require('./config/database');

// Handlers
const { handleAppointmentBooking } = require('./handlers/appointmentBooking');
const DoctorCommandsHandler = require('./handlers/doctorCommands');
const PatientCommandsHandler = require('./handlers/patientCommands');
const DoctorSelection = require('./handlers/doctorSelection');
const SlotManager = require('./handlers/slotManager');
const QueueSystem = require('./handlers/queueSystem');
const RecurringAppointments = require('./handlers/recurringAppointments');

// Utils
const { updateSession, getSession, clearSession } = require('./utils/sessionManager');
const { syncCustomer } = require('./utils/customerSync');

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio setup
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/**
 * ═══════════════════════════════════════════════════════════
 * MAIN WHATSAPP WEBHOOK
 * ═══════════════════════════════════════════════════════════
 */
app.post('/webhook', async (req, res) => {
    try {
        const { Body, From, To } = req.body;
        const userPhone = From.replace('whatsapp:', '').replace('+', '');
        const botNumber = To;
        const messageBody = (Body || '').trim();
        
        console.log(`📨 Message from ${userPhone}: ${messageBody}`);
        
        // STEP 1: Check if sender is a DOCTOR
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
        
        // STEP 2: Get clinic ID from bot number
        const clinicResult = await db.query(
            `SELECT id FROM clinics WHERE doctor_whatsapp = $1 LIMIT 1`,
            [botNumber]
        );
        
        if (clinicResult.rows.length === 0) {
            console.log('❌ No clinic found for this number');
            res.sendStatus(200);
            return;
        }
        
        const clinicId = clinicResult.rows[0].id;
        
        // STEP 3: Check if message is a PATIENT COMMAND
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
            
            // Handle reschedule flow
            if (result && result.nextStage) {
                await updateSession(userPhone, clinicId, result.nextStage, result.tempData || {});
            }
            
            res.sendStatus(200);
            return;
        }
        
        // STEP 4: Check for QUEUE/TOKEN commands
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
        
        // STEP 5: Get or create session
        let session = await getSession(userPhone, clinicId);
        
        if (!session) {
            session = await createSession(userPhone, clinicId);
        }
        
        // STEP 6: Sync customer data
        await syncCustomer(userPhone, clinicId, session.language || 'en');
        
        // STEP 7: Route based on current stage
        const stage = session.current_step;
        
        console.log(`📍 Current stage: ${stage}`);
        
        // Main menu or greeting
        if (stage === 'main_menu' || messageBody.toUpperCase() === 'HI' || 
            messageBody.toUpperCase() === 'HELLO' || messageBody === '0') {
            await handleMainMenu(userPhone, clinicId, session);
        }
        // Doctor selection stage
        else if (stage === 'select_doctor') {
            await handleDoctorSelectionStage(userPhone, clinicId, session, messageBody);
        }
        // Booking flow stages
        else if (stage.startsWith('booking_')) {
            await handleBookingFlow(userPhone, clinicId, session, messageBody);
        }
        // Reschedule flow stages
        else if (stage.startsWith('reschedule_')) {
            await handleRescheduleFlow(userPhone, clinicId, session, messageBody);
        }
        // Slot suggestion flow
        else if (stage === 'view_slots') {
            await handleSlotSelection(userPhone, clinicId, session, messageBody);
        }
        // Help
        else if (messageBody.toUpperCase() === 'HELP') {
            await handleHelp(userPhone, clinicId);
        }
        // Unknown - show menu
        else {
            await handleMainMenu(userPhone, clinicId, session);
        }
        
        res.sendStatus(200);
        
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        res.sendStatus(500);
    }
});

/**
 * ═══════════════════════════════════════════════════════════
 * MAIN MENU HANDLER
 * ═══════════════════════════════════════════════════════════
 */
async function handleMainMenu(userPhone, clinicId, session) {
    try {
        // Get clinic info
        const clinic = await db.query(
            `SELECT name, doctor_name FROM clinics WHERE id = $1`,
            [clinicId]
        );
        
        const clinicInfo = clinic.rows[0];
        
        // Check if returning customer
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

/**
 * ═══════════════════════════════════════════════════════════
 * MENU OPTION ROUTER
 * ═══════════════════════════════════════════════════════════
 */
async function handleMenuOption(userPhone, clinicId, selection) {
    try {
        const option = selection.trim();
        
        if (option === '1') {
            // Book Appointment - Check if multi-doctor
            const hasMultiple = await DoctorSelection.hasMultipleDoctors(clinicId);
            
            if (hasMultiple) {
                const result = await DoctorSelection.showDoctorMenu(clinicId);
                
                if (result.autoSelect) {
                    // Single doctor - skip selection
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
                    // Multiple doctors - show selection
                    await sendWhatsAppMessage(userPhone, result.message);
                    await updateSession(userPhone, clinicId, 'select_doctor', {
                        doctors: result.doctors
                    });
                }
            } else {
                // No multi-doctor - start booking
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
            // View Appointments
            const result = await PatientCommandsHandler.handleViewAppointments(userPhone, clinicId);
            await sendWhatsAppMessage(userPhone, result.message);
        }
        else if (option === '3') {
            // Get Token
            await handleTokenRequest(userPhone, clinicId);
        }
        else if (option === '4') {
            // Contact Us
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

/**
 * ═══════════════════════════════════════════════════════════
 * DOCTOR SELECTION STAGE
 * ═══════════════════════════════════════════════════════════
 */
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
        
        // Move to booking with selected doctor
        await updateSession(userPhone, clinicId, result.nextStage, {
            doctor_id: result.doctorId,
            doctor_name: result.doctorName
        });
        
    } catch (error) {
        console.error('Error in doctor selection stage:', error.message);
    }
}

/**
 * ═══════════════════════════════════════════════════════════
 * BOOKING FLOW HANDLER
 * ═══════════════════════════════════════════════════════════
 */
async function handleBookingFlow(userPhone, clinicId, session, messageBody) {
    try {
        // Check if user wants to go back to menu
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

/**
 * ═══════════════════════════════════════════════════════════
 * RESCHEDULE FLOW HANDLER
 * ═══════════════════════════════════════════════════════════
 */
async function handleRescheduleFlow(userPhone, clinicId, session, messageBody) {
    try {
        const stage = session.current_step;
        const tempData = session.temp_data || {};
        
        if (stage === 'reschedule_date') {
            // Parse date
            const { parseDate } = require('./handlers/appointmentBooking');
            const parsedDate = parseDate(messageBody);
            
            if (!parsedDate.valid) {
                await sendWhatsAppMessage(userPhone, `❌ ${parsedDate.error}\n\nPlease enter date (DD-MM-YYYY):`);
                return;
            }
            
            // Show available slots
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
            // Parse time
            const { parseTime } = require('./handlers/appointmentBooking');
            const parsedTime = parseTime(messageBody);
            
            if (!parsedTime.valid) {
                await sendWhatsAppMessage(userPhone, `❌ ${parsedTime.error}\n\nPlease enter time (HH:MM AM/PM):`);
                return;
            }
            
            // Update appointment
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

/**
 * ═══════════════════════════════════════════════════════════
 * TOKEN REQUEST HANDLER
 * ═══════════════════════════════════════════════════════════
 */
async function handleTokenRequest(userPhone, clinicId) {
    try {
        // Get customer name
        const customer = await db.query(
            `SELECT name FROM customers WHERE phone = $1 AND clinic_id = $2 LIMIT 1`,
            [userPhone, clinicId]
        );
        
        const patientName = customer.rows.length > 0 ? customer.rows[0].name : null;
        
        // Issue token
        const tokenInfo = await QueueSystem.issueToken(clinicId, userPhone, patientName);
        
        if (!tokenInfo.success) {
            await sendWhatsAppMessage(userPhone, '❌ Error issuing token. Please try again.');
            return;
        }
        
        // Get current status
        const status = await QueueSystem.getTokenStatus(clinicId);
        
        // Format message
        const message = QueueSystem.formatTokenMessage(tokenInfo, status);
        
        await sendWhatsAppMessage(userPhone, message);
        
    } catch (error) {
        console.error('Error handling token request:', error.message);
    }
}

/**
 * ═══════════════════════════════════════════════════════════
 * TOKEN STATUS HANDLER
 * ═══════════════════════════════════════════════════════════
 */
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

/**
 * ═══════════════════════════════════════════════════════════
 * HELP COMMAND
 * ═══════════════════════════════════════════════════════════
 */
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

/**
 * ═══════════════════════════════════════════════════════════
 * HELPER FUNCTIONS
 * ═══════════════════════════════════════════════════════════
 */

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

/**
 * ═══════════════════════════════════════════════════════════
 * VOICE WEBHOOK (Missed Call Feature)
 * ═══════════════════════════════════════════════════════════
 */
app.post('/voice', async (req, res) => {
    try {
        const { From, To } = req.body;
        const callerNumber = From.replace('+', '');
        const missedCallNumber = To.replace('+', '');
        
        console.log(`📞 Missed call from ${callerNumber} to ${missedCallNumber}`);
        
        // Hang up immediately
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Hangup/>
</Response>`;
        
        // Send SMS with WhatsApp link
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

/**
 * ═══════════════════════════════════════════════════════════
 * HEALTH CHECK & ANALYTICS
 * ═══════════════════════════════════════════════════════════
 */

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

/**
 * ═══════════════════════════════════════════════════════════
 * START SERVER
 * ═══════════════════════════════════════════════════════════
 */

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Webhook: https://your-domain.com/webhook`);
    console.log(`📞 Voice: https://your-domain.com/voice`);
    console.log(`✅ Multi-doctor selection enabled`);
    console.log(`✅ Queue system enabled`);
    console.log(`✅ All features active`);
});

// Export for testing
module.exports = app;
```

---

## **📋 DEPLOYMENT CHECKLIST**

### **1. File Structure Verification**
```
project/
├── bot.js (UPDATED - above)
├── package.json
├── .env
├── config/
│   └── database.js
├── handlers/
│   ├── appointmentBooking.js (from earlier)
│   ├── doctorCommands.js (from earlier)
│   ├── patientCommands.js (Feature 1)
│   ├── doctorSelection.js (Feature 7 - above)
│   ├── slotManager.js (Feature 4 - from earlier)
│   ├── queueSystem.js (Feature 5 - from earlier)
│   └── recurringAppointments.js (Feature 6 - from earlier)
└── utils/
    ├── twilioClient.js
    ├── sessionManager.js
    └── customerSync.js
