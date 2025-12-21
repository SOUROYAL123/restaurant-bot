// handlers/appointmentBooking.js
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { sendWhatsAppMessage } = require('../utils/twilioClient');

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
            await saveDate(userPhone, clinicId, session, message, twiml);
            break;
            
        case 'booking_time':
            await saveTime(userPhone, clinicId, session, message, twiml);
            break;
            
        case 'booking_confirm':
            await confirmBooking(userPhone, clinicId, session, message, twiml);
            break;
            
        default:
            await askForName(userPhone, clinicId, twiml);
    }
}

/**
 * Ask for customer name
 */
async function askForName(userPhone, clinicId, twiml) {
    twiml.message('📝 What is your name?');
    
    const SessionManager = require('../utils/sessionManager');
    await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_name'
    });
}

/**
 * Save name and ask for date
 */
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
    
    const SessionManager = require('../utils/sessionManager');
    await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_date',
        temp_data: { name }
    });
}

/**
 * Save date and ask for time
 */
async function saveDate(userPhone, clinicId, session, message, twiml) {
    const dateMatch = message.match(/(\d{2})-(\d{2})-(\d{4})/);
    
    if (!dateMatch) {
        twiml.message('❌ Invalid date format.\n\nPlease use: DD-MM-YYYY\nExample: 25-12-2025');
        return;
    }
    
    const [_, day, month, year] = dateMatch;
    const appointmentDate = `${year}-${month}-${day}`;
    
    // Validate date is not in past
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
    
    const SessionManager = require('../utils/sessionManager');
    await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_time',
        temp_data: {
            ...session.temp_data,
            appointment_date: appointmentDate
        }
    });
}

/**
 * Save time and ask for confirmation
 */
async function saveTime(userPhone, clinicId, session, message, twiml) {
    const time = message.trim();
    
    if (time.length < 4) {
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
    
    const SessionManager = require('../utils/sessionManager');
    await SessionManager.updateSession(userPhone, clinicId, {
        current_step: 'booking_confirm',
        temp_data: {
            ...session.temp_data,
            appointment_time: time
        }
    });
}

/**
 * Confirm and create appointment
 */
async function confirmBooking(userPhone, clinicId, session, message, twiml) {
    const normalized = message.trim().toUpperCase();
    
    if (normalized !== 'YES' && normalized !== 'Y') {
        twiml.message('❌ Booking cancelled.\n\nReply 0 for main menu.');
        
        const SessionManager = require('../utils/sessionManager');
        await SessionManager.clearSession(userPhone, clinicId);
        return;
    }
    
    const { name, appointment_date, appointment_time } = session.temp_data;
    
    try {
        console.log('💾 Creating appointment...');
        
        // Get or create customer
        const CustomerSync = require('../utils/customerSync');
        const customer = await CustomerSync.getCustomer(userPhone, clinicId);
        
        let customerId = customer?.id;
        
        if (!customerId) {
            customerId = await CustomerSync.syncCustomer(userPhone, clinicId, { temp_data: { name } });
        }
        
        // Get default doctor
        const doctors = await sql`
            SELECT id FROM doctors 
            WHERE clinic_id = ${clinicId} 
            AND status = 'active'
            ORDER BY id
            LIMIT 1
        `;
        
        const doctorId = doctors[0]?.id || null;
        
        // Create appointment
        const result = await sql`
            INSERT INTO appointments (
                clinic_id, 
                customer_id, 
                doctor_id,
                patient_name, 
                patient_phone,
                appointment_date, 
                appointment_time,
                status
            )
            VALUES (
                ${clinicId}, 
                ${customerId},
                ${doctorId},
                ${name}, 
                ${userPhone},
                ${appointment_date}, 
                ${appointment_time},
                'pending'
            )
            RETURNING id
        `;
        
        const appointmentId = result[0].id;
        console.log(`✅ Appointment created: #${appointmentId}`);
        
        // Notify doctor
        console.log('📤 Notifying doctor...');
        try {
            const clinic = await sql`
                SELECT doctor_whatsapp FROM clinics WHERE id = ${clinicId} LIMIT 1
            `;
            
            if (clinic[0]?.doctor_whatsapp) {
                const doctorMessage = `🔔 *New Appointment Request*\n\n` +
                    `📋 ID: #${appointmentId}\n` +
                    `👤 Patient: ${name}\n` +
                    `📞 Phone: ${userPhone.replace('whatsapp:', '')}\n` +
                    `📅 Date: ${appointment_date}\n` +
                    `⏰ Time: ${appointment_time}\n\n` +
                    `Reply:\n` +
                    `APPROVE #${appointmentId} - to approve\n` +
                    `REJECT #${appointmentId} - to reject`;
                
                await sendWhatsAppMessage(clinic[0].doctor_whatsapp, doctorMessage);
                console.log('✅ Doctor notified');
            }
        } catch (error) {
            console.error('⚠️ Failed to notify doctor');
            console.error('Error notifying doctor:', error.message);
        }
        
        // Confirm to patient
        twiml.message(
            `✅ *Appointment Request Submitted*\n\n` +
            `📋 Booking #${appointmentId}\n` +
            `👤 Name: ${name}\n` +
            `📅 Date: ${appointment_date}\n` +
            `⏰ Time: ${appointment_time}\n\n` +
            `⏳ Awaiting doctor confirmation.\n` +
            `You'll receive a notification soon.\n\n` +
            `Reply 0 for main menu`
        );
        
        // Clear session
        const SessionManager = require('../utils/sessionManager');
        await SessionManager.clearSession(userPhone, clinicId);
        
    } catch (error) {
        console.error('❌ Error creating appointment:', error);
        twiml.message('❌ Sorry, something went wrong. Please try again.\n\nReply 0 for main menu');
    }
}

module.exports = {
    handleBooking
};
