// handlers/appointmentBooking.js
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { sendWhatsAppMessage } = require('../utils/twilioClient');
const SessionManager = require('../utils/sessionManager');
const GoogleSheetsLogger = require('../utils/googleSheetsLogger');

/**
 * Main appointment booking handler
 */
async function handleBooking(userPhone, clinicId, session, message, twiml) {
    const stage = session.current_step;
    
    switch (stage) {
        case 'booking_start':
            await askForName(userPhone, clinicId, twiml);
            break;
            
        case 'booking_name':
            await saveName(userPhone, clinicId, message, twiml);
            break;
            
        case 'booking_date':
            await saveDate(userPhone, clinicId, message, twiml);
            break;
            
        case 'booking_time':
            await saveTime(userPhone, clinicId, message, twiml);
            break;
            
        case 'booking_confirm':
            await confirmBooking(userPhone, clinicId, message, twiml);
            break;
            
        default:
            await askForName(userPhone, clinicId, twiml);
    }
}

async function askForName(userPhone, clinicId, twiml) {
    twiml.message('📝 What is your name?');
    await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_name',
        temp_data: {}
    });
}

async function saveName(userPhone, clinicId, message, twiml) {
    const name = message.trim();
    
    if (name.length < 2) {
        twiml.message('❌ Please enter a valid name (at least 2 characters).');
        return;
    }
    
    twiml.message(
        `✅ Thank you, ${name}!\n\n` +
        `📅 Enter appointment date:\n` +
        `Format: DD-MM-YYYY\n` +
        `Example: 25-12-2025`
    );
    
    await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_date',
        temp_data: { name }
    });
}

async function saveDate(userPhone, clinicId, message, twiml) {
    const session = await SessionManager.getSession(userPhone, clinicId);
    
    const dateMatch = message.match(/(\d{2})-(\d{2})-(\d{4})/);
    
    if (!dateMatch) {
        twiml.message('❌ Invalid date format.\n\nPlease use: DD-MM-YYYY\nExample: 25-12-2025');
        return;
    }
    
    const [_, day, month, year] = dateMatch;
    const appointmentDate = `${year}-${month}-${day}`;
    
    const selectedDate = new Date(appointmentDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (selectedDate < today) {
        twiml.message('❌ Cannot book appointments in the past.\n\nPlease enter a future date.');
        return;
    }
    
    twiml.message(
        `⏰ Enter preferred time:\n\n` +
        `Format: HH:MM AM/PM\n` +
        `Example: 2:00 PM`
    );
    
    await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_time',
        temp_data: {
            ...session.temp_data,
            appointment_date: appointmentDate
        }
    });
}

async function saveTime(userPhone, clinicId, message, twiml) {
    const session = await SessionManager.getSession(userPhone, clinicId);
    
    const time = message.trim();
    
    if (time.length < 2) {
        twiml.message('❌ Please enter a valid time.\nExample: 2:00 PM');
        return;
    }
    
    const { name, appointment_date } = session.temp_data;
    
    twiml.message(
        `📋 *Confirm Appointment*\n\n` +
        `👤 Name: ${name}\n` +
        `📅 Date: ${appointment_date}\n` +
        `⏰ Time: ${time}\n\n` +
        `Reply YES to confirm or NO to cancel`
    );
    
    await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_confirm',
        temp_data: {
            ...session.temp_data,
            appointment_time: time
        }
    });
}

async function confirmBooking(userPhone, clinicId, message, twiml) {
    const session = await SessionManager.getSession(userPhone, clinicId);
    
    const normalized = message.trim().toUpperCase();
    
    if (normalized !== 'YES' && normalized !== 'Y') {
        twiml.message('❌ Booking cancelled.\n\nReply 0 for main menu.');
        await SessionManager.clearSession(userPhone, clinicId);
        return;
    }
    
    const { name, appointment_date, appointment_time } = session.temp_data;
    
    try {
        console.log('💾 Creating appointment...');
        console.log('📅 Date:', appointment_date);
        console.log('⏰ Time:', appointment_time);
        console.log('👤 Patient:', name);
        console.log('📞 Phone:', userPhone);
        
        const CustomerSync = require('../utils/customerSync');
        let customer = await CustomerSync.getCustomer(userPhone, clinicId);
        
        if (!customer) {
            console.log('👤 Creating new customer...');
            const customerId = await CustomerSync.syncCustomer(userPhone, clinicId, { 
                temp_data: { name },
                language: 'en'
            });
            customer = { id: customerId };
            console.log('✅ Customer created:', customerId);
        } else {
            console.log('✅ Existing customer found:', customer.id);
        }
        
        // Get clinic info - SELECT SPECIFIC COLUMNS ONLY
        console.log('🏥 Fetching clinic info...');
        const clinic = await sql`
            SELECT 
                id,
                name,
                doctor_whatsapp,
                auto_approve,
                google_sheet_id
            FROM clinics 
            WHERE id = ${clinicId} 
            LIMIT 1
        `;
        
        if (clinic.length === 0) {
            console.error('❌ Clinic not found!');
            twiml.message('❌ Error: Clinic not found. Please contact support.');
            return;
        }
        
        const autoApprove = clinic[0]?.auto_approve || false;
        const googleSheetId = clinic[0]?.google_sheet_id;
        
        console.log('🏥 Clinic:', clinic[0].name);
        console.log('⚙️ Auto-approve:', autoApprove);
        console.log('📊 Google Sheet ID:', googleSheetId || 'Not configured');
        
        // Get doctor
        console.log('👨‍⚕️ Fetching doctor info...');
        const doctors = await sql`
            SELECT id, name FROM doctors 
            WHERE clinic_id = ${clinicId} 
            AND status = 'active'
            ORDER BY id
            LIMIT 1
        `;
        
        const doctorId = doctors[0]?.id || null;
        const doctorName = doctors[0]?.name || 'Doctor';
        
        if (doctorId) {
            console.log('👨‍⚕️ Doctor:', doctorName, '(ID:', doctorId + ')');
        } else {
            console.log('⚠️ No active doctor found');
        }
        
        // Calculate cancellation deadline (24 hours before)
        const [year, month, day] = appointment_date.split('-');
        const appointmentDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), 12, 0, 0);
        const cancellationDeadline = new Date(appointmentDate);
        cancellationDeadline.setDate(cancellationDeadline.getDate() - 1);
        cancellationDeadline.setHours(23, 59, 59, 999);
        
        console.log('📅 Appointment date object:', appointmentDate);
        console.log('⏰ Cancellation deadline:', cancellationDeadline);
        
        // Determine initial status
        const initialStatus = autoApprove ? 'confirmed' : 'pending';
        console.log('📋 Initial status:', initialStatus);
        
        // Create appointment - INCLUDING appointment_slot
        console.log('💾 Inserting appointment into database...');
        const result = await sql`
            INSERT INTO appointments (
                clinic_id, 
                customer_id, 
                doctor_id,
                patient_name, 
                patient_phone,
                appointment_date, 
                appointment_time,
                appointment_slot,
                status,
                cancellation_deadline
            )
            VALUES (
                ${clinicId}, 
                ${customer.id},
                ${doctorId},
                ${name}, 
                ${userPhone},
                ${appointment_date}, 
                ${appointment_time},
                ${appointment_time},
                ${initialStatus},
                ${cancellationDeadline.toISOString()}
            )
            RETURNING id
        `;
        
        const appointmentId = result[0].id;
        console.log(`✅ Appointment created: #${appointmentId}`);
        
        // Log to Google Sheets (only if configured)
        if (googleSheetId) {
            console.log('📊 Logging to Google Sheets...');
            try {
                await GoogleSheetsLogger.logAppointment(googleSheetId, {
                    id: appointmentId,
                    appointment_date,
                    appointment_time,
                    patient_name: name,
                    patient_phone: userPhone,
                    status: initialStatus,
                    doctor_name: doctorName,
                    approved_at: autoApprove ? new Date().toLocaleString('en-IN') : null
                });
                console.log('✅ Logged to Google Sheets');
            } catch (sheetError) {
                console.error('⚠️ Google Sheets logging failed (non-critical):', sheetError.message);
            }
        } else {
            console.log('ℹ️ No Google Sheet configured, skipping logging');
        }
        
        // ===================================
        // NOTIFY DOCTOR (Enhanced Logging)
        // ===================================
        if (!autoApprove) {
            console.log('');
            console.log('=== DOCTOR NOTIFICATION ===');
            console.log('📤 Auto-approve is OFF, notifying doctor...');
            console.log('📤 Doctor WhatsApp from DB:', clinic[0]?.doctor_whatsapp);
            
            try {
                if (!clinic[0]?.doctor_whatsapp) {
                    console.log('⚠️ ERROR: No doctor WhatsApp configured in database!');
                    console.log('⚠️ Please run: UPDATE clinics SET doctor_whatsapp = \'whatsapp:+919748006945\' WHERE id = 1');
                } else {
                    const doctorMessage = `🔔 *New Appointment Request*\n\n` +
                        `📋 ID: #${appointmentId}\n` +
                        `👤 Patient: ${name}\n` +
                        `📞 Phone: ${userPhone.replace('whatsapp:', '').replace('+', '')}\n` +
                        `📅 Date: ${appointment_date}\n` +
                        `⏰ Time: ${appointment_time}\n\n` +
                        `Reply:\n` +
                        `APPROVE #${appointmentId} - to approve\n` +
                        `REJECT #${appointmentId} - to reject`;
                    
                    console.log('📤 Sending notification to:', clinic[0].doctor_whatsapp);
                    console.log('📝 Message length:', doctorMessage.length, 'characters');
                    
                    const sendStartTime = Date.now();
                    const sent = await sendWhatsAppMessage(clinic[0].doctor_whatsapp, doctorMessage);
                    const sendDuration = Date.now() - sendStartTime;
                    
                    console.log('⏱️ Send duration:', sendDuration + 'ms');
                    
                    if (sent) {
                        console.log('✅ Doctor notification sent successfully!');
                    } else {
                        console.log('❌ Doctor notification FAILED (returned false)');
                        console.log('❌ Check Twilio logs: https://console.twilio.com/us1/monitor/logs/sms');
                        console.log('❌ Common issues:');
                        console.log('   1. Doctor\'s number not verified in Twilio sandbox');
                        console.log('   2. Invalid Twilio credentials');
                        console.log('   3. Rate limiting');
                    }
                }
            } catch (notificationError) {
                console.error('❌ CRITICAL: Failed to notify doctor!');
                console.error('❌ Error type:', notificationError.name);
                console.error('❌ Error message:', notificationError.message);
                console.error('❌ Error stack:', notificationError.stack);
                
                // Check if it's a Twilio-specific error
                if (notificationError.code) {
                    console.error('❌ Twilio Error Code:', notificationError.code);
                    console.error('❌ Twilio Error Details:', notificationError.moreInfo);
                }
            }
            console.log('=== END NOTIFICATION ===');
            console.log('');
        } else {
            console.log('ℹ️ Auto-approve is ON, skipping doctor notification');
        }
        
        // Format cancellation deadline for display
        const deadlineDisplay = cancellationDeadline.toLocaleString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        // Send confirmation to patient
        console.log('📱 Sending confirmation to patient...');
        if (autoApprove) {
            twiml.message(
                `✅ *Appointment Confirmed!*\n\n` +
                `📋 Booking #${appointmentId}\n` +
                `👤 Name: ${name}\n` +
                `📅 Date: ${appointment_date}\n` +
                `⏰ Time: ${appointment_time}\n` +
                `👨‍⚕️ Doctor: ${doctorName}\n\n` +
                `✨ Your appointment is automatically confirmed!\n\n` +
                `❗ Cancellation Policy:\n` +
                `• Cancel before: ${deadlineDisplay}\n` +
                `• To cancel: Reply CANCEL ${appointmentId}\n\n` +
                `Reply 0 for main menu`
            );
        } else {
            twiml.message(
                `✅ *Appointment Request Submitted*\n\n` +
                `📋 Booking #${appointmentId}\n` +
                `👤 Name: ${name}\n` +
                `📅 Date: ${appointment_date}\n` +
                `⏰ Time: ${appointment_time}\n\n` +
                `⏳ Awaiting doctor confirmation.\n` +
                `You'll receive a notification soon.\n\n` +
                `❗ Cancellation Policy:\n` +
                `• Cancel before: ${deadlineDisplay}\n` +
                `• To cancel: Reply CANCEL ${appointmentId}\n\n` +
                `Reply 0 for main menu`
            );
        }
        
        console.log('✅ Patient confirmation sent');
        
        await SessionManager.clearSession(userPhone, clinicId);
        console.log('✅ Session cleared');
        console.log('=== BOOKING COMPLETE ===');
        
    } catch (error) {
        console.error('');
        console.error('=== CRITICAL ERROR ===');
        console.error('❌ Error creating appointment');
        console.error('❌ Error type:', error.name);
        console.error('❌ Error message:', error.message);
        console.error('❌ Error stack:', error.stack);
        console.error('===================');
        console.error('');
        
        twiml.message('❌ Sorry, something went wrong. Please try again.\n\nReply 0 for main menu');
    }
}

// CRITICAL: Export the handleBooking function
module.exports = {
    handleBooking
};
