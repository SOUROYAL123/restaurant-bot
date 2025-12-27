/**
 * ═══════════════════════════════════════════════════════════
 * WHATSAPP CLINIC BOT v5.0.1 - BUG FIX
 * 
 * Fixed: Removed '1' from restart triggers to allow clinic selection
 * 
 * Author: Sourav Roy - Legacylens Automation
 * Date: December 2024
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const twilio = require('twilio');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIGURATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const app = express();
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'production';

const sql = neon(process.env.DATABASE_URL);
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LOGGER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const log = {
    info: (msg, data = {}) => console.log(JSON.stringify({ 
        timestamp: new Date().toISOString(), 
        level: 'INFO', 
        message: msg, 
        ...data 
    })),
    success: (msg, data = {}) => console.log(JSON.stringify({ 
        timestamp: new Date().toISOString(), 
        level: 'SUCCESS', 
        message: msg, 
        ...data 
    })),
    warn: (msg, data = {}) => console.log(JSON.stringify({ 
        timestamp: new Date().toISOString(), 
        level: 'WARNING', 
        message: msg, 
        ...data 
    })),
    error: (msg, error = {}) => console.error(JSON.stringify({ 
        timestamp: new Date().toISOString(), 
        level: 'ERROR', 
        message: msg, 
        error: error.message || String(error), 
        stack: error.stack || '' 
    }))
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHONE HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function normalizePhone(phone) {
    if (!phone) return '';
    return phone.replace('whatsapp:', '').trim();
}

function formatForWhatsApp(phone) {
    if (!phone) return '';
    const clean = normalizePhone(phone);
    return clean.startsWith('whatsapp:') ? clean : `whatsapp:${clean}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PAYMENT HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const Razorpay = require('razorpay');

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

async function createDepositLink(appointmentId, patientName, patientPhone) {
    try {
        const depositAmount = parseInt(process.env.DEPOSIT_AMOUNT) || 200;
        
        const paymentLink = await razorpay.paymentLink.create({
            amount: depositAmount * 100,
            currency: "INR",
            description: `Appointment Deposit #${appointmentId}`,
            customer: {
                name: patientName,
                contact: patientPhone.replace('whatsapp:', '').replace('+', '')
            },
            notify: {
                sms: false,
                email: false,
                whatsapp: false
            },
            reminder_enable: false,
            callback_url: `${process.env.BASE_URL}/payment-callback?appointment_id=${appointmentId}`,
            callback_method: 'get'
        });
        
        await sql`
            UPDATE appointments 
            SET 
                payment_link_id = ${paymentLink.id},
                payment_status = 'pending',
                updated_at = NOW()
            WHERE id = ${appointmentId}
        `;
        
        log.success('Payment link created', { appointmentId, paymentUrl: paymentLink.short_url });
        
        return {
            success: true,
            paymentUrl: paymentLink.short_url,
            amount: depositAmount
        };
        
    } catch (error) {
        log.error('Payment link creation failed', error);
        return {
            success: false,
            error: error.message
        };
    }
}

async function verifyPayment(paymentLinkId, paymentId) {
    try {
        const paymentLink = await razorpay.paymentLink.fetch(paymentLinkId);
        
        if (paymentLink.status === 'paid') {
            return {
                success: true,
                amount: paymentLink.amount / 100,
                paymentId: paymentId
            };
        }
        
        return {
            success: false,
            error: 'Payment not completed'
        };
        
    } catch (error) {
        log.error('Payment verification failed', error);
        return {
            success: false,
            error: error.message
        };
    }
}

async function processRefund(appointmentId) {
    try {
        const appointments = await sql`
            SELECT payment_id, payment_link_id, appointment_date, created_at, payment_amount
            FROM appointments 
            WHERE id = ${appointmentId}
            AND payment_status = 'paid'
        `;
        
        if (appointments.length === 0) {
            return { success: false, error: 'No paid appointment found' };
        }
        
        const appt = appointments[0];
        
        const refundHours = parseInt(process.env.DEPOSIT_REFUND_HOURS) || 24;
        const appointmentDate = new Date(appt.appointment_date);
        const hoursUntilAppt = (appointmentDate - new Date()) / (1000 * 60 * 60);
        
        if (hoursUntilAppt < refundHours) {
            return { 
                success: false, 
                error: `Refund only available if cancelled ${refundHours}+ hours before appointment` 
            };
        }
        
        const payment = await razorpay.payments.fetch(appt.payment_id);
        
        const refund = await razorpay.payments.refund(appt.payment_id, {
            amount: payment.amount,
            speed: 'normal',
            notes: {
                reason: 'Appointment cancelled by patient',
                appointment_id: appointmentId
            }
        });
        
        await sql`
            UPDATE appointments 
            SET 
                payment_status = 'refunded',
                refund_id = ${refund.id},
                updated_at = NOW()
            WHERE id = ${appointmentId}
        `;
        
        log.success('Refund processed', { appointmentId, refundId: refund.id });
        
        return {
            success: true,
            refundId: refund.id,
            amount: refund.amount / 100
        };
        
    } catch (error) {
        log.error('Refund failed', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OPTIONAL DEPENDENCIES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let redisClient = null;
let cacheEnabled = false;

try {
    const redis = require('redis');
    if (process.env.REDIS_URL) {
        redisClient = redis.createClient({ url: process.env.REDIS_URL });
        redisClient.connect().then(() => { 
            cacheEnabled = true; 
            log.info('✅ Redis cache enabled'); 
        }).catch(() => log.warn('Redis failed'));
        redisClient.on('error', () => {});
    }
} catch (err) {
    log.warn('Redis not available');
}

let GoogleSheetsLogger = { 
    logAppointment: async () => false, 
    updateAppointmentStatus: async () => false 
};

try {
    const sheets = require('./utils/googleSheetsLogger');
    if (sheets && sheets.enabled !== false) {
        GoogleSheetsLogger = sheets;
        log.info('Google Sheets loaded');
    }
} catch (err) {
    log.warn('Google Sheets not available');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MIDDLEWARE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        if (req.path !== '/health' && req.path !== '/ping') {
            log.info('HTTP', { 
                method: req.method, 
                path: req.path, 
                status: res.statusCode, 
                ms: Date.now() - start 
            });
        }
    });
    next();
});

app.use('/webhook/', rateLimit({ 
    windowMs: 60000, 
    max: 60, 
    standardHeaders: true, 
    legacyHeaders: false 
}));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DATABASE HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function dbQuery(query, errorMsg = 'Database query failed') {
    try { 
        return await query; 
    } catch (error) { 
        log.error(errorMsg, error); 
        return null; 
    }
}

async function getCache(key) {
    if (!cacheEnabled || !redisClient) return null;
    try { 
        const val = await redisClient.get(key); 
        return val ? JSON.parse(val) : null; 
    } catch (err) { 
        return null; 
    }
}

async function setCache(key, value, ttl = 3600) {
    if (!cacheEnabled || !redisClient) return;
    try { 
        await redisClient.setEx(key, ttl, JSON.stringify(value)); 
    } catch (err) {}
}

async function delCache(key) {
    if (!cacheEnabled || !redisClient) return;
    try { 
        await redisClient.del(key); 
    } catch (err) {}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WHATSAPP MESSAGING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function sendWhatsApp(to, message) {
    try {
        const phone = formatForWhatsApp(to);
        const msg = await twilioClient.messages.create({
            from: process.env.WABA_NUMBER,
            to: phone,
            body: message
        });
        log.info('WhatsApp sent', { to: normalizePhone(phone), sid: msg.sid });
        return true;
    } catch (error) {
        log.error('WhatsApp failed', error);
        return false;
    }
}

async function sendDoctorNotificationWithButtons(to, appointmentDetails, appointmentId) {
    try {
        const phone = formatForWhatsApp(to);
        const { patientName, patientPhone, date, time } = appointmentDetails;

        const bodyText = 
            `🔔 *NEW APPOINTMENT*\n\n` +
            `📋 ID: #${appointmentId}\n` +
            `👤 ${patientName}\n` +
            `📞 ${patientPhone}\n` +
            `📅 ${date}\n` +
            `⏰ ${time}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `*Quick Actions:*\n\n` +
            `✅ APPROVE #${appointmentId}\n` +
            `❌ REJECT #${appointmentId}`;

        await twilioClient.messages.create({
            from: process.env.WABA_NUMBER,
            to: phone,
            body: bodyText
        });

        log.info('Doctor notification sent', { to: normalizePhone(phone), appointmentId });
        return true;

    } catch (error) {
        log.error('Doctor notification failed', error);
        return false;
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SESSION MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function getSession(phone) {
    const cleanPhone = normalizePhone(phone);
    const cached = await getCache(`session:${cleanPhone}`);
    if (cached) return cached;
    
    const session = await dbQuery(
        sql`SELECT * FROM sessions WHERE user_phone = ${cleanPhone} LIMIT 1`
    );
    
    if (session && session.length > 0) {
        await setCache(`session:${cleanPhone}`, session[0], 1800);
        return session[0];
    }
    return null;
}

async function setSession(phone, data) {
    const cleanPhone = normalizePhone(phone);
    await delCache(`session:${cleanPhone}`);
    
    const sessionData = typeof data.session_data === 'string' 
        ? data.session_data 
        : JSON.stringify(data.session_data || {});
    
    await dbQuery(sql`
        INSERT INTO sessions (user_phone, stage, clinic_id, session_data, last_activity)
        VALUES (${cleanPhone}, ${data.stage || 'initial'}, ${data.clinic_id || null}, ${sessionData}::jsonb, NOW())
        ON CONFLICT (user_phone) 
        DO UPDATE SET 
            stage = EXCLUDED.stage, 
            clinic_id = EXCLUDED.clinic_id, 
            session_data = EXCLUDED.session_data, 
            last_activity = NOW()
    `);
}

async function clearSession(phone) {
    const cleanPhone = normalizePhone(phone);
    await delCache(`session:${cleanPhone}`);
    await dbQuery(sql`DELETE FROM sessions WHERE user_phone = ${cleanPhone}`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CLINIC HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function getActiveClinics() {
    const cached = await getCache('clinics:active');
    if (cached) return cached;
    
    const clinics = await dbQuery(
        sql`SELECT * FROM clinics WHERE status = 'active' ORDER BY id`
    );
    
    if (clinics) { 
        await setCache('clinics:active', clinics, 3600); 
        return clinics; 
    }
    return [];
}

async function getClinic(id) {
    const cached = await getCache(`clinic:${id}`);
    if (cached) return cached;
    
    const clinic = await dbQuery(
        sql`SELECT * FROM clinics WHERE id = ${id} AND status = 'active' LIMIT 1`
    );
    
    if (clinic && clinic.length > 0) { 
        await setCache(`clinic:${id}`, clinic[0], 3600); 
        return clinic[0]; 
    }
    return null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WAITLIST MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function notifyWaitlist(clinicId, date, slot) {
    try {
        const waitlist = await sql`
            SELECT * FROM waitlist
            WHERE clinic_id = ${clinicId}
            AND appointment_date = ${date}
            AND appointment_slot = ${slot}
            AND status = 'waiting'
            ORDER BY created_at ASC
            LIMIT 1
        `;
        
        if (waitlist.length > 0) {
            const person = waitlist[0];
            
            await sendWhatsApp(person.patient_phone,
                `🎯 *Slot Available!*\n\n` +
                `${new Date(date).toLocaleDateString('en-IN')} @ ${slot}\n\n` +
                `Reply *YES ${person.id}* to book this slot\n` +
                `(Available for next 5 minutes only)`
            );
            
            await sql`
                UPDATE waitlist 
                SET notified_at = NOW(), status = 'notified'
                WHERE id = ${person.id}
            `;
            
            log.info('Waitlist notification sent', { waitlist_id: person.id });
        }
    } catch (error) {
        log.error('Waitlist notification failed', error);
    }
}

async function handleWaitlistAcceptance(phone, waitlistId) {
    try {
        const waitlist = await sql`
            SELECT * FROM waitlist
            WHERE id = ${waitlistId}
            AND patient_phone = ${normalizePhone(phone)}
            AND status = 'notified'
            LIMIT 1
        `;
        
        if (waitlist.length === 0) {
            await sendWhatsApp(phone, `❌ Waitlist offer expired or not found.`);
            return;
        }
        
        const w = waitlist[0];
        
        const notifiedAt = new Date(w.notified_at);
        const now = new Date();
        const minutesElapsed = (now - notifiedAt) / (1000 * 60);
        
        if (minutesElapsed > 5) {
            await sendWhatsApp(phone, `⏰ Sorry, the 5-minute window has expired.`);
            return;
        }
        
        const appt = await sql`
            INSERT INTO appointments (
                clinic_id, patient_name, patient_phone,
                appointment_date, appointment_time, appointment_slot,
                status, payment_status, reminder_sent, auto_processed,
                reminder_24h_sent, reminder_2h_sent
            ) VALUES (
                ${w.clinic_id}, ${w.patient_name}, ${w.patient_phone},
                ${w.appointment_date}, ${w.appointment_slot}, ${w.appointment_slot},
                'pending', 'pending', false, false, false, false
            ) RETURNING *
        `;
        
        await sql`UPDATE waitlist SET status = 'booked' WHERE id = ${waitlistId}`;
        
        const paymentResult = await createDepositLink(appt[0].id, w.patient_name, w.patient_phone);
        
        if (paymentResult.success) {
            await sendWhatsApp(phone,
                `✅ *Slot Booked!*\n\n` +
                `📋 ID: #${appt[0].id}\n` +
                `📅 ${new Date(w.appointment_date).toLocaleDateString('en-IN')}\n` +
                `⏰ ${w.appointment_slot}\n\n` +
                `💰 Pay deposit to confirm:\n` +
                `${paymentResult.paymentUrl}`
            );
        }
        
    } catch (error) {
        log.error('Waitlist acceptance failed', error);
        await sendWhatsApp(phone, '❌ Error booking slot.');
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INTERACTIVE COMMANDS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleConfirmCommand(phone, appointmentId) {
    try {
        const appts = await sql`
            SELECT a.*, c.name as clinic_name
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE a.id = ${appointmentId}
            AND a.patient_phone = ${normalizePhone(phone)}
            LIMIT 1
        `;
        
        if (appts.length === 0) {
            await sendWhatsApp(phone, `❌ Appointment #${appointmentId} not found.`);
            return;
        }
        
        const appt = appts[0];
        
        if (appt.status === 'confirmed') {
            await sendWhatsApp(phone, `✅ Appointment #${appointmentId} is already confirmed!`);
            return;
        }
        
        if (appt.payment_status !== 'paid') {
            await sendWhatsApp(phone, 
                `⚠️ Please complete payment first\n\n` +
                `Appointment #${appointmentId} requires deposit payment before confirmation.`
            );
            return;
        }
        
        await sql`
            UPDATE appointments 
            SET status = 'confirmed', updated_at = NOW()
            WHERE id = ${appointmentId}
        `;
        
        await sendWhatsApp(phone,
            `✅ *Confirmed!*\n\n` +
            `Appointment #${appointmentId} is confirmed.\n` +
            `See you on ${new Date(appt.appointment_date).toLocaleDateString('en-IN')} at ${appt.appointment_time}`
        );
        
    } catch (error) {
        log.error('Confirm command failed', error);
        await sendWhatsApp(phone, '❌ Error confirming appointment.');
    }
}

async function handleCancelCommand(phone, appointmentId) {
    try {
        const appts = await sql`
            SELECT a.*, c.name as clinic_name
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE a.id = ${appointmentId}
            AND a.patient_phone = ${normalizePhone(phone)}
            LIMIT 1
        `;
        
        if (appts.length === 0) {
            await sendWhatsApp(phone, `❌ Appointment #${appointmentId} not found.`);
            return;
        }
        
        const appt = appts[0];
        
        if (appt.status === 'cancelled') {
            await sendWhatsApp(phone, `⚠️ Appointment #${appointmentId} is already cancelled.`);
            return;
        }
        
        let refundMessage = '';
        if (appt.payment_status === 'paid') {
            const refundResult = await processRefund(appointmentId);
            
            if (refundResult.success) {
                refundMessage = `\n💰 Refund of ₹${refundResult.amount} initiated\n` +
                    `Will be credited in 5-7 business days`;
            } else {
                refundMessage = `\n⚠️ ${refundResult.error}`;
            }
        }
        
        await sql`
            UPDATE appointments 
            SET status = 'cancelled', updated_at = NOW()
            WHERE id = ${appointmentId}
        `;
        
        await sendWhatsApp(phone,
            `❌ *Appointment Cancelled*\n\n` +
            `Booking #${appointmentId}\n` +
            `${appt.clinic_name}\n` +
            `${new Date(appt.appointment_date).toLocaleDateString('en-IN')} @ ${appt.appointment_time}` +
            refundMessage +
            `\n\n📱 Reply 1 to book a new appointment`
        );
        
        await notifyWaitlist(appt.clinic_id, appt.appointment_date, appt.appointment_slot);
        
    } catch (error) {
        log.error('Cancel command failed', error);
        await sendWhatsApp(phone, '❌ Error cancelling appointment.');
    }
}

async function handleRescheduleCommand(phone, appointmentId) {
    try {
        const appts = await sql`
            SELECT * FROM appointments 
            WHERE id = ${appointmentId}
            AND patient_phone = ${normalizePhone(phone)}
            LIMIT 1
        `;
        
        if (appts.length === 0) {
            await sendWhatsApp(phone, `❌ Appointment #${appointmentId} not found.`);
            return;
        }
        
        const appt = appts[0];
        
        await setSession(phone, {
            stage: 'select_date',
            clinic_id: appt.clinic_id,
            session_data: {
                name: appt.patient_name,
                reschedule_id: appointmentId
            }
        });
        
        let msg = `🔄 *Reschedule Appointment #${appointmentId}*\n\n` +
            `Select new date:\n\n`;
        
        for (let i = 1; i <= 7; i++) {
            const d = new Date();
            d.setDate(d.getDate() + i);
            msg += `*${i}.* ${d.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' })}\n`;
        }
        
        msg += `\nReply *1-7*`;
        
        await sendWhatsApp(phone, msg);
        
    } catch (error) {
        log.error('Reschedule command failed', error);
        await sendWhatsApp(phone, '❌ Error rescheduling appointment.');
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONVERSATION FLOW
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleStart(phone) {
    const clinics = await getActiveClinics();
    if (clinics.length === 0) { 
        await sendWhatsApp(phone, '⚠️ *Service Unavailable*\n\nPlease try again later.'); 
        return; 
    }
    
    await setSession(phone, { stage: 'select_clinic', session_data: {} });
    
    let msg = '👋 *Welcome to Clinic Appointment System!*\n\n📋 *Select a clinic:*\n\n';
    clinics.forEach((clinic, i) => { 
        msg += `*${i + 1}.* ${clinic.name}\n   👨‍⚕️ Dr. ${clinic.doctor_name}\n`;
        if (clinic.business_hours_start) {
            msg += `   ⏰ ${clinic.business_hours_start} - ${clinic.business_hours_end}\n`;
        }
        msg += '\n';
    });
    msg += `Reply with number *1-${clinics.length}*`;
    
    await sendWhatsApp(phone, msg);
}

async function handleClinicSelect(phone, text) {
    const clinics = await getActiveClinics();
    const choice = parseInt(text.trim());
    
    if (isNaN(choice) || choice < 1 || choice > clinics.length) { 
        await sendWhatsApp(phone, `❌ Invalid. Reply *1-${clinics.length}*`); 
        return; 
    }
    
    const clinic = clinics[choice - 1];
    await setSession(phone, { stage: 'enter_name', clinic_id: clinic.id, session_data: {} });
    await sendWhatsApp(phone, `✅ *${clinic.name}* selected\n\n👤 *What is your full name?*`);
}

async function handleName(phone, text) {
    const name = text.trim();
    if (name.length < 2) { 
        await sendWhatsApp(phone, '❌ Name too short. Please enter your full name:'); 
        return; 
    }
    
    const session = await getSession(phone);
    let data = session?.session_data || {};
    if (typeof data === 'string') { 
        try { data = JSON.parse(data); } catch (e) { data = {}; } 
    }
    data.name = name;
    
    await setSession(phone, { 
        stage: 'select_date', 
        clinic_id: session.clinic_id, 
        session_data: data 
    });
    
    let msg = `👤 *Name:* ${name}\n\n📅 *Select date:*\n\n`;
    for (let i = 1; i <= 7; i++) { 
        const d = new Date(); 
        d.setDate(d.getDate() + i); 
        msg += `*${i}.* ${d.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' })}\n`; 
    }
    msg += `\nReply *1-7*`;
    
    await sendWhatsApp(phone, msg);
}

async function handleDate(phone, text) {
    const choice = parseInt(text.trim());
    if (isNaN(choice) || choice < 1 || choice > 7) { 
        await sendWhatsApp(phone, '❌ Invalid. Reply *1-7*'); 
        return; 
    }
    
    const d = new Date(); 
    d.setDate(d.getDate() + choice);
    const dateStr = d.toISOString().split('T')[0];
    
    const session = await getSession(phone);
    let data = session?.session_data || {};
    if (typeof data === 'string') { 
        try { data = JSON.parse(data); } catch (e) { data = {}; } 
    }
    data.dat
