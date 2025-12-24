require('dotenv').config();
const express = require('express');
const bodyParser = require('bodyparser');
const { neon } = require('@neondatabase/serverless');
const { notifyDoctor } = require('./handlers/notifications');
const GoogleSheetsLogger = require('./utils/googleSheetsLogger');

const sql = neon(process.env.DATABASE_URL);
const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ===============================
// SESSION MANAGEMENT
// ===============================
async function getOrCreateSession(userPhone) {
    let sessions = await sql`
        SELECT * FROM sessions WHERE user_phone = ${userPhone}
    `;
    
    if (sessions.length === 0) {
        await sql`
            INSERT INTO sessions (user_phone, stage)
            VALUES (${userPhone}, 'select_clinic')
        `;
        
        sessions = await sql`
            SELECT * FROM sessions WHERE user_phone = ${userPhone}
        `;
    }
    
    return sessions[0];
}

// ===============================
// WEBHOOK
// ===============================
app.post('/webhook', async (req, res) => {
    try {
        const from = req.body.From;
        const body = req.body.Body || '';
        
        if (!from) {
            return res.sendStatus(200);
        }
        
        const userPhone = from.replace('whatsapp:', '');
        const message = body.trim();
        
        // Get session
        const session = await getOrCreateSession(userPhone);
        let reply = '';
        
        // ===============================
        // DOCTOR COMMANDS (APPROVE/REJECT)
        // ===============================
        const upperMessage = message.toUpperCase();
        
        if (upperMessage.startsWith('APPROVE #') || upperMessage.startsWith('REJECT #')) {
            const match = upperMessage.match(/#(\d+)/);
            
            if (match) {
                const appointmentId = match[1];
                const isApprove = upperMessage.startsWith('APPROVE');
                
                // Verify doctor
                const appointments = await sql`
                    SELECT a.*, c.doctor_whatsapp, c.google_sheet_id
                    FROM appointments a
                    JOIN clinics c ON a.clinic_id = c.id
                    WHERE a.id = ${appointmentId}
                `;
                
                if (appointments.length > 0) {
                    const appt = appointments[0];
                    const doctorPhone = appt.doctor_whatsapp.replace('whatsapp:', '');
                    
                    if (userPhone === doctorPhone) {
                        const newStatus = isApprove ? 'confirmed' : 'rejected';
                        const timestamp = new Date();
                        
                        // Update appointment
                        await sql`
                            UPDATE appointments
                            SET 
                                status = ${newStatus},
                                ${isApprove ? sql`approved_at = ${timestamp}` : sql`rejected_at = ${timestamp}`},
                                updated_at = NOW()
                            WHERE id = ${appointmentId}
                        `;
                        
                        // Update Google Sheets
                        if (appt.google_sheet_id) {
                            await GoogleSheetsLogger.updateAppointmentStatus(
                                appt.google_sheet_id,
                                appointmentId,
                                newStatus,
                                timestamp.toLocaleString('en-IN')
                            );
                        }
                        
                        // Notify patient
                        const patientMessage = isApprove
                            ? `✅ *Appointment Confirmed*\n\n📋 #${appointmentId}\n📅 ${appt.appointment_date}\n🕒 ${appt.appointment_time}\n\nYour appointment has been confirmed!\nPlease arrive 10 minutes early.`
                            : `❌ *Appointment Not Available*\n\n📋 #${appointmentId}\n\nUnfortunately, this slot is not available.\nPlease book a different time.\nReply "1" to book again.`;
                        
                        await sql`
                            INSERT INTO pending_messages (phone, message)
                            VALUES (${appt.patient_phone}, ${patientMessage})
                        `;
                        
                        reply = `✅ Appointment #${appointmentId} ${isApprove ? 'APPROVED' : 'REJECTED'}`;
                    } else {
                        reply = `❌ You are not authorized to manage this appointment.`;
                    }
                } else {
                    reply = `❌ Appointment #${appointmentId} not found.`;
                }
            }
        }
        
        // ===============================
        // PATIENT FLOW
        // ===============================
        else if (message.toLowerCase() === 'hi' || message === '1') {
            // Show clinic list
            const clinics = await sql`
                SELECT id, name, doctor_name
                FROM clinics
                WHERE status = 'active'
                ORDER BY id
            `;
            
            if (clinics.length === 0) {
                reply = `❌ No clinics available. Please contact support.`;
            } else if (clinics.length === 1) {
                // Auto-select if only one clinic
                await sql`
                    UPDATE sessions
                    SET clinic_id = ${clinics[0].id}, stage = 'booking_name'
                    WHERE user_phone = ${userPhone}
                `;
                
                reply = `🏥 Welcome to ${clinics[0].name}\n\n👤 What is your full name?`;
            } else {
                reply = `🏥 *Select Your Clinic*\n\n`;
                clinics.forEach((clinic, i) => {
                    reply += `${i + 1}. ${clinic.name}\n   Dr. ${clinic.doctor_name}\n\n`;
                });
                reply += `Reply with the number (1-${clinics.length})`;
                
                await sql`
                    UPDATE sessions
                    SET stage = 'select_clinic'
                    WHERE user_phone = ${userPhone}
                `;
            }
        }
        
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
                
                await sql`
                    UPDATE sessions
                    SET clinic_id = ${selectedClinic.id}, stage = 'booking_name'
                    WHERE user_phone = ${userPhone}
                `;
                
                reply = `✅ ${selectedClinic.name} selected\n\n👤 What is your full name?`;
            } else {
                reply = `❌ Invalid selection. Please reply with a number between 1 and ${clinics.length}`;
            }
        }
        
        else if (session.stage === 'booking_name') {
            if (message.length < 2) {
                reply = `❌ Please enter a valid name.`;
            } else {
                await sql`
                    UPDATE sessions
                    SET 
                        session_data = jsonb_set(
                            COALESCE(session_data, '{}'),
                            '{name}',
                            to_jsonb(${message}::text)
                        ),
                        stage = 'booking_date'
                    WHERE user_phone = ${userPhone}
                `;
                
                reply = `📅 Enter appointment date\n\nFormat: DD-MM-YYYY\nExample: 28-12-2025`;
            }
        }
        
        else if (session.stage === 'booking_date') {
            const dateMatch = message.match(/^(\d{2})-(\d{2})-(\d{4})$/);
            
            if (!dateMatch) {
                reply = `❌ Invalid format. Use DD-MM-YYYY\nExample: 28-12-2025`;
            } else {
                const [, day, month, year] = dateMatch;
                const dateStr = `${year}-${month}-${day}`;
                
                await sql`
                    UPDATE sessions
                    SET 
                        session_data = jsonb_set(
                            session_data,
                            '{date}',
                            to_jsonb(${dateStr}::text)
                        ),
                        stage = 'booking_time'
                    WHERE user_phone = ${userPhone}
                `;
                
                reply = `🕒 Enter preferred time\n\nFormat: HH:MM AM/PM\nExample: 2:00 PM`;
            }
        }
        
        else if (session.stage === 'booking_time') {
            const sessionData = session.session_data || {};
            const name = sessionData.name;
            const date = sessionData.date;
            
            // Create appointment
            const result = await sql`
                INSERT INTO appointments (
                    clinic_id,
                    patient_name,
                    patient_phone,
                    appointment_date,
                    appointment_time,
                    status,
                    created_at
                )
                VALUES (
                    ${session.clinic_id},
                    ${name},
                    ${userPhone},
                    ${date},
                    ${message},
                    'pending',
                    NOW()
                )
                RETURNING id
            `;
            
            const appointmentId = result[0].id;
            
            // Get clinic info for Google Sheets
            const clinics = await sql`
                SELECT google_sheet_id, name
                FROM clinics
                WHERE id = ${session.clinic_id}
            `;
            
            const clinic = clinics[0];
            
            // Log to Google Sheets
            if (clinic.google_sheet_id) {
                await GoogleSheetsLogger.logAppointment(clinic.google_sheet_id, {
                    id: appointmentId,
                    appointment_date: date,
                    appointment_time: message,
                    patient_name: name,
                    patient_phone: userPhone,
                    status: 'pending',
                    doctor_name: '',
                    created_at: new Date().toLocaleString('en-IN')
                });
            }
            
            // Notify doctor
            await notifyDoctor(appointmentId);
            
            // Reset session
            await sql`
                UPDATE sessions
                SET stage = 'select_clinic', session_data = '{}'
                WHERE user_phone = ${userPhone}
            `;
            
            reply = `✅ *Booking Request Submitted*\n\n` +
                `📋 Booking ID: #${appointmentId}\n` +
                `🏥 ${clinic.name}\n` +
                `📅 ${date}\n` +
                `🕒 ${message}\n\n` +
                `⏳ Waiting for doctor approval...\n\n` +
                `You'll receive confirmation soon!`;
        }
        
        else {
            reply = `👋 Welcome! Reply "hi" to book an appointment.`;
        }
        
        // Send reply
        res.set('Content-Type', 'text/xml');
        res.send(`
            <Response>
                <Message>${reply}</Message>
            </Response>
        `);
        
    } catch (error) {
        console.error('❌ Webhook error:', error);
        
        res.set('Content-Type', 'text/xml');
        res.send(`
            <Response>
                <Message>❌ Error occurred. Please try again.</Message>
            </Response>
        `);
    }
});

// Health check
app.get('/', (req, res) => {
    res.send('✅ WhatsApp Multi-Clinic Bot Running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
