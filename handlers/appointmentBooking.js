// handlers/appointmentBooking.js
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const { sendWhatsAppMessage } = require('../utils/twilioClient');
const SessionManager = require('../utils/sessionManager');
const GoogleSheetsLogger = require('../utils/googleSheetsLogger');

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
        
        const CustomerSync = require('../utils/customerSync');
        let customer = await CustomerSync.getCustomer(userPhone, clinicId);
        
        if (!customer) {
            const customerId = await CustomerSync.syncCustomer(userPhone, clinicId, { 
                temp_data: { name },
                language: 'en'
            });
            customer = { id: customerId };
        }
        
        // Get clinic info
        const clinic = await sql`
            SELECT * FROM clinics WHERE id = ${clinicId} LIMIT 1
        `;
        
        const autoApprove = clinic[0]?.auto_approve || false;
        const googleSheetId = clinic[0]?.google_sheet_id;
        
        // Get doctor
        const doctors = await sql`
            SELECT id, name FROM doctors 
            WHERE clinic_id = ${clinicId} 
            AND status = 'active'
            ORDER BY id
            LIMIT 1
        `;
        
        const doctorId = doctors[0]?.id || null;
        const doctorName = doctors[0]?.name || 'Doctor';
        
        // Calculate cancellation deadline (24 hours before)
        const appointmentDateTime = new Date(`${appointment_date}T${appointment_time}`);
        const cancellationDeadline = new Date(appointmentDateTime);
        cancellationDeadline.setHours(cancellationDeadline.getHours() - 24);
        
        // Determine initial status
        const initialStatus = autoApprove ? 'confirmed' : 'pending';
        
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
                ${initialStatus},
                ${cancellationDeadline.toISOString()}
            )
            RETURNING id
        `;
        
        const appointmentId = result[0].id;
        console.log(`✅ Appointment created: #${appointmentId}`);
        
        // Log to Google Sheets
        if (googleSheetId) {
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
        }
        
        // Notify doctor (only if not auto-approved)
        if (!autoApprove) {
            console.log('📤 Notifying doctor...');
            try {
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
                console.error('⚠️ Failed to notify doctor:', error.message);
            }
        }
        
        // Send confirmation to patient
        if (autoApprove) {
            twiml.message(
                `✅ *Appointment Confirmed!*\n\n` +
                `📋 Booking #${appointmentId}\n` +
                `👤 Name: ${name}\n` +
                `📅 Date: ${appointment_date}\n` +
                `⏰ Time: ${appointment_time}\n` +
                `👨‍⚕️ Doctor: ${doctorName}\n\n` +
                `✨ Your appointment is automatically confirmed!\n\n` +
                `❗ Cancellation Policy: Must cancel 24 hours before\n` +
                `To cancel: Reply CANCEL ${appointmentId}\n\n` +
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
                `❗ Cancellation Policy: Must cancel 24 hours before\n` +
                `To cancel: Reply CANCEL ${appointmentId}\n\n` +
                `Reply 0 for main menu`
            );
        }
        
        await SessionManager.clearSession(userPhone, clinicId);
        
    } catch (error) {
        console.error('❌ Error creating appointment:', error);
        twiml.message('❌ Sorry, something went wrong. Please try again.\n\nReply 0 for main menu');
    }
}

module.exports = {
    handleBooking,
    // ... other exports
};
