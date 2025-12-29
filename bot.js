/**
 * ═══════════════════════════════════════════════════════════
 * WHATSAPP CLINIC BOT v7.0.0 - ULTIMATE EDITION
 * 
 * ✅ WhatsApp Appointment Booking
 * ✅ Auto-Approval System (24hr)
 * ✅ Manual Approve/Reject by Doctor
 * ✅ Google Sheets Integration (Individual)
 * ✅ Google Sheets Integration (Centralized for 1000+)
 * ✅ Bulk Operations & Search
 * ✅ Security Hardened
 * ✅ Production Ready
 * 
 * Author: Sourav Roy - Legacylens Automation
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

// ═══════════════════════════════════════════════════════════
// 1. LOAD ENVIRONMENT
// ═══════════════════════════════════════════════════════════
require('dotenv').config();

// ═══════════════════════════════════════════════════════════
// 2. ENVIRONMENT VALIDATION
// ═══════════════════════════════════════════════════════════
const requiredEnvVars = [
    'DATABASE_URL',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'WABA_NUMBER',
    'BASE_URL',
    'PORT'
];

console.log('\n🔍 Validating Environment...');
let hasErrors = false;

requiredEnvVars.forEach(varName => {
    if (!process.env[varName]) {
        console.error(`❌ Missing: ${varName}`);
        hasErrors = true;
    } else {
        const isSensitive = varName.includes('SECRET') || varName.includes('TOKEN') || varName.includes('KEY');
        const display = isSensitive ? `${process.env[varName].substring(0, 8)}...` : process.env[varName];
        console.log(`✅ ${varName} = ${display}`);
    }
});

if (hasErrors) {
    console.error('\n❌ VALIDATION FAILED - Missing required environment variables\n');
    process.exit(1);
}

console.log('✅ Environment Validated (PILOT MODE - No Payment Required)\n');

// ═══════════════════════════════════════════════════════════
// 3. CORE DEPENDENCIES
// ═══════════════════════════════════════════════════════════
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cors = require('cors');
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');
const twilio = require('twilio');

// ═══════════════════════════════════════════════════════════
// 4. INITIALIZE
// ═══════════════════════════════════════════════════════════
const app = express();
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

const sql = neon(process.env.DATABASE_URL);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Auto-approval settings
const AUTO_APPROVAL_ENABLED = process.env.AUTO_APPROVAL_ENABLED !== 'false'; // Default: true
const AUTO_APPROVAL_DELAY_MINUTES = parseInt(process.env.AUTO_APPROVAL_DELAY_MINUTES) || 1440; // Default: 1440 minutes (24 hours)

// ═══════════════════════════════════════════════════════════
// 5. LOGGING
// ═══════════════════════════════════════════════════════════
const log = {
    info: (msg, data = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', message: msg, ...data })),
    success: (msg, data = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'SUCCESS', message: msg, ...data })),
    warn: (msg, data = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'WARNING', message: msg, ...data })),
    error: (msg, error = {}) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'ERROR', message: msg, error: error.message || String(error), stack: error.stack || '' }))
};

// ═══════════════════════════════════════════════════════════
// 6. SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════

/**
 * Verify Twilio webhook signature
 */
function verifyTwilioSignature(req, res, next) {
    if (process.env.NODE_ENV === 'development' && process.env.SKIP_TWILIO_VERIFICATION === 'true') {
        log.warn('Twilio verification SKIPPED (development mode)');
        return next();
    }
    
    const twilioSignature = req.headers['x-twilio-signature'];
    if (!twilioSignature) {
        log.error('Missing Twilio signature header');
        return res.status(403).json({ error: 'Forbidden - Missing signature' });
    }
    
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const isValid = twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN,
        twilioSignature,
        url,
        req.body
    );
    
    if (!isValid) {
        log.error('Invalid Twilio signature', { url });
        return res.status(403).json({ error: 'Forbidden - Invalid signature' });
    }
    
    log.info('Twilio signature verified');
    next();
}

/**
 * Require API key for admin endpoints
 */
function requireApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    
    if (!process.env.ADMIN_API_KEY) {
        log.warn('ADMIN_API_KEY not configured - allowing request');
        return next();
    }
    
    if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
        log.error('Invalid or missing API key');
        return res.status(401).json({ error: 'Unauthorized - Invalid API key' });
    }
    
    log.info('API key verified');
    next();
}

/**
 * Request sanitization
 */
function sanitizeRequest(req, res, next) {
    if (req.query) {
        Object.keys(req.query).forEach(key => {
            if (typeof req.query[key] === 'string') {
                req.query[key] = req.query[key].replace(/\0/g, '').trim();
            }
        });
    }
    
    if (req.body && typeof req.body === 'object') {
        Object.keys(req.body).forEach(key => {
            if (typeof req.body[key] === 'string') {
                req.body[key] = req.body[key].replace(/\0/g, '').trim();
            }
        });
    }
    
    next();
}

/**
 * Security headers
 */
function setSecurityHeaders(req, res, next) {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    next();
}

// ═══════════════════════════════════════════════════════════
// 7. APPLY MIDDLEWARE
// ═══════════════════════════════════════════════════════════
app.set('trust proxy', 1);
app.use(helmet());
app.use(setSecurityHeaders);
app.use(cors());
app.use(compression());
app.use(sanitizeRequest);
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting
const webhookRateLimiter = rateLimit({
    windowMs: 60000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false
});

// Request logging (skip health checks)
app.use((req, res, next) => {
    if (req.path !== '/health' && req.path !== '/ping') {
        const start = Date.now();
        res.on('finish', () => {
            log.info('HTTP', { 
                method: req.method, 
                path: req.path, 
                status: res.statusCode, 
                ms: Date.now() - start,
                ip: req.ip
            });
        });
    }
    next();
});

// ═══════════════════════════════════════════════════════════
// 8. UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════
function normalizePhone(phone) {
    if (!phone) return '';
    return phone.replace('whatsapp:', '').trim();
}

function formatForWhatsApp(phone) {
    if (!phone) return '';
    const clean = normalizePhone(phone);
    return clean.startsWith('whatsapp:') ? clean : `whatsapp:${clean}`;
}

async function dbQuery(query, errorMsg = 'Database query failed') {
    try { 
        return await query; 
    } catch (error) { 
        log.error(errorMsg, error); 
        return null; 
    }
}

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

async function sendDoctorNotification(to, appointmentDetails, appointmentId) {
    try {
        const phone = formatForWhatsApp(to);
        const { patientName, patientPhone, date, time, clinicName } = appointmentDetails;
        
        // Format auto-approval time
        const approvalTime = AUTO_APPROVAL_DELAY_MINUTES >= 60 
            ? `${Math.floor(AUTO_APPROVAL_DELAY_MINUTES / 60)} hour${Math.floor(AUTO_APPROVAL_DELAY_MINUTES / 60) > 1 ? 's' : ''}`
            : `${AUTO_APPROVAL_DELAY_MINUTES} minute${AUTO_APPROVAL_DELAY_MINUTES > 1 ? 's' : ''}`;
        
        const bodyText = `🔔 *NEW APPOINTMENT REQUEST*\n\n━━━━━━━━━━━━━━━━━━━━━\n📋 *Appointment ID:* #${appointmentId}\n🏥 *Clinic:* ${clinicName || 'N/A'}\n\n*PATIENT DETAILS:*\n👤 *Name:* ${patientName}\n📞 *Phone:* ${patientPhone}\n\n*APPOINTMENT DETAILS:*\n📅 *Date:* ${date}\n⏰ *Time:* ${time}\n━━━━━━━━━━━━━━━━━━━━━\n\n*ACTIONS REQUIRED:*\n\n✅ *APPROVE:* Reply *APPROVE #${appointmentId}*\n❌ *REJECT:* Reply *REJECT #${appointmentId}*\n\n${AUTO_APPROVAL_ENABLED ? `⏰ *Auto-approves in ${approvalTime}* if no action taken` : '⚠️ *Manual approval required*'}`;
        
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

// ═══════════════════════════════════════════════════════════
// 9. AUTO-APPROVAL SYSTEM
// ═══════════════════════════════════════════════════════════
/**
 * Schedule auto-approval - just logs it
 * Actual processing happens via CRON job calling processAutoApprovals.js
 */
async function scheduleAutoApproval(appointmentId) {
    if (!AUTO_APPROVAL_ENABLED) {
        log.info('Auto-approval disabled', { appointmentId });
        return;
    }
    
    // Just log that it's scheduled
    // The actual auto-approval happens via CRON job
    log.info('Auto-approval will process via cron', { 
        appointmentId, 
        delayMinutes: AUTO_APPROVAL_DELAY_MINUTES 
    });
}

// ═══════════════════════════════════════════════════════════
// 10. SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════
async function getSession(phone) {
    const cleanPhone = normalizePhone(phone);
    const session = await dbQuery(sql`SELECT * FROM sessions WHERE user_phone = ${cleanPhone} LIMIT 1`);
    return (session && session.length > 0) ? session[0] : null;
}

async function setSession(phone, data) {
    const cleanPhone = normalizePhone(phone);
    const sessionData = typeof data.session_data === 'string' ? data.session_data : JSON.stringify(data.session_data || {});
    await dbQuery(sql`
        INSERT INTO sessions (user_phone, stage, clinic_id, session_data, last_activity)
        VALUES (${cleanPhone}, ${data.stage || 'initial'}, ${data.clinic_id || null}, ${sessionData}::jsonb, NOW())
        ON CONFLICT (user_phone) 
        DO UPDATE SET stage = EXCLUDED.stage, clinic_id = EXCLUDED.clinic_id, session_data = EXCLUDED.session_data, last_activity = NOW()
    `);
}

async function clearSession(phone) {
    const cleanPhone = normalizePhone(phone);
    await dbQuery(sql`DELETE FROM sessions WHERE user_phone = ${cleanPhone}`);
}

// ═══════════════════════════════════════════════════════════
// 11. CLINIC HELPERS
// ═══════════════════════════════════════════════════════════
async function getActiveClinics() {
    const clinics = await dbQuery(sql`SELECT * FROM clinics WHERE status = 'active' ORDER BY id`);
    return clinics || [];
}

async function getClinic(id) {
    const clinic = await dbQuery(sql`SELECT * FROM clinics WHERE id = ${id} AND status = 'active' LIMIT 1`);
    return (clinic && clinic.length > 0) ? clinic[0] : null;
}

// ═══════════════════════════════════════════════════════════
// 12. WAITLIST MANAGEMENT
// ═══════════════════════════════════════════════════════════
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
            await sendWhatsApp(
                person.patient_phone, 
                `🎯 *Slot Available!*\n\n📅 ${new Date(date).toLocaleDateString('en-IN')}\n⏰ ${slot}\n\nReply *YES ${person.id}* to book this slot\n\n⏱️ Available for next 5 minutes only`
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
        const minutesElapsed = (new Date() - new Date(w.notified_at)) / (1000 * 60);
        
        if (minutesElapsed > 5) {
            await sendWhatsApp(phone, `⏰ Sorry, the 5-minute window has expired.`);
            return;
        }
        
        const appt = await sql`
            INSERT INTO appointments (
                clinic_id, patient_name, patient_phone, 
                appointment_date, appointment_time, appointment_slot, 
                status, reminder_sent, auto_processed, 
                reminder_24h_sent, reminder_2h_sent
            ) 
            VALUES (
                ${w.clinic_id}, ${w.patient_name}, ${w.patient_phone}, 
                ${w.appointment_date}, ${w.appointment_slot}, ${w.appointment_slot}, 
                'pending', false, false, false, false
            ) 
            RETURNING *
        `;
        
        await sql`UPDATE waitlist SET status = 'booked' WHERE id = ${waitlistId}`;
        
        const clinic = await getClinic(w.clinic_id);
        const dateStr = new Date(w.appointment_date).toLocaleDateString('en-IN');
        
        await sendWhatsApp(
            phone, 
            `✅ *Slot Booked!*\n\n📋 ID: #${appt[0].id}\n📅 ${dateStr}\n⏰ ${w.appointment_slot}\n\n⏳ Awaiting doctor approval...`
        );
        
        const dateDisplay = new Date(w.appointment_date).toLocaleDateString('en-IN', { 
            weekday: 'long', 
            day: 'numeric', 
            month: 'long', 
            year: 'numeric' 
        });
        
        await sendDoctorNotification(
            clinic.doctor_whatsapp,
            {
                patientName: w.patient_name,
                patientPhone: w.patient_phone,
                date: dateDisplay,
                time: w.appointment_slot,
                clinicName: clinic.name
            },
            appt[0].id
        );
        
        // Schedule auto-approval
        await scheduleAutoApproval(appt[0].id);
        
    } catch (error) {
        log.error('Waitlist acceptance failed', error);
        await sendWhatsApp(phone, '❌ Error booking slot.');
    }
}

// ═══════════════════════════════════════════════════════════
// 13. INTERACTIVE COMMANDS
// ═══════════════════════════════════════════════════════════
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
        
        await sql`UPDATE appointments SET status = 'confirmed', updated_at = NOW() WHERE id = ${appointmentId}`;
        
        await sendWhatsApp(
            phone, 
            `✅ *Confirmed!*\n\nAppointment #${appointmentId} is confirmed.\n\nSee you on ${new Date(appt.appointment_date).toLocaleDateString('en-IN')} at ${appt.appointment_time} 😊`
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
        
        await sql`UPDATE appointments SET status = 'cancelled', updated_at = NOW() WHERE id = ${appointmentId}`;
        
        await sendWhatsApp(
            phone, 
            `❌ *Appointment Cancelled*\n\n📋 Booking #${appointmentId}\n🏥 ${appt.clinic_name}\n📅 ${new Date(appt.appointment_date).toLocaleDateString('en-IN')} @ ${appt.appointment_time}\n\n📱 Reply *hi* to book a new appointment`
        );
        
        // Notify waitlist
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
        
        let msg = `🔄 *Reschedule Appointment #${appointmentId}*\n\n📅 Select new date:\n\n`;
        
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

// ═══════════════════════════════════════════════════════════
// 14. CONVERSATION FLOW
// ═══════════════════════════════════════════════════════════
async function handleStart(phone) {
    const clinics = await getActiveClinics();
    
    if (clinics.length === 0) { 
        await sendWhatsApp(phone, '⚠️ *Service Unavailable*\n\nNo clinics available. Please try again later.'); 
        return; 
    }
    
    await setSession(phone, { stage: 'select_clinic', session_data: {} });
    
    let msg = '👋 *Welcome to Clinic Appointment System!*\n\n🎉 *FREE PILOT - No Payment Required*\n\n━━━━━━━━━━━━━━━━━━━━━\n📋 *Select a clinic:*\n\n';
    
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
        await sendWhatsApp(phone, `❌ Invalid choice. Reply *1-${clinics.length}*`); 
        return; 
    }
    
    const clinic = clinics[choice - 1];
    
    await setSession(phone, { 
        stage: 'enter_name', 
        clinic_id: clinic.id, 
        session_data: {} 
    });
    
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
        await sendWhatsApp(phone, '❌ Invalid choice. Reply *1-7*'); 
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
        await sendWhatsApp(phone, `❌ Invalid choice. Reply *1-${totalSlots}*`); 
        return; 
    }
    
    const hour = startHour + choice - 1;
    const timeSlot = hour >= 12 ? `${hour === 12 ? 12 : hour - 12}:00 PM` : `${hour}:00 AM`;
    
    try {
        const appt = await sql`
            INSERT INTO appointments (
                clinic_id, patient_name, patient_phone, 
                appointment_date, appointment_time, appointment_slot, 
                status, reminder_sent, auto_processed, 
                reminder_24h_sent, reminder_2h_sent
            ) 
            VALUES (
                ${session.clinic_id}, ${data.name}, ${cleanPhone}, 
                ${data.date}, ${timeSlot}, ${timeSlot}, 
                'pending', false, false, false, false
            ) 
            RETURNING *
        `;
        
        const aptId = appt[0].id;
        log.success('Appointment created', { id: aptId, patient: data.name });
        
        const dateDisplay = new Date(data.date).toLocaleDateString('en-IN', { 
            weekday: 'long', 
            day: 'numeric', 
            month: 'long', 
            year: 'numeric' 
        });
        
        // Format approval time for patient message
        const approvalTime = AUTO_APPROVAL_DELAY_MINUTES >= 60 
            ? `${Math.floor(AUTO_APPROVAL_DELAY_MINUTES / 60)} hour${Math.floor(AUTO_APPROVAL_DELAY_MINUTES / 60) > 1 ? 's' : ''}`
            : `${AUTO_APPROVAL_DELAY_MINUTES} minute${AUTO_APPROVAL_DELAY_MINUTES > 1 ? 's' : ''}`;
        
        await sendWhatsApp(
            phone, 
            `✅ *Appointment Booked!*\n\n━━━━━━━━━━━━━━━━━━━━━\n📋 *ID:* #${aptId}\n👤 *Name:* ${data.name}\n🏥 *Clinic:* ${clinic.name}\n📅 *Date:* ${dateDisplay}\n⏰ *Time:* ${timeSlot}\n━━━━━━━━━━━━━━━━━━━━━\n\n⏳ *Status:* Pending approval\n${AUTO_APPROVAL_ENABLED ? `⏰ Auto-approves in ${approvalTime} if doctor doesn't respond` : '⚠️ Manual approval required'}\n\nYou'll receive confirmation soon!\n\n━━━━━━━━━━━━━━━━━━━━━\n*Need to change?*\n❌ CANCEL #${aptId}\n🔄 RESCHEDULE #${aptId}`
        );
        
        await sendDoctorNotification(
            clinic.doctor_whatsapp,
            {
                patientName: data.name,
                patientPhone: cleanPhone,
                date: dateDisplay,
                time: timeSlot,
                clinicName: clinic.name
            },
            aptId
        );
        
        // Schedule auto-approval
        await scheduleAutoApproval(aptId);
        
        await clearSession(phone);
        
    } catch (error) {
        log.error('Appointment creation failed', error);
        await sendWhatsApp(phone, '❌ Error creating appointment. Please try again or contact support.');
    }
}

// ═══════════════════════════════════════════════════════════
// 15. DOCTOR COMMANDS
// ═══════════════════════════════════════════════════════════
async function handleDoctorCommand(phone, text) {
    const cleanPhone = normalizePhone(phone);
    const cmd = text.trim().toUpperCase();
    
    if (!cmd.startsWith('APPROVE') && !cmd.startsWith('REJECT')) return false;
    
    // Try both formats: with and without whatsapp: prefix
    const phoneFormats = [
        `whatsapp:${cleanPhone}`,
        cleanPhone
    ];
    
    let clinic = null;
    for (const phoneFormat of phoneFormats) {
        const result = await dbQuery(sql`
            SELECT * FROM clinics 
            WHERE doctor_whatsapp = ${phoneFormat} 
            LIMIT 1
        `);
        if (result && result.length > 0) {
            clinic = result;
            break;
        }
    }
    
    if (!clinic || clinic.length === 0) {
        log.info('Doctor command from non-doctor number', { phone: cleanPhone });
        return false;
    }
    
    // Clear any active session for the doctor
    await clearSession(phone);
    
    const match = cmd.match(/#?(\d+)/);
    
    if (!match) { 
        await sendWhatsApp(
            phone, 
            `❌ *Invalid format*\n\nUse:\n✅ APPROVE #123\n❌ REJECT #123`
        ); 
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
        await sendWhatsApp(phone, `❌ *Appointment #${aptId} not found or already processed*`); 
        return true; 
    }
    
    const apt = apts[0];
    const now = new Date();
    
    if (isApprove) {
        await dbQuery(sql`
            UPDATE appointments 
            SET status = 'confirmed', 
                approved_at = ${now}, 
                auto_processed = false,
                updated_at = NOW() 
            WHERE id = ${aptId}
        `);
        
        log.success('Doctor approved appointment', { 
            id: aptId, 
            doctor: clinic[0].doctor_name 
        });
    } else {
        await dbQuery(sql`
            UPDATE appointments 
            SET status = 'rejected', 
                rejected_at = ${now}, 
                updated_at = NOW() 
            WHERE id = ${aptId}
        `);
        
        log.success('Doctor rejected appointment', { 
            id: aptId, 
            doctor: clinic[0].doctor_name 
        });
    }
    
    const dateStr = new Date(apt.appointment_date).toLocaleDateString('en-IN', { 
        weekday: 'long', 
        day: 'numeric', 
        month: 'long', 
        year: 'numeric' 
    });
    
    if (isApprove) {
        await sendWhatsApp(
            apt.patient_phone, 
            `✅ *APPOINTMENT CONFIRMED!*\n\n━━━━━━━━━━━━━━━━━━━━━\n📋 *Booking:* #${aptId}\n🏥 *Clinic:* ${clinic[0].name}\n👨‍⚕️ *Doctor:* Dr. ${clinic[0].doctor_name}\n📅 *Date:* ${dateStr}\n⏰ *Time:* ${apt.appointment_time}\n━━━━━━━━━━━━━━━━━━━━━\n\n✓ Doctor has approved your appointment\n✓ Please arrive 10 minutes early\n\nSee you soon! 😊\n\n━━━━━━━━━━━━━━━━━━━━━\n*Need to change?*\n❌ CANCEL #${aptId}\n🔄 RESCHEDULE #${aptId}`
        );
    } else {
        await sendWhatsApp(
            apt.patient_phone, 
            `❌ *Appointment Not Available*\n\n━━━━━━━━━━━━━━━━━━━━━\n📋 *Booking:* #${aptId}\n━━━━━━━━━━━━━━━━━━━━━\n\nSorry, the requested time slot is no longer available.\n\nPlease reply *hi* to book a different slot.`
        );
        
        // Notify waitlist
        await notifyWaitlist(apt.clinic_id, apt.appointment_date, apt.appointment_slot);
    }
    
    await sendWhatsApp(
        phone, 
        `${isApprove ? '✅' : '❌'} *Appointment #${aptId} ${isApprove ? 'APPROVED' : 'REJECTED'}*\n\n━━━━━━━━━━━━━━━━━━━━━\n👤 Patient: ${apt.patient_name}\n📞 Phone: ${apt.patient_phone}\n📅 Date: ${dateStr}\n⏰ Time: ${apt.appointment_time}\n━━━━━━━━━━━━━━━━━━━━━\n\n✓ Patient has been notified`
    );
    
    return true;
}

// ═══════════════════════════════════════════════════════════
// 16. MESSAGE ROUTER
// ═══════════════════════════════════════════════════════════
async function handleMessage(phone, text) {
    try {
        const cmd = text.trim().toUpperCase();
        
        // Doctor commands - CHECK FIRST before anything else!
        const isDoctorCmd = await handleDoctorCommand(phone, text);
        if (isDoctorCmd) return;
        
        // Interactive commands
        if (cmd.startsWith('CONFIRM')) {
            const match = cmd.match(/CONFIRM\s+#?(\d+)/);
            if (match) {
                await handleConfirmCommand(phone, parseInt(match[1]));
                return;
            }
        }
        
        if (cmd.startsWith('CANCEL')) {
            const match = cmd.match(/CANCEL\s+#?(\d+)/);
            if (match) {
                await handleCancelCommand(phone, parseInt(match[1]));
                return;
            }
        }
        
        if (cmd.startsWith('RESCHEDULE')) {
            const match = cmd.match(/RESCHEDULE\s+#?(\d+)/);
            if (match) {
                await handleRescheduleCommand(phone, parseInt(match[1]));
                return;
            }
        }
        
        if (cmd.startsWith('YES')) {
            const match = cmd.match(/YES\s+(\d+)/);
            if (match) {
                await handleWaitlistAcceptance(phone, parseInt(match[1]));
                return;
            }
        }
        
        // Session flow
        const session = await getSession(phone);
        const msg = text.trim().toLowerCase();
        
        // FIX: Only restart if explicitly hi/hello/start/restart AND no active session
        // Don't treat numbers as restart commands!
        const isExplicitRestart = msg === 'hi' || msg === 'hello' || msg === 'start' || msg === 'restart';
        
        if (!session || isExplicitRestart) { 
            await handleStart(phone); 
            return; 
        }
        
        switch (session.stage) {
            case 'select_clinic': 
                await handleClinicSelect(phone, text); 
                break;
            case 'enter_name': 
                await handleName(phone, text); 
                break;
            case 'select_date': 
                await handleDate(phone, text); 
                break;
            case 'select_time': 
                await handleTime(phone, text); 
                break;
            default: 
                await handleStart(phone);
        }
        
    } catch (error) {
        log.error('Message handler error', error);
        await sendWhatsApp(phone, '❌ An error occurred. Reply *hi* to restart.');
    }
}

// ═══════════════════════════════════════════════════════════
// 17. PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({ 
    name: 'WhatsApp Clinic Bot - PILOT', 
    version: '6.0.0-pilot', 
    status: 'operational', 
    mode: 'pilot',
    payment_required: false,
    auto_approval: AUTO_APPROVAL_ENABLED,
    auto_approval_delay_minutes: AUTO_APPROVAL_DELAY_MINUTES,
    features: { 
        payment_integration: false, 
        auto_approval: AUTO_APPROVAL_ENABLED,
        manual_approval: true,
        smart_reminders: true, 
        interactive_commands: true, 
        waitlist: true,
        signature_verification: true
    }, 
    uptime: Math.floor(process.uptime()) 
}));

app.get('/health', async (req, res) => { 
    const h = { 
        status: 'healthy', 
        uptime: Math.floor(process.uptime()), 
        database: 'unknown',
        mode: 'pilot'
    }; 
    
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
app.get('/ping', (req, res) => res.status(200).json({ pong: true, mode: 'pilot' }));

app.get('/status', requireApiKey, async (req, res) => { 
    try { 
        const s = await sql`
            SELECT 
                (SELECT COUNT(*) FROM clinics WHERE status = 'active') as clinics, 
                (SELECT COUNT(*) FROM appointments WHERE DATE(created_at) = CURRENT_DATE) as today, 
                (SELECT COUNT(*) FROM appointments WHERE status = 'pending') as pending,
                (SELECT COUNT(*) FROM appointments WHERE status = 'confirmed') as confirmed,
                (SELECT COUNT(*) FROM appointments WHERE status = 'rejected') as rejected,
                (SELECT COUNT(*) FROM appointments WHERE auto_processed = true) as auto_approved
        `; 
        
        res.json({ 
            status: 'ok', 
            version: '6.0.0-pilot',
            mode: 'pilot',
            auto_approval: {
                enabled: AUTO_APPROVAL_ENABLED,
                delay_minutes: AUTO_APPROVAL_DELAY_MINUTES
            },
            stats: s[0] || {} 
        }); 
    } catch (e) { 
        res.status(500).json({ error: 'Database unavailable' }); 
    } 
});

// ═══════════════════════════════════════════════════════════
// 18. WEBHOOK ROUTE (SIGNATURE VERIFIED)
// ═══════════════════════════════════════════════════════════
app.post('/webhook/whatsapp', 
    webhookRateLimiter,
    verifyTwilioSignature,
    async (req, res) => {
        res.status(200).send('OK');
        
        try {
            const { From, Body, ButtonPayload } = req.body;
            
            if (!From || !Body) { 
                log.warn('Invalid webhook payload'); 
                return; 
            }
            
            const message = ButtonPayload || Body;
            
            log.info('Incoming message', { 
                from: normalizePhone(From), 
                message, 
                isButton: !!ButtonPayload 
            });
            
            setImmediate(() => handleMessage(From, message));
            
        } catch (err) { 
            log.error('Webhook processing error', err); 
        }
    }
);

// ═══════════════════════════════════════════════════════════
// 18. GOOGLE SHEETS INTEGRATION - PER CLINIC
// ═══════════════════════════════════════════════════════════

/**
 * Middleware for Google Sheets API authentication - ADMIN (no clinic ID needed)
 * Used for centralized dashboard endpoints
 */
const requireAdminSheetsApiKey = async (req, res, next) => {
    try {
        const apiKey = req.headers['x-api-key'] || req.query.apiKey;
        
        if (!apiKey) {
            return res.status(401).json({ error: 'API key required' });
        }
        
        // Check ADMIN_API_KEY from environment
        if (process.env.ADMIN_API_KEY && apiKey === process.env.ADMIN_API_KEY) {
            log.info('Admin API key validated (from environment)');
            return next();
        }
        
        // Also accept any valid clinic API key for backwards compatibility
        const clinic = await dbQuery(sql`
            SELECT * FROM clinics 
            WHERE sheets_api_key = ${apiKey}
            LIMIT 1
        `);
        
        if (clinic && clinic.length > 0) {
            log.info('Valid clinic API key used for admin endpoint', { clinicId: clinic[0].id });
            return next();
        }
        
        return res.status(401).json({ error: 'Invalid API key' });
        
    } catch (error) {
        log.error('Admin Sheets API auth error', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
};

/**
 * Middleware for Google Sheets API authentication - PER CLINIC
 * Each clinic has their own API key stored in the database
 * Also accepts ADMIN_API_KEY for convenience
 */
const requireSheetsApiKey = async (req, res, next) => {
    try {
        const apiKey = req.headers['x-api-key'] || req.query.apiKey;
        const clinicId = req.params.clinicId || req.query.clinicId;
        
        if (!apiKey) {
            return res.status(401).json({ error: 'API key required' });
        }
        
        if (!clinicId) {
            return res.status(400).json({ error: 'Clinic ID required' });
        }
        
        // Check if using ADMIN_API_KEY (works for all clinics)
        if (process.env.ADMIN_API_KEY && apiKey === process.env.ADMIN_API_KEY) {
            // Load clinic info without checking API key
            const clinic = await dbQuery(sql`
                SELECT * FROM clinics 
                WHERE id = ${parseInt(clinicId)}
                LIMIT 1
            `);
            
            if (!clinic || clinic.length === 0) {
                return res.status(404).json({ error: 'Clinic not found' });
            }
            
            log.info('Admin API key used for clinic endpoint', { clinicId });
            req.clinic = clinic[0];
            return next();
        }
        
        // Otherwise, verify API key matches clinic
        const clinic = await dbQuery(sql`
            SELECT * FROM clinics 
            WHERE id = ${parseInt(clinicId)} 
            AND sheets_api_key = ${apiKey}
            LIMIT 1
        `);
        
        if (!clinic || clinic.length === 0) {
            return res.status(401).json({ error: 'Invalid API key for this clinic' });
        }
        
        req.clinic = clinic[0];
        next();
        
    } catch (error) {
        log.error('Sheets API auth error', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
};

/**
 * GET /api/sheets/:clinicId/appointments
 * Get all appointments for a specific clinic
 */
app.get('/api/sheets/:clinicId/appointments', requireSheetsApiKey, async (req, res) => {
    try {
        const clinicId = parseInt(req.params.clinicId);
        const { status, startDate, endDate, limit } = req.query;
        
        // Build WHERE conditions as simple strings
        let whereConditions = [`a.clinic_id = ${clinicId}`];
        
        if (status) {
            whereConditions.push(`a.status = '${status}'`);
        }
        
        if (startDate) {
            whereConditions.push(`a.appointment_date >= '${startDate}'`);
        }
        
        if (endDate) {
            whereConditions.push(`a.appointment_date <= '${endDate}'`);
        }
        
        const whereClause = 'WHERE ' + whereConditions.join(' AND ');
        const limitClause = limit ? `LIMIT ${parseInt(limit)}` : '';
        
        const query = `
            SELECT 
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_date,
                a.appointment_time,
                a.status,
                a.created_at,
                a.approved_at,
                a.rejected_at,
                a.cancelled_at,
                a.auto_processed
            FROM appointments a
            ${whereClause}
            ORDER BY a.created_at DESC
            ${limitClause}
        `;
        
        const appointments = await sql(query);
        
        // Format for Google Sheets
        const formatted = appointments.map(apt => ({
            'ID': apt.id,
            'Patient Name': apt.patient_name,
            'Patient Phone': apt.patient_phone.replace('whatsapp:', ''),
            'Date': new Date(apt.appointment_date).toLocaleDateString('en-IN', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            }),
            'Time': apt.appointment_time,
            'Status': apt.status.toUpperCase(),
            'Booked At': new Date(apt.created_at).toLocaleString('en-IN', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            }),
            'Approved At': apt.approved_at ? new Date(apt.approved_at).toLocaleString('en-IN', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            }) : '',
            'Auto Approved': apt.auto_processed ? 'Yes' : 'No'
        }));
        
        res.json({
            success: true,
            clinic: req.clinic.name,
            count: formatted.length,
            data: formatted
        });
        
    } catch (error) {
        log.error('Sheets API error - appointments', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/sheets/:clinicId/stats
 * Get statistics for a specific clinic
 */
app.get('/api/sheets/:clinicId/stats', requireSheetsApiKey, async (req, res) => {
    try {
        const clinicId = parseInt(req.params.clinicId);
        
        const stats = await sql`
            SELECT 
                COUNT(*) as total_appointments,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
                COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed,
                COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected,
                COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled,
                COUNT(CASE WHEN auto_processed = true THEN 1 END) as auto_approved,
                COUNT(CASE WHEN DATE(appointment_date) = CURRENT_DATE THEN 1 END) as today,
                COUNT(CASE WHEN DATE(appointment_date) = CURRENT_DATE + INTERVAL '1 day' THEN 1 END) as tomorrow,
                COUNT(CASE WHEN DATE(created_at) >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as last_7_days,
                COUNT(CASE WHEN DATE(created_at) >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as last_30_days,
                COUNT(CASE WHEN DATE(appointment_date) >= CURRENT_DATE 
                    AND DATE(appointment_date) <= CURRENT_DATE + INTERVAL '7 days' THEN 1 END) as next_7_days
            FROM appointments
            WHERE clinic_id = ${clinicId}
        `;
        
        const formatted = [{
            'Metric': 'Total Appointments',
            'Value': stats[0].total_appointments
        }, {
            'Metric': 'Pending',
            'Value': stats[0].pending
        }, {
            'Metric': 'Confirmed',
            'Value': stats[0].confirmed
        }, {
            'Metric': 'Rejected',
            'Value': stats[0].rejected
        }, {
            'Metric': 'Cancelled',
            'Value': stats[0].cancelled
        }, {
            'Metric': 'Auto-Approved',
            'Value': stats[0].auto_approved
        }, {
            'Metric': 'Today',
            'Value': stats[0].today
        }, {
            'Metric': 'Tomorrow',
            'Value': stats[0].tomorrow
        }, {
            'Metric': 'Next 7 Days',
            'Value': stats[0].next_7_days
        }, {
            'Metric': 'Last 7 Days',
            'Value': stats[0].last_7_days
        }, {
            'Metric': 'Last 30 Days',
            'Value': stats[0].last_30_days
        }];
        
        res.json({
            success: true,
            clinic: req.clinic.name,
            data: formatted
        });
        
    } catch (error) {
        log.error('Sheets API error - stats', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/sheets/:clinicId/today
 * Get today's appointments for a specific clinic
 */
app.get('/api/sheets/:clinicId/today', requireSheetsApiKey, async (req, res) => {
    try {
        const clinicId = parseInt(req.params.clinicId);
        
        const appointments = await sql`
            SELECT 
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_time,
                a.status,
                a.created_at,
                a.approved_at
            FROM appointments a
            WHERE a.clinic_id = ${clinicId}
            AND DATE(a.appointment_date) = CURRENT_DATE
            ORDER BY a.appointment_time
        `;
        
        const formatted = appointments.map(apt => ({
            'ID': apt.id,
            'Time': apt.appointment_time,
            'Patient Name': apt.patient_name,
            'Patient Phone': apt.patient_phone.replace('whatsapp:', ''),
            'Status': apt.status.toUpperCase(),
            'Booked At': new Date(apt.created_at).toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit'
            })
        }));
        
        res.json({
            success: true,
            clinic: req.clinic.name,
            date: new Date().toLocaleDateString('en-IN'),
            count: formatted.length,
            data: formatted
        });
        
    } catch (error) {
        log.error('Sheets API error - today', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/sheets/:clinicId/range
 * Get appointments for a date range
 */
app.get('/api/sheets/:clinicId/range', requireSheetsApiKey, async (req, res) => {
    try {
        const clinicId = parseInt(req.params.clinicId);
        const { start, end } = req.query;
        
        if (!start || !end) {
            return res.status(400).json({ 
                error: 'start and end date required (YYYY-MM-DD format)' 
            });
        }
        
        const appointments = await sql`
            SELECT 
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_date,
                a.appointment_time,
                a.status
            FROM appointments a
            WHERE a.clinic_id = ${clinicId}
            AND a.appointment_date BETWEEN ${start} AND ${end}
            ORDER BY a.appointment_date, a.appointment_time
        `;
        
        const formatted = appointments.map(apt => ({
            'ID': apt.id,
            'Date': new Date(apt.appointment_date).toLocaleDateString('en-IN'),
            'Time': apt.appointment_time,
            'Patient': apt.patient_name,
            'Phone': apt.patient_phone.replace('whatsapp:', ''),
            'Status': apt.status.toUpperCase()
        }));
        
        res.json({
            success: true,
            clinic: req.clinic.name,
            dateRange: `${start} to ${end}`,
            count: formatted.length,
            data: formatted
        });
        
    } catch (error) {
        log.error('Sheets API error - range', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/sheets/:clinicId/info
 * Get clinic information
 */
app.get('/api/sheets/:clinicId/info', requireSheetsApiKey, async (req, res) => {
    try {
        const clinic = req.clinic;
        
        const formatted = [{
            'Field': 'Clinic Name',
            'Value': clinic.name
        }, {
            'Field': 'Doctor Name',
            'Value': `Dr. ${clinic.doctor_name}`
        }, {
            'Field': 'Doctor WhatsApp',
            'Value': clinic.doctor_whatsapp ? clinic.doctor_whatsapp.replace('whatsapp:', '') : ''
        }, {
            'Field': 'Business Hours',
            'Value': `${clinic.business_hours_start} - ${clinic.business_hours_end}`
        }, {
            'Field': 'Status',
            'Value': clinic.status.toUpperCase()
        }];
        
        res.json({
            success: true,
            data: formatted
        });
        
    } catch (error) {
        log.error('Sheets API error - info', error);
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// 19. BULK ENDPOINTS FOR CENTRALIZED DASHBOARD (1000+ CLINICS)
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/sheets/all-clinics
 * Get list of all clinics for dropdown selector
 * Used by centralized dashboard
 */
app.get('/api/sheets/all-clinics', requireAdminSheetsApiKey, async (req, res) => {
    try {
        const clinics = await sql`
            SELECT 
                id,
                name,
                doctor_name,
                status,
                business_hours_start,
                business_hours_end
            FROM clinics
            WHERE status = 'active'
            ORDER BY name
        `;
        
        res.json({
            success: true,
            count: clinics.length,
            data: clinics
        });
        
    } catch (error) {
        log.error('Get all clinics error', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/sheets/bulk/stats
 * Get statistics for all clinics
 * Used by centralized dashboard for overview
 */
app.get('/api/sheets/bulk/stats', requireAdminSheetsApiKey, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 100;
        const offset = (page - 1) * limit;
        
        const stats = await sql`
            SELECT 
                c.id,
                c.name,
                c.doctor_name,
                COUNT(a.id) as total_appointments,
                COUNT(CASE WHEN a.status = 'pending' THEN 1 END) as pending,
                COUNT(CASE WHEN a.status = 'confirmed' THEN 1 END) as confirmed,
                COUNT(CASE WHEN a.status = 'rejected' THEN 1 END) as rejected,
                COUNT(CASE WHEN a.status = 'cancelled' THEN 1 END) as cancelled,
                COUNT(CASE WHEN DATE(a.appointment_date) = CURRENT_DATE THEN 1 END) as today,
                COUNT(CASE WHEN DATE(a.appointment_date) = CURRENT_DATE + INTERVAL '1 day' THEN 1 END) as tomorrow,
                COUNT(CASE WHEN DATE(a.appointment_date) >= CURRENT_DATE 
                    AND DATE(a.appointment_date) <= CURRENT_DATE + INTERVAL '7 days' THEN 1 END) as next_7_days,
                COUNT(CASE WHEN DATE(a.created_at) >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as last_7_days,
                COUNT(CASE WHEN DATE(a.created_at) >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as last_30_days
            FROM clinics c
            LEFT JOIN appointments a ON c.id = a.clinic_id
            WHERE c.status = 'active'
            GROUP BY c.id, c.name, c.doctor_name
            ORDER BY c.name
            LIMIT ${limit}
            OFFSET ${offset}
        `;
        
        const totalResult = await sql`
            SELECT COUNT(*) as count 
            FROM clinics 
            WHERE status = 'active'
        `;
        
        res.json({
            success: true,
            count: stats.length,
            total: totalResult[0].count,
            data: stats,
            pagination: {
                page,
                limit,
                total: totalResult[0].count,
                pages: Math.ceil(totalResult[0].count / limit)
            }
        });
        
    } catch (error) {
        log.error('Bulk stats error', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/sheets/bulk/today
 * Get today's appointments across all clinics
 * Used for cross-clinic daily overview
 */
app.get('/api/sheets/bulk/today', requireAdminSheetsApiKey, async (req, res) => {
    try {
        const appointments = await sql`
            SELECT 
                c.name as clinic_name,
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_time,
                a.status,
                a.created_at
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE DATE(a.appointment_date) = CURRENT_DATE
            AND c.status = 'active'
            ORDER BY a.appointment_time, c.name
        `;
        
        const formatted = appointments.map(apt => ({
            'Clinic': apt.clinic_name,
            'ID': apt.id,
            'Time': apt.appointment_time,
            'Patient Name': apt.patient_name,
            'Patient Phone': apt.patient_phone.replace('whatsapp:', ''),
            'Status': apt.status.toUpperCase(),
            'Booked At': new Date(apt.created_at).toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit'
            })
        }));
        
        res.json({
            success: true,
            date: new Date().toLocaleDateString('en-IN'),
            count: formatted.length,
            data: formatted
        });
        
    } catch (error) {
        log.error('Bulk today error', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/sheets/search
 * Search for patients across all clinics
 * Requires query parameter: q (search term)
 */
app.get('/api/sheets/search', requireAdminSheetsApiKey, async (req, res) => {
    try {
        const searchTerm = req.query.q;
        
        if (!searchTerm || searchTerm.trim().length < 2) {
            return res.status(400).json({ 
                error: 'Search term required (minimum 2 characters)' 
            });
        }
        
        const search = `%${searchTerm.toLowerCase()}%`;
        
        const results = await sql`
            SELECT 
                c.name as clinic_name,
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_date,
                a.appointment_time,
                a.status,
                a.created_at
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE (
                LOWER(a.patient_name) LIKE ${search}
                OR LOWER(a.patient_phone) LIKE ${search}
            )
            AND c.status = 'active'
            ORDER BY a.created_at DESC
            LIMIT 100
        `;
        
        const formatted = results.map(apt => ({
            'Clinic': apt.clinic_name,
            'ID': apt.id,
            'Patient Name': apt.patient_name,
            'Patient Phone': apt.patient_phone.replace('whatsapp:', ''),
            'Date': new Date(apt.appointment_date).toLocaleDateString('en-IN'),
            'Time': apt.appointment_time,
            'Status': apt.status.toUpperCase(),
            'Booked At': new Date(apt.created_at).toLocaleString('en-IN', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            })
        }));
        
        res.json({
            success: true,
            searchTerm: searchTerm,
            count: formatted.length,
            data: formatted
        });
        
    } catch (error) {
        log.error('Search error', error);
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// 20. CRON ENDPOINTS (API KEY REQUIRED)
// ═══════════════════════════════════════════════════════════
app.post('/cron/auto-approval', requireApiKey, async (req, res) => {
    try {
        const { processAutoApprovals } = require('./processAutoApprovals');
        const result = await processAutoApprovals();
        res.json({ success: true, result });
    } catch (error) {
        log.error('Auto-approval cron failed', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/cron/send-reminders', requireApiKey, async (req, res) => { 
    try { 
        const { sendReminders } = require('./sendReminders'); 
        const result = await sendReminders(); 
        res.json({ success: true, result }); 
    } catch (e) { 
        log.error('Reminder cron failed', e);
        res.status(500).json({ error: e.message }); 
    } 
});

// ═══════════════════════════════════════════════════════════
// 20. ERROR HANDLERS
// ═══════════════════════════════════════════════════════════
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

app.use((err, req, res, next) => { 
    log.error('Unhandled error', err); 
    res.status(500).json({ error: 'Internal Server Error' }); 
});

// ═══════════════════════════════════════════════════════════
// 21. SERVER STARTUP
// ═══════════════════════════════════════════════════════════
async function startServer() {
    try {
        log.info('Starting server v7.0.0-ultimate...');
        
        await sql`SELECT NOW()`;
        log.success('Database connected');
        
        app.listen(PORT, HOST, () => {
            console.log('\n═══════════════════════════════════════════════════════════');
            console.log('🚀 WHATSAPP CLINIC BOT v7.0.0 - ULTIMATE EDITION');
            console.log('═══════════════════════════════════════════════════════════');
            console.log(`📡 Port: ${PORT}`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`💾 Database: Connected ✅`);
            console.log(`🎉 Mode: PRODUCTION - All Features Active ✅`);
            console.log(`🔒 Security: Enhanced ✅`);
            console.log(`   ├─ Environment Validation: Active ✅`);
            console.log(`   ├─ Twilio Signature: ${process.env.SKIP_TWILIO_VERIFICATION === 'true' ? 'DISABLED ⚠️' : 'Enabled ✅'}`);
            console.log(`   ├─ API Key Protection: ${process.env.ADMIN_API_KEY ? 'Enabled ✅' : 'Disabled ⚠️'}`);
            console.log(`   ├─ Rate Limiting: Active ✅`);
            console.log(`   └─ Security Headers: Active ✅`);
            console.log(`⏰ Auto-Approval: ${AUTO_APPROVAL_ENABLED ? `Enabled (${AUTO_APPROVAL_DELAY_MINUTES} min) ✅` : 'Disabled ⚠️'}`);
            console.log(`📋 Manual Approval: Enabled ✅`);
            console.log(`📊 Google Sheets: Individual + Centralized ✅`);
            console.log(`🔍 Bulk Operations: Search, Stats, Overview ✅`);
            console.log(`📈 Scalability: Ready for 1000+ Clinics ✅`);
            console.log('═══════════════════════════════════════════════════════════');
            console.log('✅ ULTIMATE SERVER READY - ALL SYSTEMS OPERATIONAL');
            console.log('═══════════════════════════════════════════════════════════\n');
        });
        
    } catch (e) { 
        log.error('Server startup failed', e); 
        process.exit(1); 
    }
}

process.on('SIGTERM', () => { 
    log.info('SIGTERM received, shutting down gracefully'); 
    process.exit(0); 
});

process.on('SIGINT', () => { 
    log.info('SIGINT received, shutting down gracefully'); 
    process.exit(0); 
});

process.on('uncaughtException', (error) => { 
    log.error('UNCAUGHT EXCEPTION - FATAL', error); 
    process.exit(1); 
});

process.on('unhandledRejection', (reason) => { 
    log.error('UNHANDLED REJECTION', { reason }); 
});

startServer();
module.exports = app;
