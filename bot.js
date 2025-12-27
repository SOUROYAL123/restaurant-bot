/**
 * ═══════════════════════════════════════════════════════════
 * WHATSAPP CLINIC BOT v5.0.0 - ULTIMATE EDITION
 * 
 * Features:
 * ✅ Multi-clinic appointment booking
 * ✅ Razorpay payment integration (deposits)
 * ✅ Smart reminders (24hr + 2hr with buttons)
 * ✅ Interactive commands (CONFIRM/CANCEL/RESCHEDULE)
 * ✅ Waitlist auto-notification
 * ✅ Automatic refunds
 * ✅ Doctor approval workflow
 * ✅ Google Sheets logging
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
            `*Quick Actions:*\n` +
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
    data.date = dateStr;
    
    await setSession(phone, { 
        stage: 'select_time', 
        clinic_id: session.clinic_id, 
        session_data: data 
    });
    
    const clinic = await getClinic(session.clinic_id);
    const startHour = parseInt(clinic?.business_hours_start?.split(':')[0] || '9');
    const endHour = parseInt(clinic?.business_hours_end?.split(':')[0] || '18');
    
    let msg = `📅 *Date:* ${d.toLocaleDateString('en-IN')}\n\n⏰ *Select time:*\n\n`;
    for (let h = startHour; h < endHour; h++) { 
        const time = h >= 12 ? `${h === 12 ? 12 : h - 12}:00 PM` : `${h}:00 AM`; 
        msg += `*${h - startHour + 1}.* ${time}\n`; 
    }
    msg += `\nReply *1-${endHour - startHour}*`;
    
    await sendWhatsApp(phone, msg);
}

async function handleTime(phone, text) {
    const cleanPhone = normalizePhone(phone);
    const session = await getSession(phone);
    let data = session?.session_data || {};
    if (typeof data === 'string') { 
        try { data = JSON.parse(data); } catch (e) { data = {}; } 
    }
    
    const clinic = await getClinic(session.clinic_id);
    const startHour = parseInt(clinic?.business_hours_start?.split(':')[0] || '9');
    const endHour = parseInt(clinic?.business_hours_end?.split(':')[0] || '18');
    const totalSlots = endHour - startHour;
    const choice = parseInt(text.trim());
    
    if (isNaN(choice) || choice < 1 || choice > totalSlots) { 
        await sendWhatsApp(phone, `❌ Invalid. Reply *1-${totalSlots}*`); 
        return; 
    }
    
    const hour = startHour + choice - 1;
    const timeSlot = hour >= 12 ? `${hour === 12 ? 12 : hour - 12}:00 PM` : `${hour}:00 AM`;

    try {
        // ═══════════════════════════════════════════════════════
        // CREATE APPOINTMENT
        // ═══════════════════════════════════════════════════════
        const appt = await sql`
            INSERT INTO appointments (
                clinic_id, patient_name, patient_phone, 
                appointment_date, appointment_time, appointment_slot, 
                status, reminder_sent, auto_processed,
                payment_status, reminder_24h_sent, reminder_2h_sent
            ) VALUES (
                ${session.clinic_id}, ${data.name}, ${cleanPhone}, 
                ${data.date}, ${timeSlot}, ${timeSlot}, 
                'pending', false, false,
                'pending', false, false
            ) RETURNING *
        `;
        
        const aptId = appt[0].id;
        log.success('Appointment created', { id: aptId, patient: data.name });

        // ═══════════════════════════════════════════════════════
        // CREATE PAYMENT LINK
        // ═══════════════════════════════════════════════════════
        const paymentResult = await createDepositLink(aptId, data.name, cleanPhone);
        
        const dateDisplay = new Date(data.date).toLocaleDateString('en-IN', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });

        if (paymentResult.success) {
            await sendWhatsApp(phone, 
                `✅ *Appointment Booked!*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n` +
                `📋 *ID:* #${aptId}\n` +
                `👤 *Name:* ${data.name}\n` +
                `🏥 *Clinic:* ${clinic.name}\n` +
                `📅 *Date:* ${dateDisplay}\n` +
                `⏰ *Time:* ${timeSlot}\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `💰 *Deposit Required: ₹${paymentResult.amount}*\n\n` +
                `Pay now to confirm your slot:\n` +
                `${paymentResult.paymentUrl}\n\n` +
                `📌 Fully refundable if cancelled 24h+ before appointment\n` +
                `⏰ Pending doctor approval after payment\n\n` +
                `You'll receive 2 reminders before your appointment.`
            );
        } else {
            await sendWhatsApp(phone, 
                `✅ *Appointment Requested!*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n` +
                `📋 ID: #${aptId}\n` +
                `👤 Name: ${data.name}\n` +
                `🏥 Clinic: ${clinic.name}\n` +
                `📅 Date: ${dateDisplay}\n` +
                `⏰ Time: ${timeSlot}\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `⏳ Pending doctor approval\n\n` +
                `You'll receive confirmation soon.`
            );
        }

        // Notify doctor
        await sendDoctorNotificationWithButtons(
            clinic.doctor_whatsapp,
            { patientName: data.name, patientPhone: cleanPhone, date: dateDisplay, time: timeSlot },
            aptId
        );

        // Log to Google Sheets
        try { 
            if (clinic.google_sheet_id) { 
                await GoogleSheetsLogger.logAppointment(clinic.google_sheet_id, { 
                    ...appt[0], 
                    clinic_name: clinic.name, 
                    doctor_name: clinic.doctor_name 
                }); 
            } 
        } catch (err) { 
            log.warn('Sheets failed', err); 
        }

        await clearSession(phone);
        
    } catch (error) {
        log.error('Appointment failed', error);
        await sendWhatsApp(phone, '❌ Error creating appointment. Please try again.');
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DOCTOR COMMANDS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleDoctorCommand(phone, text) {
    const cleanPhone = normalizePhone(phone);
    const cmd = text.trim().toUpperCase();

    const buttonMatch = cmd.match(/(APPROVE|REJECT)_(\d+)/);
    if (buttonMatch) {
        const action = buttonMatch[1];
        const aptId = parseInt(buttonMatch[2]);
        return await handleDoctorCommand(phone, `${action} #${aptId}`);
    }

    if (!cmd.startsWith('APPROVE') && !cmd.startsWith('REJECT')) return false;

    const clinic = await dbQuery(
        sql`SELECT * FROM clinics WHERE doctor_whatsapp = ${cleanPhone} LIMIT 1`
    );
    if (!clinic || clinic.length === 0) return false;

    const match = cmd.match(/#?(\d+)/);
    if (!match) { 
        await sendWhatsApp(phone, `❌ *Invalid format*\n\nUse:\n✅ APPROVE #123\n❌ REJECT #123`); 
        return true; 
    }

    const aptId = parseInt(match[1]);
    const isApprove = cmd.startsWith('APPROVE');

    const apts = await dbQuery(sql`
        SELECT * FROM appointments 
        WHERE id = ${aptId} 
        AND clinic_id = ${clinic[0].id} 
        AND status = 'pending' 
        LIMIT 1
    `);
    
    if (!apts || apts.length === 0) { 
        await sendWhatsApp(phone, `❌ *Appointment #${aptId} not found*`); 
        return true; 
    }

    const apt = apts[0];
    const newStatus = isApprove ? 'confirmed' : 'rejected';
    const now = new Date();

    if (isApprove) {
        await dbQuery(sql`
            UPDATE appointments 
            SET status = 'confirmed', approved_at = ${now}, updated_at = NOW() 
            WHERE id = ${aptId}
        `);
    } else {
        await dbQuery(sql`
            UPDATE appointments 
            SET status = 'rejected', rejected_at = ${now}, updated_at = NOW() 
            WHERE id = ${aptId}
        `);
    }

    try { 
        if (clinic[0].google_sheet_id) { 
            await GoogleSheetsLogger.updateAppointmentStatus(
                clinic[0].google_sheet_id, 
                aptId, 
                newStatus, 
                now.toLocaleString('en-IN')
            ); 
        } 
    } catch (err) { 
        log.warn('Sheets update failed', err); 
    }

    const dateStr = new Date(apt.appointment_date).toLocaleDateString('en-IN', { 
        weekday: 'long', 
        day: 'numeric', 
        month: 'long', 
        year: 'numeric' 
    });

    if (isApprove) {
        await sendWhatsApp(apt.patient_phone, 
            `✅ *Appointment Confirmed!*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `📋 *Booking:* #${aptId}\n` +
            `🏥 *Clinic:* ${clinic[0].name}\n` +
            `📅 *Date:* ${dateStr}\n` +
            `⏰ *Time:* ${apt.appointment_time}\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `✓ Please arrive 10 mins early\n\n` +
            `See you soon! 😊`
        );
    } else {
        await sendWhatsApp(apt.patient_phone, 
            `❌ *Appointment Not Confirmed*\n\n` +
            `📋 *Booking:* #${aptId}\n\n` +
            `Time slot unavailable.\n\n` +
            `Please contact clinic or reply *hi* to book again.`
        );
    }

    await sendWhatsApp(phone, 
        `${isApprove ? '✅' : '❌'} *Appointment #${aptId} ${newStatus.toUpperCase()}*\n\n` +
        `Patient: ${apt.patient_name}\n` +
        `Date: ${dateStr}\n` +
        `Time: ${apt.appointment_time}\n\n` +
        `✓ Patient notified.`
    );

    log.success(`Doctor ${newStatus} appointment`, { id: aptId, doctor: clinic[0].doctor_name });
    return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MESSAGE ROUTER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleMessage(phone, text) {
    try {
        const cmd = text.trim().toUpperCase();
        
        // CONFIRM command
        if (cmd.startsWith('CONFIRM')) {
            const match = cmd.match(/CONFIRM\s+#?(\d+)/);
            if (match) {
                await handleConfirmCommand(phone, parseInt(match[1]));
                return;
            }
        }
        
        // CANCEL command
        if (cmd.startsWith('CANCEL')) {
            const match = cmd.match(/CANCEL\s+#?(\d+)/);
            if (match) {
                await handleCancelCommand(phone, parseInt(match[1]));
                return;
            }
        }
        
        // RESCHEDULE command
        if (cmd.startsWith('RESCHEDULE')) {
            const match = cmd.match(/RESCHEDULE\s+#?(\d+)/);
            if (match) {
                await handleRescheduleCommand(phone, parseInt(match[1]));
                return;
            }
        }
        
        // YES command (waitlist)
        if (cmd.startsWith('YES')) {
            const match = cmd.match(/YES\s+(\d+)/);
            if (match) {
                await handleWaitlistAcceptance(phone, parseInt(match[1]));
                return;
            }
        }
        
        // Doctor commands
        const isDoctorCmd = await handleDoctorCommand(phone, text);
        if (isDoctorCmd) return;
        
        // Normal flow
        const session = await getSession(phone);
        const msg = text.trim().toLowerCase();
        const isRestart = msg === 'hi' || msg === 'hello' || msg === 'start' || msg === 'restart' || msg === '1';
        
        if (!session || isRestart) { 
            await handleStart(phone); 
            return; 
        }
        
        switch (session.stage) {
            case 'select_clinic': await handleClinicSelect(phone, text); break;
            case 'enter_name': await handleName(phone, text); break;
            case 'select_date': await handleDate(phone, text); break;
            case 'select_time': await handleTime(phone, text); break;
            default: await handleStart(phone);
        }
    } catch (error) {
        log.error('Message error', error);
        await sendWhatsApp(phone, '❌ Error occurred. Reply *hi* to restart.');
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HTTP ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/', (req, res) => res.json({ 
    name: 'WhatsApp Clinic Bot', 
    version: '5.0.0', 
    status: 'operational', 
    features: { 
        payment_integration: true, 
        smart_reminders: true,
        interactive_commands: true,
        waitlist: true
    }, 
    uptime: Math.floor(process.uptime()) 
}));

app.get('/health', async (req, res) => { 
    const h = { status: 'healthy', uptime: Math.floor(process.uptime()), database: 'unknown' }; 
    try { 
        await sql`SELECT 1`; 
        h.database = 'connected'; 
    } catch (e) { 
        h.database = 'disconnected'; 
        h.status = 'degraded'; 
    } 
    res.status(h.status === 'healthy' ? 200 : 503).json(h); 
});

app.head('/ping', (req, res) => res.status(200).send());
app.get('/ping', (req, res) => res.status(200).json({ pong: true }));

app.get('/status', async (req, res) => { 
    try { 
        const s = await sql`
            SELECT 
                (SELECT COUNT(*) FROM clinics WHERE status = 'active') as clinics, 
                (SELECT COUNT(*) FROM appointments WHERE DATE(created_at) = CURRENT_DATE) as today, 
                (SELECT COUNT(*) FROM appointments WHERE status = 'pending') as pending,
                (SELECT COUNT(*) FROM appointments WHERE payment_status = 'paid') as paid_deposits
        `; 
        res.json({ status: 'ok', version: '5.0.0', stats: s[0] || {} }); 
    } catch (e) { 
        res.status(500).json({ error: 'DB unavailable' }); 
    } 
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PAYMENT CALLBACK ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/payment-callback', async (req, res) => {
    try {
        const { 
            razorpay_payment_id, 
            razorpay_payment_link_id,
            razorpay_payment_link_status,
            appointment_id 
        } = req.query;
        
        log.info('Payment callback received', { 
            appointment_id, 
            payment_id: razorpay_payment_id,
            status: razorpay_payment_link_status 
        });
        
        if (razorpay_payment_link_status === 'paid') {
            const verification = await verifyPayment(
                razorpay_payment_link_id,
                razorpay_payment_id
            );
            
            if (verification.success) {
                await sql`
                    UPDATE appointments 
                    SET 
                        payment_status = 'paid',
                        payment_id = ${razorpay_payment_id},
                        payment_amount = ${verification.amount},
                        updated_at = NOW()
                    WHERE id = ${appointment_id}
                `;
                
                const appts = await sql`
                    SELECT a.*, c.name as clinic_name, c.doctor_name
                    FROM appointments a
                    JOIN clinics c ON a.clinic_id = c.id
                    WHERE a.id = ${appointment_id}
                `;
                
                if (appts.length > 0) {
                    const appt = appts[0];
                    
                    const dateStr = new Date(appt.appointment_date).toLocaleDateString('en-IN', {
                        weekday: 'long',
                        day: 'numeric',
                        month: 'long'
                    });
                    
                    await sendWhatsApp(appt.patient_phone,
                        `💰 *Payment Received!*\n\n` +
                        `✅ Deposit of ₹${verification.amount} confirmed\n\n` +
                        `📋 Booking #${appointment_id}\n` +
                        `📅 ${dateStr}\n` +
                        `⏰ ${appt.appointment_time}\n\n` +
                        `⏳ Doctor will approve shortly\n` +
                        `📨 You'll receive confirmation via WhatsApp`
                    );
                }
                
                log.success('Payment processed', { appointment_id, amount: verification.amount });
                
                res.send(`
                    <html>
                    <head>
                        <meta name="viewport" content="width=device-width, initial-scale=1">
                        <style>
                            body { font-family: Arial; text-align: center; padding: 50px; background: #f0f0f0; }
                            .success { background: white; padding: 40px; border-radius: 10px; max-width: 400px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                            .checkmark { color: #4CAF50; font-size: 60px; margin-bottom: 20px; }
                            h2 { color: #333; margin-bottom: 10px; }
                            p { color: #666; line-height: 1.6; }
                            .amount { color: #4CAF50; font-size: 24px; font-weight: bold; margin: 20px 0; }
                            .note { font-size: 14px; color: #999; margin-top: 30px; }
                        </style>
                    </head>
                    <body>
                        <div class="success">
                            <div class="checkmark">✓</div>
                            <h2>Payment Successful!</h2>
                            <div class="amount">₹${verification.amount}</div>
                            <p><strong>Booking #${appointment_id}</strong></p>
                            <p>Your appointment deposit has been received.</p>
                            <p>You'll receive confirmation on WhatsApp shortly.</p>
                            <p class="note">You can close this page now.</p>
                        </div>
                    </body>
                    </html>
                `);
            } else {
                log.error('Payment verification failed', { appointment_id });
                res.send('Payment verification failed. Please contact support.');
            }
        } else {
            log.warn('Payment not completed', { appointment_id, status: razorpay_payment_link_status });
            res.send('Payment was not completed. Please try again.');
        }
        
    } catch (error) {
        log.error('Payment callback error', error);
        res.status(500).send('Error processing payment. Please contact support.');
    }
});

app.post('/payment-webhook', async (req, res) => {
    try {
        const { event, payload } = req.body;
        
        log.info('Payment webhook received', { event });
        
        if (event === 'payment_link.paid') {
            const paymentLinkId = payload.payment_link.entity.id;
            
            const appts = await sql`
                SELECT id FROM appointments 
                WHERE payment_link_id = ${paymentLinkId}
                LIMIT 1
            `;
            
            if (appts.length > 0) {
                await sql`
                    UPDATE appointments 
                    SET payment_status = 'paid', updated_at = NOW()
                    WHERE id = ${appts[0].id}
                `;
                
                log.success('Webhook payment updated', { appointment_id: appts[0].id });
            }
        }
        
        res.status(200).send('OK');
        
    } catch (error) {
        log.error('Webhook error', error);
        res.status(500).send('Error');
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WHATSAPP WEBHOOK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post('/webhook/whatsapp', async (req, res) => {
    res.status(200).send('OK');
    try {
        const { From, Body, ButtonPayload } = req.body;
        if (!From || !Body) { 
            log.warn('Invalid payload'); 
            return; 
        }
        
        const message = ButtonPayload || Body;
        log.info('Incoming', { from: normalizePhone(From), message, isButton: !!ButtonPayload });
        setImmediate(() => handleMessage(From, message));
    } catch (err) { 
        log.error('Webhook error', err); 
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CRON ENDPOINTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post('/cron/auto-approval', async (req, res) => { 
    try { 
        const { processAutoApprovals } = require('./autoApproval'); 
        const r = await processAutoApprovals(); 
        res.json({ success: true, result: r }); 
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    } 
});

app.post('/cron/send-reminders', async (req, res) => { 
    try { 
        const { sendReminders } = require('./sendReminders'); 
        const r = await sendReminders(); 
        res.json({ success: true, result: r }); 
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    } 
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ERROR HANDLERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.use((req, res) => res.status(404).json({ error: 'Not Found' }));
app.use((err, req, res, next) => { 
    log.error('Unhandled', err); 
    res.status(500).json({ error: 'Internal Error' }); 
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STARTUP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function startServer() {
    try {
        log.info('Starting v5.0.0...');
        await sql`SELECT NOW()`;
        log.success('Database connected');
        
        app.listen(PORT, HOST, () => {
            console.log('═══════════════════════════════════════════════════════════');
            console.log('🚀 WHATSAPP CLINIC BOT v5.0.0 - ULTIMATE EDITION');
            console.log('═══════════════════════════════════════════════════════════');
            console.log(`📡 Port:        ${PORT}`);
            console.log(`💾 Database:    Connected ✅`);
            console.log(`💰 Payments:    Razorpay Enabled ✅`);
            console.log(`📨 Reminders:   24hr + 2hr ✅`);
            console.log(`🎯 Commands:    Interactive ✅`);
            console.log('═══════════════════════════════════════════════════════════');
            console.log('✅ LIVE - ALL FEATURES ENABLED');
            console.log('═══════════════════════════════════════════════════════════');
        });
    } catch (e) { 
        log.error('Startup failed', e); 
        process.exit(1); 
    }
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', (e) => { log.error('UNCAUGHT', e); process.exit(1); });
process.on('unhandledRejection', (r) => { log.error('UNHANDLED', { reason: r }); });

startServer();
module.exports = app;
