// handlers/appointmentBooking.js
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { sendWhatsAppMessage } = require('../utils/twilioClient');
const SessionManager = require('../utils/sessionManager');

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
    // RE-FETCH session to get latest temp_data
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
    // RE-FETCH session to get latest temp_data
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
    // RE-FETCH session to get latest temp_data
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
        
        const CustomerSync = require('../utils/customerSync');
        let customer = await CustomerSync.getCustomer(userPhone, clinicId);
        
        if (!customer) {
            const customerId = await CustomerSync.syncCustomer(userPhone, clinicId, { 
                temp_data: { name },
                language: 'en'
            });
            customer = { id: customerId };
        }
        
        const doctors = await sql`
            SELECT id FROM doctors 
            WHERE clinic_id = ${clinicId} 
            AND status = 'active'
            ORDER BY id
