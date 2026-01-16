/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHATSAPP CLINIC BOT v8.2.0 - WITH QR CODE SUPPORT
 * 
 * ✅ WhatsApp Appointment Booking
 * ✅ Doctor Specialization Selection
 * ✅ QR Code Clinic Routing - NEW ✨
 * ✅ Auto-Approval System (24hr) - INLINE CRON
 * ✅ Smart Reminders (24hr + 2hr)
 * ✅ Manual Approve/Reject by Doctor
 * ✅ Enhanced Doctor Notifications with Retry Logic
 * ✅ Google Sheets Integration (Individual)
 * ✅ Google Sheets Integration (Centralized for 1000+)
 * ✅ Bulk Operations & Search
 * ✅ Bulk Report Endpoint
 * ✅ Message Chunking (1600 char limit fix)
 * ✅ Duplicate Dr. prefix fix
 * ✅ Security Hardened
 * ✅ Production Ready
 * ✅ Webhook Fixed
 * 
 * NEW in v8.2.0:
 * - QR code clinic routing (bypass clinic selection menu)
 * - Direct clinic access via unique codes
 * - WhatsApp deep link support
 * 
 * Author: Sourav Roy - Legacylens Automation
 * Modified: 2026-01-15 - QR Code Support Added
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 1. LOAD ENVIRONMENT
// ═══════════════════════════════════════════════════════════════════════
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════════
// 2. ENVIRONMENT VALIDATION - NON-BLOCKING
// ═══════════════════════════════════════════════════════════════════════
const requiredEnvVars = [
    'DATABASE_URL',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'WABA_NUMBER',
    'BASE_URL',
    // 'PORT' - provided by Railway
];

console.log('\n🔍 Validating Environment Variables...');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

let missingVars = [];
let hasErrors = false;

requiredEnvVars.forEach(varName => {
    if (!process.env[varName]) {
        console.error(`❌ Missing: ${varName}`);
        missingVars.push(varName);
        hasErrors = true;
    } else {
        const isSensitive = varName.includes('SECRET') || varName.includes('TOKEN') || varName.includes('KEY') || varName.includes('SID');
        const value = process.env[varName];
        const display = isSensitive ? `${value.substring(0, 8)}***` : value;
        console.log(`✅ ${varName.padEnd(25)} = ${display}`);
    }
});

if (hasErrors) {
    console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('⚠️  VALIDATION WARNING');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`Missing variables: ${missingVars.join(', ')}`);
    console.error('⚠️  Server will start but features may be limited');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    // ✅ DO NOT EXIT - Let server start anyway
} else {
    console.log('\n✅ All environment variables validated');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// ═══════════════════════════════════════════════════════════════════════
// 3. CORE DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════════
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cors = require('cors');
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');
const twilio = require('twilio');

// ═══════════════════════════════════════════════════════════════════════
// 4. INITIALIZE
// ═══════════════════════════════════════════════════════════════════════
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

const sql = neon(process.env.DATABASE_URL);
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// ✅ HEALTH – MUST BE SYNC + NO DB
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy' });
});

// Optional ping
app.get('/ping', (req, res) => {
    res.status(200).json({ pong: true });
});

// Auto-approval settings
const AUTO_APPROVAL_ENABLED = process.env.AUTO_APPROVAL_ENABLED !== 'false';
const AUTO_APPROVAL_DELAY_MINUTES =
    parseInt(process.env.AUTO_APPROVAL_DELAY_MINUTES, 10) || 1440;

// Reminder settings
const REMINDER_24H_ENABLED = process.env.REMINDER_24H_ENABLED !== 'false';
const REMINDER_2H_ENABLED = process.env.REMINDER_2H_ENABLED !== 'false';

// (optional) DB health – NOT used by infra
app.get('/health/db', async (req, res) => {
    try {
        await sql`SELECT 1`;
        res.status(200).json({ db: 'connected' });
    } catch {
        res.status(503).json({ db: 'down' });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// 5. LOGGING
// ═══════════════════════════════════════════════════════════════════════
const log = {
    info: (msg, data = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', message: msg, ...data })),
    success: (msg, data = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'SUCCESS', message: msg, ...data })),
    warn: (msg, data = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'WARNING', message: msg, ...data })),
    error: (msg, error = {}) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'ERROR', message: msg, error: error.message || String(error), stack: error.stack || '' }))
};

// ═══════════════════════════════════════════════════════════════════════
// 6. SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// 7. APPLY MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════
app.set('trust proxy', 1);
app.use(helmet());
app.use(setSecurityHeaders);
app.use(cors());
app.use(compression());
app.use(sanitizeRequest);
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

const webhookRateLimiter = rateLimit({
    windowMs: 60000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false
});

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

// ═══════════════════════════════════════════════════════════════════════
// 8. MESSAGE CHUNKING UTILITIES
// ═══════════════════════════════════════════════════════════════════════

function chunkMessage(message, maxLength = 1500) {
    if (message.length <= maxLength) {
        return [message];
    }

    const chunks = [];
    let currentChunk = '';
    const lines = message.split('\n');

    for (const line of lines) {
        if (line.length > maxLength) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }
            
            const words = line.split(' ');
            let tempLine = '';
            
            for (const word of words) {
                if ((tempLine + word).length > maxLength) {
                    chunks.push(tempLine.trim());
                    tempLine = word + ' ';
                } else {
                    tempLine += word + ' ';
                }
            }
            
            if (tempLine) {
                currentChunk = tempLine;
            }
            continue;
        }

        if ((currentChunk + '\n' + line).length > maxLength) {
            chunks.push(currentChunk.trim());
            currentChunk = line + '\n';
        } else {
            currentChunk += (currentChunk ? '\n' : '') + line;
        }
    }

    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

async function sendLongMessage(to, message, delayMs = 1000) {
    const chunks = chunkMessage(message);
    
    log.info(`Chunking message`, { to: normalizePhone(to), chunks: chunks.length, originalLength: message.length });
    
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n\n` : '';
        
        const phone = formatForWhatsApp(to);
        await twilioClient.messages.create({
            from: process.env.WABA_NUMBER,
            to: phone,
            body: prefix + chunk
        });
        
        log.info('Message chunk sent', { to: normalizePhone(phone), chunk: i + 1, total: chunks.length });
        
        if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    
    return chunks.length;
}

// ═══════════════════════════════════════════════════════════════════════
// 9. UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════
function normalizePhone(phone) {
    if (!phone) return '';
    return phone.replace('whatsapp:', '').trim();
}

function formatForWhatsApp(phone) {
    if (!phone) return '';
    const clean = normalizePhone(phone);
    return clean.startsWith('whatsapp:') ? clean : `whatsapp:${clean}`;
}

function formatDoctorName(name) {
    if (!name) return '';
    const cleaned = name.trim().replace(/^(Dr\.?\s*|DR\.?\s*|dr\.?\s*)/i, '');
    return `Dr. ${cleaned}`;
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
        
        if (message.length > 1500) {
            log.warn(`Message exceeds limit`, { length: message.length, chunking: true });
            const chunksSent = await sendLongMessage(to, message);
            log.success('Long message sent in chunks', { chunks: chunksSent });
            return true;
        }

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

async function sendDoctorNotification(to, appointmentDetails, appointmentId, retryCount = 0) {
    const MAX_RETRIES = 2;
    
    try {
        if (!to) {
            log.error('❌ No doctor phone number', { appointmentId });
            return false;
        }
        
        const phone = formatForWhatsApp(to);
        const { patientName, patientPhone, date, time, clinicName, doctorName, specialization } = appointmentDetails;
        
        log.info(`📞 Sending doctor notification (attempt ${retryCount + 1})`, {
            to: normalizePhone(phone),
            appointmentId,
            doctor: doctorName
        });
        
        const approvalTime = AUTO_APPROVAL_DELAY_MINUTES >= 60 
            ? `${Math.floor(AUTO_APPROVAL_DELAY_MINUTES / 60)} hour${Math.floor(AUTO_APPROVAL_DELAY_MINUTES / 60) > 1 ? 's' : ''}`
            : `${AUTO_APPROVAL_DELAY_MINUTES} minute${AUTO_APPROVAL_DELAY_MINUTES > 1 ? 's' : ''}`;
        
        let bodyText = `📢 *NEW APPOINTMENT REQUEST*\n\n━━━━━━━━━━━━━━━━━━━━\n📋 *Appointment ID:* #${appointmentId}\n🏥 *Clinic:* ${clinicName || 'N/A'}\n`;
        
        if (doctorName && specialization) {
            bodyText += `👨‍⚕️ *Doctor:* ${formatDoctorName(doctorName)}\n`;
            bodyText += `🩺 *Specialization:* ${specialization}\n`;
        }
        
        bodyText += `\n*PATIENT DETAILS:*\n👤 *Name:* ${patientName}\n📞 *Phone:* ${patientPhone}\n\n*APPOINTMENT DETAILS:*\n📅 *Date:* ${date}\n⏰ *Time:* ${time}\n━━━━━━━━━━━━━━━━━━━━\n\n*ACTIONS REQUIRED:*\n\n✅ *APPROVE:* Reply *APPROVE #${appointmentId}*\n❌ *REJECT:* Reply *REJECT #${appointmentId}*\n\n${AUTO_APPROVAL_ENABLED ? `⏰ *Auto-approves in ${approvalTime}* if no action taken` : '⚠️ *Manual approval required*'}`;
        
        const success = await sendWhatsApp(to, bodyText);
        
        if (success) {
            log.success('✅ Doctor notification sent!', { 
                to: normalizePhone(phone), 
                appointmentId, 
                doctor: doctorName 
            });
            return true;
        } else {
            throw new Error('sendWhatsApp returned false');
        }
        
    } catch (error) {
        log.error('❌ Doctor notification failed', {
            error: error.message,
            appointmentId,
            attempt: retryCount + 1
        });
        
        if (retryCount < MAX_RETRIES) {
            log.info(`⏳ Retrying in 2 seconds (${retryCount + 2}/${MAX_RETRIES + 1})...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            return await sendDoctorNotification(to, appointmentDetails, appointmentId, retryCount + 1);
        }
        
        log.error('🚨 CRITICAL: Notification failed after all retries!', {
            appointmentId,
            doctorPhone: normalizePhone(to),
            totalAttempts: MAX_RETRIES + 1
        });
        
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 10. AUTO-APPROVAL SYSTEM
// ═══════════════════════════════════════════════════════════════════════
async function scheduleAutoApproval(appointmentId) {
    if (!AUTO_APPROVAL_ENABLED) {
        log.info('Auto-approval disabled', { appointmentId });
        return;
    }
    
    log.info('Auto-approval will process via cron', { 
        appointmentId, 
        delayMinutes: AUTO_APPROVAL_DELAY_MINUTES 
    });
}

// ═══════════════════════════════════════════════════════════════════════
// 11. SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════
// 12. CLINIC HELPERS
// ═══════════════════════════════════════════════════════════════════════
async function getActiveClinics() {
    const clinics = await dbQuery(sql`SELECT * FROM clinics WHERE status = 'active' ORDER BY id`);
    return clinics || [];
}

async function getClinic(id) {
    const clinic = await dbQuery(sql`SELECT * FROM clinics WHERE id = ${id} AND status = 'active' LIMIT 1`);
    return (clinic && clinic.length > 0) ? clinic[0] : null;
}

// ═══════════════════════════════════════════════════════════════════════
// 🆕 GET CLINIC BY CODE (QR CODE SUPPORT)
// ═══════════════════════════════════════════════════════════════════════
async function getClinicByCode(code) {
    if (!code) return null;
    const cleanCode = code.trim().toUpperCase();
    const clinic = await dbQuery(sql`
        SELECT * FROM clinics 
        WHERE UPPER(code) = ${cleanCode} 
        AND status = 'active' 
        LIMIT 1
    `);
    return (clinic && clinic.length > 0) ? clinic[0] : null;
}

// ═══════════════════════════════════════════════════════════════════════
// 13. DOCTOR SPECIALIZATION HELPERS
// ═══════════════════════════════════════════════════════════════════════
async function getDoctorsByClinic(clinicId) {
    const doctors = await dbQuery(sql`
        SELECT id, name, specialization, qualification, whatsapp, 
               schedule_days, schedule_time_start, schedule_time_end
        FROM doctors
        WHERE clinic_id = ${clinicId} AND status = 'active'
        ORDER BY specialization, name
    `);
    return doctors || [];
}

async function getSpecializationsByClinic(clinicId) {
    const specs = await dbQuery(sql`
        SELECT DISTINCT specialization 
        FROM doctors 
        WHERE clinic_id = ${clinicId} 
        AND status = 'active'
        AND specialization IS NOT NULL
        ORDER BY specialization
    `);
    return specs || [];
}

async function getDoctorsBySpecialization(clinicId, specialization) {
    const doctors = await dbQuery(sql`
        SELECT id, name, specialization, qualification, whatsapp,
               schedule_days, schedule_time_start, schedule_time_end
        FROM doctors
        WHERE clinic_id = ${clinicId}
        AND specialization = ${specialization}
        AND status = 'active'
        ORDER BY name
    `);
    return doctors || [];
}

async function getDoctor(id) {
    const doctor = await dbQuery(sql`SELECT * FROM doctors WHERE id = ${id} AND status = 'active' LIMIT 1`);
    return (doctor && doctor.length > 0) ? doctor[0] : null;
}

// ═══════════════════════════════════════════════════════════════════════
// 🆕 FORMAT DOCTOR SCHEDULE
// ═══════════════════════════════════════════════════════════════════════
function formatDoctorSchedule(schedule) {
    if (!schedule || typeof schedule !== 'object') {
        return '📅 Schedule not available';
    }
    
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const dayNames = {
        monday: 'Mon',
        tuesday: 'Tue',
        wednesday: 'Wed',
        thursday: 'Thu',
        friday: 'Fri',
        saturday: 'Sat',
        sunday: 'Sun'
    };
    
    let scheduleText = '📅 *Available:*\n';
    let hasSchedule = false;
    
    days.forEach(day => {
        if (schedule[day] && schedule[day].available) {
            hasSchedule = true;
            const start = schedule[day].start || '09:00';
            const end = schedule[day].end || '17:00';
            scheduleText += `   ${dayNames[day]}: ${start}-${end}\n`;
        }
    });
    
    return hasSchedule ? scheduleText : '📅 Schedule not available';
}

function getDoctorAvailableDays(schedule) {
    if (!schedule || typeof schedule !== 'object') {
        return ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    }
    
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    return days.filter(day => schedule[day] && schedule[day].available);
}

function getDoctorAvailableHours(schedule, dayOfWeek) {
    if (!schedule || typeof schedule !== 'object' || !schedule[dayOfWeek]) {
        return { start: 9, end: 17 };
    }
    
    const daySchedule = schedule[dayOfWeek];
    if (!daySchedule.available) {
        return null;
    }
    
    const start = parseInt(daySchedule.start?.split(':')[0] || '9');
    const end = parseInt(daySchedule.end?.split(':')[0] || '17');
    
    return { start, end };
}

// ═══════════════════════════════════════════════════════════════════════
// 14. WAITLIST MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════
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
        
        await scheduleAutoApproval(appt[0].id);
        
    } catch (error) {
        log.error('Waitlist acceptance failed', error);
        await sendWhatsApp(phone, '❌ Error booking slot.');
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 15. INTERACTIVE COMMANDS
// ═══════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════
// 16. CONVERSATION FLOW
// ═══════════════════════════════════════════════════════════════════════

async function handleStart(phone) {
    const clinics = await getActiveClinics();
    
    if (clinics.length === 0) { 
        await sendWhatsApp(phone, '⚠️ *Service Unavailable*\n\nNo clinics available. Please try again later.'); 
        return; 
    }
    
    await setSession(phone, { stage: 'select_clinic', session_data: {} });
    
    let msg = '👋 *Welcome to Clinic Appointments!*\n\n📋 *Select clinic:*\n\n';
    
    clinics.forEach((clinic, i) => { 
        msg += `*${i + 1}.* ${clinic.name}\n`;
        msg += `   👨‍⚕️ ${formatDoctorName(clinic.doctor_name)}`;
        
        if (clinic.specialization) {
            msg += ` - ${clinic.specialization}`;
        }
        msg += '\n';
        
        if (clinic.business_hours_start) {
            msg += `   ⏰ ${clinic.business_hours_start}-${clinic.business_hours_end}\n`;
        }
        msg += '\n';
    });
    
    msg += `Reply *1-${clinics.length}*`;
    
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
    
    const specializations = await getSpecializationsByClinic(clinic.id);
    
    if (specializations.length === 0) {
        await setSession(phone, { 
            stage: 'enter_name', 
            clinic_id: clinic.id, 
            session_data: {} 
        });
        await sendWhatsApp(phone, `✅ *${clinic.name}* selected\n\n👤 *What is your full name?*`);
    } else {
        await setSession(phone, { 
            stage: 'select_specialization', 
            clinic_id: clinic.id, 
            session_data: {} 
        });
        
        let msg = `✅ *${clinic.name}* selected\n\n🩺 *Select Specialization:*\n\n`;
        
        specializations.forEach((spec, i) => {
            msg += `*${i + 1}.* ${spec.specialization}\n`;
        });
        msg += `*${specializations.length + 1}.* View All Doctors\n`;
        msg += `\nReply *1-${specializations.length + 1}*`;
        
        await sendWhatsApp(phone, msg);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 17. SPECIALIZATION & DOCTOR HANDLERS
// ═══════════════════════════════════════════════════════════════════════
async function handleSpecializationSelect(phone, text) {
    const session = await getSession(phone);
    const specializations = await getSpecializationsByClinic(session.clinic_id);
    const choice = parseInt(text.trim());
    
    if (isNaN(choice) || choice < 1 || choice > specializations.length + 1) { 
        await sendWhatsApp(phone, `❌ Invalid choice. Reply *1-${specializations.length + 1}*`); 
        return; 
    }
    
    let data = session?.session_data || {};
    if (typeof data === 'string') { 
        try { data = JSON.parse(data); } catch (e) { data = {}; } 
    }
    
    if (choice === specializations.length + 1) {
        data.showAllDoctors = true;
        data.selectedSpecialization = null;
    } else {
        const selectedSpec = specializations[choice - 1].specialization;
        data.selectedSpecialization = selectedSpec;
        data.showAllDoctors = false;
    }
    
    await setSession(phone, { 
        stage: 'select_doctor', 
        clinic_id: session.clinic_id, 
        session_data: data 
    });
    
    await showDoctorsList(phone);
}

async function showDoctorsList(phone) {
    const session = await getSession(phone);
    let data = session?.session_data || {};
    
    if (typeof data === 'string') { 
        try { data = JSON.parse(data); } catch (e) { data = {}; } 
    }
    
    let doctors;
    let msg = '👨‍⚕️ *Select Doctor:*\n\n';
    
    if (data.showAllDoctors) {
        doctors = await getDoctorsByClinic(session.clinic_id);
        
        const grouped = {};
        doctors.forEach(doc => {
            const spec = doc.specialization || 'General';
            if (!grouped[spec]) grouped[spec] = [];
            grouped[spec].push(doc);
        });
        
        let doctorIndex = 1;
        const doctorsList = [];
        
        Object.keys(grouped).sort().forEach(spec => {
            msg += `🩺 *${spec}*\n`;
            grouped[spec].forEach(doc => {
                msg += `*${doctorIndex}.* ${formatDoctorName(doc.name)}\n`;
                if (doc.qualification) msg += `   📋 ${doc.qualification}\n`;
                doctorsList.push(doc);
                doctorIndex++;
            });
            msg += '\n';
        });
        
        data.doctorsList = doctorsList;
        msg += `Reply *1-${doctorsList.length}*`;
        
    } else {
        doctors = await getDoctorsBySpecialization(session.clinic_id, data.selectedSpecialization);
        
        msg += `🩺 *${data.selectedSpecialization}s:*\n\n`;
        doctors.forEach((doc, i) => {
            msg += `*${i + 1}.* ${formatDoctorName(doc.name)}\n`;
            if (doc.qualification) msg += `   📋 ${doc.qualification}\n\n`;
        });
        
        data.doctorsList = doctors;
        msg += `Reply *1-${doctors.length}*`;
    }
    
    await setSession(phone, { 
        stage: 'select_doctor', 
        clinic_id: session.clinic_id, 
        session_data: data 
    });
    
    await sendWhatsApp(phone, msg);
}

async function handleDoctorSelect(phone, text) {
    const session = await getSession(phone);
    let data = session?.session_data || {};
    
    if (typeof data === 'string') { 
        try { data = JSON.parse(data); } catch (e) { data = {}; } 
    }
    
    const doctors = data.doctorsList || [];
    const choice = parseInt(text.trim());
    
    if (isNaN(choice) || choice < 1 || choice > doctors.length) { 
        await sendWhatsApp(phone, `❌ Invalid choice. Reply *1-${doctors.length}*`); 
        return; 
    }
    
    const selectedDoctor = doctors[choice - 1];
    
    data.doctorId = selectedDoctor.id;
    data.doctorName = selectedDoctor.name;
    data.doctorSpecialization = selectedDoctor.specialization;
    data.doctorWhatsApp = selectedDoctor.whatsapp;
    data.doctorScheduleDays = selectedDoctor.schedule_days;
    data.doctorScheduleStart = selectedDoctor.schedule_time_start;
    data.doctorScheduleEnd = selectedDoctor.schedule_time_end;
    
    await setSession(phone, { 
        stage: 'enter_name', 
        clinic_id: session.clinic_id, 
        session_data: data 
    });
    
    let msg = `✅ *Doctor Selected:*\n\n`;
    msg += `👨‍⚕️ ${formatDoctorName(selectedDoctor.name)}\n`;
    msg += `🩺 ${selectedDoctor.specialization}\n`;
    if (selectedDoctor.qualification) msg += `🎓 ${selectedDoctor.qualification}\n`;
    
    // Show schedule
    if (selectedDoctor.schedule_days && selectedDoctor.schedule_time_start && selectedDoctor.schedule_time_end) {
        const days = selectedDoctor.schedule_days.split(',').join(', ');
        const startTime = selectedDoctor.schedule_time_start.substring(0, 5);
        const endTime = selectedDoctor.schedule_time_end.substring(0, 5);
        msg += `📅 *Days:* ${days}\n`;
        msg += `⏰ *Time:* ${startTime} - ${endTime}\n`;
    }
    
    msg += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `👤 *Your full name?*`;
    
    await sendWhatsApp(phone, msg);
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
    
    // Get doctor's available days if doctor is selected
    let availableDays = null;
    if (data.doctorId) {
        const doctor = await getDoctor(data.doctorId);
        if (doctor && doctor.schedule) {
            availableDays = getDoctorAvailableDays(doctor.schedule);
        }
    }
    
    let msg = `👤 ${name}\n\n📅 *Select date:*\n\n`;
    
    const today = new Date();
    let dateOptions = [];
    let optionNum = 1;
    
    // Generate next 14 days to ensure we get at least 7 available dates
    for (let i = 1; i <= 14 && dateOptions.length < 7; i++) { 
        const d = new Date(); 
        d.setDate(today.getDate() + i);
        
        // Check if this day is available for the doctor
        const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d.getDay()];
        
        if (availableDays) {
            // Doctor selected - filter by their schedule
            if (availableDays.includes(dayOfWeek)) {
                dateOptions.push({ num: optionNum, date: d, offset: i });
                msg += `*${optionNum}.* ${d.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' })}\n`;
                optionNum++;
            }
        } else {
            // No doctor selected - show all days
            dateOptions.push({ num: optionNum, date: d, offset: i });
            msg += `*${optionNum}.* ${d.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' })}\n`;
            optionNum++;
        }
    }
    
    // Store date options in session for later reference
    data.dateOptions = dateOptions;
    await setSession(phone, { 
        stage: 'select_date', 
        clinic_id: session.clinic_id, 
        session_data: data 
    });
    
    msg += `\nReply *1-${dateOptions.length}*`;
    
    await sendWhatsApp(phone, msg);
}

async function handleDate(phone, text) {
    const session = await getSession(phone);
    let data = session?.session_data || {};
    
    if (typeof data === 'string') { 
        try { data = JSON.parse(data); } catch (e) { data = {}; } 
    }
    
    const choice = parseInt(text.trim());
    const dateOptions = data.dateOptions || [];
    
    if (isNaN(choice) || choice < 1 || choice > dateOptions.length) { 
        await sendWhatsApp(phone, `❌ Invalid choice. Reply *1-${dateOptions.length}*`); 
        return; 
    }
    
    // Get the selected date from options
    const selectedOption = dateOptions.find(opt => opt.num === choice);
    if (!selectedOption) {
        await sendWhatsApp(phone, '❌ Invalid date selection. Please try again.');
        return;
    }
    
    const d = new Date();
    d.setDate(d.getDate() + selectedOption.offset);
    const dateStr = d.toISOString().split('T')[0];
    
    data.date = dateStr;
    data.selectedDateObject = d; // Store for later use
    
    await setSession(phone, { 
        stage: 'select_time', 
        clinic_id: session.clinic_id, 
        session_data: data 
    });
    
    // Get doctor's schedule for this day
    const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d.getDay()];
    
    let startHour = 9;
    let endHour = 18;
    
    if (data.doctorId) {
        const doctor = await getDoctor(data.doctorId);
        if (doctor && doctor.schedule) {
            const hours = getDoctorAvailableHours(doctor.schedule, dayOfWeek);
            if (hours) {
                startHour = hours.start;
                endHour = hours.end;
            }
        }
    } else {
        // Fallback to clinic hours
        const clinic = await getClinic(session.clinic_id);
        startHour = parseInt(clinic?.business_hours_start?.split(':')[0] || '9');
        endHour = parseInt(clinic?.business_hours_end?.split(':')[0] || '18');
    }
    
    let msg = `📅 ${d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}\n\n⏰ *Select time:*\n\n`;
    
    let slotNum = 1;
    for (let h = startHour; h < endHour; h++) { 
        const time = h >= 12 ? `${h === 12 ? 12 : h - 12}:00 PM` : `${h}:00 AM`; 
        msg += `*${slotNum}.* ${time}\n`;
        slotNum++;
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
    
    // Get doctor's schedule for the selected date
    const selectedDate = data.selectedDateObject ? new Date(data.selectedDateObject) : new Date(data.date);
    const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][selectedDate.getDay()];
    
    let startHour = 9;
    let endHour = 18;
    
    if (data.doctorId) {
        const doctor = await getDoctor(data.doctorId);
        if (doctor && doctor.schedule) {
            const hours = getDoctorAvailableHours(doctor.schedule, dayOfWeek);
            if (hours) {
                startHour = hours.start;
                endHour = hours.end;
            }
        }
    } else {
        const clinic = await getClinic(session.clinic_id);
        startHour = parseInt(clinic?.business_hours_start?.split(':')[0] || '9');
        endHour = parseInt(clinic?.business_hours_end?.split(':')[0] || '18');
    }
    
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
                clinic_id, doctor_id, patient_name, patient_phone, 
                appointment_date, appointment_time, appointment_slot, 
                status, reminder_sent, auto_processed, 
                reminder_24h_sent, reminder_2h_sent
            ) 
            VALUES (
                ${session.clinic_id}, ${data.doctorId || null}, ${data.name}, ${cleanPhone}, 
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
        
        const approvalTime = AUTO_APPROVAL_DELAY_MINUTES >= 60 
            ? `${Math.floor(AUTO_APPROVAL_DELAY_MINUTES / 60)} hour${Math.floor(AUTO_APPROVAL_DELAY_MINUTES / 60) > 1 ? 's' : ''}`
            : `${AUTO_APPROVAL_DELAY_MINUTES} minute${AUTO_APPROVAL_DELAY_MINUTES > 1 ? 's' : ''}`;
        
        const clinic = await getClinic(session.clinic_id);
        
        let confirmMsg = `✅ *Booked!*\n\n━━━━━━━━━━━━━━━━━━━━\n📋 #${aptId}\n👤 ${data.name}\n🏥 ${clinic.name}\n`;
        
        if (data.doctorName) {
            confirmMsg += `👨‍⚕️ ${formatDoctorName(data.doctorName)}\n`;
            confirmMsg += `🩺 ${data.doctorSpecialization}\n`;
        }
        
        confirmMsg += `📅 ${dateDisplay}\n⏰ ${timeSlot}\n━━━━━━━━━━━━━━━━━━━━\n\n⏳ *Pending approval*\n${AUTO_APPROVAL_ENABLED ? `⏰ Auto-approves in ${approvalTime}` : '⚠️ Manual approval required'}\n\nYou'll get confirmation soon!\n\n━━━━━━━━━━━━━━━━━━━━\n❌ CANCEL #${aptId}\n🔄 RESCHEDULE #${aptId}`;
        
        await sendWhatsApp(phone, confirmMsg);
        
        const doctorPhone = data.doctorWhatsApp || clinic.doctor_whatsapp;
        
        await sendDoctorNotification(
            doctorPhone,
            {
                patientName: data.name,
                patientPhone: cleanPhone,
                date: dateDisplay,
                time: timeSlot,
                clinicName: clinic.name,
                doctorName: data.doctorName || clinic.doctor_name,
                specialization: data.doctorSpecialization || 'General'
            },
            aptId
        );
        
        await scheduleAutoApproval(aptId);
        
        await clearSession(phone);
        
    } catch (error) {
        log.error('Appointment creation failed', error);
        await sendWhatsApp(phone, '❌ Error creating appointment. Try again or contact support.');
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 18. DOCTOR COMMANDS
// ═══════════════════════════════════════════════════════════════════════
async function handleDoctorCommand(phone, text) {
    const cleanPhone = normalizePhone(phone);
    const cmd = text.trim().toUpperCase();
    
    if (!cmd.startsWith('APPROVE') && !cmd.startsWith('REJECT')) return false;
    
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
            `✅ *CONFIRMED!*\n\n━━━━━━━━━━━━━━━━━━━━\n📋 #${aptId}\n🏥 ${clinic[0].name}\n👨‍⚕️ ${formatDoctorName(clinic[0].doctor_name)}\n📅 ${dateStr}\n⏰ ${apt.appointment_time}\n━━━━━━━━━━━━━━━━━━━━\n\n✔ Doctor approved\n✔ Arrive 10 min early\n\nSee you soon! 😊\n\n━━━━━━━━━━━━━━━━━━━━\n❌ CANCEL #${aptId}\n🔄 RESCHEDULE #${aptId}`
        );
    } else {
        await sendWhatsApp(
            apt.patient_phone, 
            `❌ *Not Available*\n\n━━━━━━━━━━━━━━━━━━━━\n📋 #${aptId}\n━━━━━━━━━━━━━━━━━━━━\n\nSlot unavailable.\n\nReply *hi* to book another.`
        );
        
        await notifyWaitlist(apt.clinic_id, apt.appointment_date, apt.appointment_slot);
    }
    
    await sendWhatsApp(
        phone, 
        `${isApprove ? '✅' : '❌'} *#${aptId} ${isApprove ? 'APPROVED' : 'REJECTED'}*\n\n━━━━━━━━━━━━━━━━━━━━\n👤 ${apt.patient_name}\n📞 ${apt.patient_phone}\n📅 ${dateStr}\n⏰ ${apt.appointment_time}\n━━━━━━━━━━━━━━━━━━━━\n\n✔ Patient notified`
    );
    
    return true;
}

// ═══════════════════════════════════════════════════════════════════════
// 19. MESSAGE ROUTER - WITH QR CODE SUPPORT
// ═══════════════════════════════════════════════════════════════════════
async function handleMessage(phone, text) {
    try {
        const cmd = text.trim().toUpperCase();
        const cleanText = text.trim();
        
        // ═══════════════════════════════════════════════════════════
        // 🆕 STEP 1: CHECK FOR CLINIC CODE (QR CODE SCAN) - FIRST PRIORITY
        // ═══════════════════════════════════════════════════════════
        
        // Try to find clinic by code
        const possibleCode = cleanText.replace(/_START$/i, '');
        const clinic = await getClinicByCode(possibleCode);
        
        if (clinic) {
            // QR CODE DETECTED! Skip clinic selection
            log.info('🎯 QR Code detected', { 
                code: possibleCode, 
                clinic: clinic.name,
                phone: normalizePhone(phone)
            });
            
            // Get all doctors for this clinic
            const doctors = await getDoctorsByClinic(clinic.id);
            
            if (doctors.length === 0) {
                // No doctors - show error
                await sendWhatsApp(phone, `⚠️ *${clinic.name}*\n\nNo doctors available at this clinic. Please contact support.`);
                return;
            }
            
            if (doctors.length === 1) {
                // Only one doctor - show info and go to name entry
                const doctor = doctors[0];
                
                let data = {
                    doctorId: doctor.id,
                    doctorName: doctor.name,
                    doctorSpecialization: doctor.specialization,
                    doctorWhatsApp: doctor.whatsapp,
                    doctorScheduleDays: doctor.schedule_days,
                    doctorScheduleStart: doctor.schedule_time_start,
                    doctorScheduleEnd: doctor.schedule_time_end
                };
                
                await setSession(phone, { 
                    stage: 'enter_name', 
                    clinic_id: clinic.id, 
                    session_data: data 
                });
                
                let msg = `🏥 *Welcome to ${clinic.name}!*\n\n`;
                msg += `👨‍⚕️ *Doctor:* ${formatDoctorName(doctor.name)}\n`;
                
                if (doctor.specialization) {
                    msg += `🩺 *Specialization:* ${doctor.specialization}\n`;
                }
                
                if (doctor.qualification) {
                    msg += `📋 *Qualification:* ${doctor.qualification}\n`;
                }
                
                // Show day-wise schedule
                if (doctor.schedule_days && doctor.schedule_time_start && doctor.schedule_time_end) {
                    const days = doctor.schedule_days.split(',').join(', ');
                    const startTime = doctor.schedule_time_start.substring(0, 5);
                    const endTime = doctor.schedule_time_end.substring(0, 5);
                    msg += `📅 *Days:* ${days}\n`;
                    msg += `⏰ *Time:* ${startTime} - ${endTime}\n`;
                } else if (clinic.business_hours_start && clinic.business_hours_end) {
                    msg += `⏰ *Time:* ${clinic.business_hours_start} - ${clinic.business_hours_end}\n`;
                }
                
                msg += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
                msg += `👤 *What is your full name?*`;
                
                await sendWhatsApp(phone, msg);
                return;
            }
            
            // Multiple doctors - show selection with specializations and timing
            await setSession(phone, { 
                stage: 'select_doctor', 
                clinic_id: clinic.id, 
                session_data: { doctorsList: doctors } 
            });
            
            let msg = `🏥 *Welcome to ${clinic.name}!*\n\n👨‍⚕️ *Select Doctor:*\n\n`;
            
            // Show each doctor with their schedule
            doctors.forEach((doc, index) => {
                msg += `*${index + 1}. ${formatDoctorName(doc.name)}*\n`;
                
                if (doc.specialization) {
                    msg += `🩺 ${doc.specialization}\n`;
                }
                
                if (doc.qualification) {
                    msg += `📋 ${doc.qualification}\n`;
                }
                
                // Show day-wise schedule if available
                if (doc.schedule_days && doc.schedule_time_start && doc.schedule_time_end) {
                    const days = doc.schedule_days.split(',').join(', ');
                    const startTime = doc.schedule_time_start.substring(0, 5); // HH:MM
                    const endTime = doc.schedule_time_end.substring(0, 5);
                    msg += `📅 *Days:* ${days}\n`;
                    msg += `⏰ *Time:* ${startTime} - ${endTime}\n`;
                } else if (clinic.business_hours_start && clinic.business_hours_end) {
                    // Fallback to clinic hours
                    msg += `⏰ *Time:* ${clinic.business_hours_start} - ${clinic.business_hours_end}\n`;
                }
                
                msg += '\n';
            });
            
            msg += `Reply *1-${doctors.length}*`;
            
            await sendWhatsApp(phone, msg);
            return;
        }
        
        // ═══════════════════════════════════════════════════════════
        // STEP 2: DOCTOR COMMANDS (APPROVE/REJECT)
        // ═══════════════════════════════════════════════════════════
        
        const isDoctorCmd = await handleDoctorCommand(phone, text);
        if (isDoctorCmd) return;
        
        // ═══════════════════════════════════════════════════════════
        // STEP 3: PATIENT COMMANDS (CONFIRM/CANCEL/RESCHEDULE)
        // ═══════════════════════════════════════════════════════════
        
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
        
        // ═══════════════════════════════════════════════════════════
        // STEP 4: SESSION-BASED FLOW (Normal clinic selection)
        // ═══════════════════════════════════════════════════════════
        
        const session = await getSession(phone);
        const msg = text.trim().toLowerCase();
        
        const isExplicitRestart = msg === 'hi' || msg === 'hello' || msg === 'start' || msg === 'restart';
        
        if (!session || isExplicitRestart) { 
            await handleStart(phone); 
            return; 
        }
        
        switch (session.stage) {
            case 'select_clinic': 
                await handleClinicSelect(phone, text); 
                break;
            case 'select_specialization':
                await handleSpecializationSelect(phone, text);
                break;
            case 'select_doctor':
                await handleDoctorSelect(phone, text);
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

// ═══════════════════════════════════════════════════════════════════════
// 20. PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({ 
    name: 'WhatsApp Clinic Bot', 
    version: '8.2.0', 
    status: 'operational', 
    auto_approval: AUTO_APPROVAL_ENABLED,
    auto_approval_delay_minutes: AUTO_APPROVAL_DELAY_MINUTES,
    reminder_24h_enabled: REMINDER_24H_ENABLED,
    reminder_2h_enabled: REMINDER_2H_ENABLED,
    features: { 
        qr_code_routing: true,
        payment_integration: false, 
        auto_approval: AUTO_APPROVAL_ENABLED,
        auto_approval_inline_cron: true,
        manual_approval: true,
        enhanced_doctor_notifications: true,
        notification_retry_logic: true,
        smart_reminders_24h: REMINDER_24H_ENABLED,
        smart_reminders_2h: REMINDER_2H_ENABLED,
        interactive_commands: true, 
        waitlist: true,
        message_chunking: true,
        duplicate_dr_fix: true,
        specializations_in_list: true,
        bulk_report_endpoint: true,
        signature_verification: true,
        webhook_fixed: true
    }, 
    uptime: Math.floor(process.uptime()) 
}));

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
            version: '8.2.0',
            auto_approval: {
                enabled: AUTO_APPROVAL_ENABLED,
                delay_minutes: AUTO_APPROVAL_DELAY_MINUTES
            },
            reminders: {
                reminder_24h_enabled: REMINDER_24H_ENABLED,
                reminder_2h_enabled: REMINDER_2H_ENABLED
            },
            stats: s[0] || {} 
        }); 
    } catch (e) { 
        res.status(500).json({ error: 'Database unavailable' }); 
    } 
});

// ═══════════════════════════════════════════════════════════════════════
// 21. WEBHOOK ROUTES
// ═══════════════════════════════════════════════════════════════════════

// ✅ PRIMARY WEBHOOK - Standard Twilio endpoint /webhook
app.post('/webhook',
    webhookRateLimiter,

    // Safety guard - prevents 502
    async (req, res, next) => {
        console.log('==============================================');
        console.log('📨 WEBHOOK RECEIVED at /webhook');
        console.log('==============================================');
        console.log('Method:', req.method);
        console.log('Path:', req.path);
        console.log('From:', req.body?.From || 'N/A');
        console.log('Body:', req.body?.Body || 'N/A');
        console.log('==============================================');
        
        if (!req.body || Object.keys(req.body).length === 0) {
            console.log('⚠️  Empty body - returning 200 OK');
            return res.status(200).send('OK');
        }
        next();
    },

    verifyTwilioSignature,

    async (req, res) => {
        // ✅ CRITICAL: Respond immediately to Twilio
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

// ✅ ALTERNATIVE WEBHOOK - Legacy support /webhook/whatsapp
app.post('/webhook/whatsapp',
    webhookRateLimiter,

    // ✅ SAFETY GUARD – prevents 502
    async (req, res, next) => {
        if (!req.body || Object.keys(req.body).length === 0) {
            return res.status(200).send('OK');
        }
        next();
    },

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

// ═══════════════════════════════════════════════════════════════════════
// 22. GOOGLE SHEETS INTEGRATION - PER CLINIC
// ═══════════════════════════════════════════════════════════════════════

const requireAdminSheetsApiKey = async (req, res, next) => {
    try {
        const apiKey = req.headers['x-api-key'] || req.query.apiKey;
        
        if (!apiKey) {
            return res.status(401).json({ error: 'API key required' });
        }
        
        if (process.env.ADMIN_API_KEY && apiKey === process.env.ADMIN_API_KEY) {
            log.info('Admin API key validated');
            return next();
        }
        
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
        
        if (process.env.ADMIN_API_KEY && apiKey === process.env.ADMIN_API_KEY) {
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

app.get('/api/sheets/:clinicId/appointments', requireSheetsApiKey, async (req, res) => {
    try {
        const clinicId = parseInt(req.params.clinicId);
        const { status, startDate, endDate, limit } = req.query;
        
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

app.get('/api/sheets/:clinicId/info', requireSheetsApiKey, async (req, res) => {
    try {
        const clinic = req.clinic;
        
        const formatted = [{
            'Field': 'Clinic Name',
            'Value': clinic.name
        }, {
            'Field': 'Doctor Name',
            'Value': formatDoctorName(clinic.doctor_name)
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

// ═══════════════════════════════════════════════════════════════════════
// 23. BULK ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

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

app.get('/api/sheets/bulk/report', requireAdminSheetsApiKey, async (req, res) => {
    try {
        const startTime = Date.now();
        
        log.info('Generating bulk report...');
        
        const clinics = await sql`
            SELECT 
                id,
                name,
                doctor_name,
                specialization,
                status,
                business_hours_start,
                business_hours_end
            FROM clinics
            WHERE status = 'active'
            ORDER BY name
        `;
        
        if (clinics.length === 0) {
            return res.json({
                success: true,
                data: {
                    clinics: [],
                    appointments: [],
                    today: [],
                    count: 0
                },
                loadTime: '0s'
            });
        }
        
        const today = new Date().toISOString().split('T')[0];
        
        const allAppointments = await sql`
            SELECT 
                c.name as clinic_name,
                c.doctor_name,
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_date,
                a.appointment_time,
                a.status,
                a.created_at,
                a.approved_at,
                a.auto_processed
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE c.status = 'active'
            ORDER BY a.created_at DESC
        `;
        
        const todayAppointments = await sql`
            SELECT 
                c.name as clinic_name,
                c.doctor_name,
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_time,
                a.status,
                a.created_at
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE c.status = 'active'
            AND DATE(a.appointment_date) = ${today}
            ORDER BY a.appointment_time, c.name
        `;
        
        const formattedAppointments = allAppointments.map(apt => ({
            'Clinic': apt.clinic_name,
            'Doctor': formatDoctorName(apt.doctor_name),
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
        
        const formattedToday = todayAppointments.map(apt => ({
            'Clinic': apt.clinic_name,
            'Doctor': formatDoctorName(apt.doctor_name),
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
        
        const loadTime = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
        
        log.success('Bulk report generated', {
            clinics: clinics.length,
            appointments: allAppointments.length,
            today: todayAppointments.length,
            loadTime
        });
        
        res.json({
            success: true,
            data: {
                clinics: clinics,
                appointments: formattedAppointments,
                today: formattedToday,
                count: allAppointments.length
            },
            loadTime: loadTime,
            generated: new Date().toISOString()
        });
        
    } catch (error) {
        log.error('Bulk report error', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate bulk report'
        });
    }
});


// ═══════════════════════════════════════════════════════════════════════
// 24. CRON ENDPOINTS - AUTO-APPROVAL + REMINDERS
// ═══════════════════════════════════════════════════════════════════════

// AUTO-APPROVAL CRON ENDPOINT
// SETUP: cron-job.org - Every 10 minutes
app.post('/cron/auto-approval', async (req, res) => {
    const startTime = Date.now();
    
    try {
        log.info('🔄 Auto-approval cron started');
        
        const threshold = new Date(Date.now() - AUTO_APPROVAL_DELAY_MINUTES * 60 * 1000);
        
        log.info('Auto-approval threshold', {
            delayMinutes: AUTO_APPROVAL_DELAY_MINUTES,
            threshold: threshold.toISOString()
        });
        
        const pending = await sql`
            SELECT 
                a.id,
                a.patient_name,
                a.patient_phone,
                a.appointment_date,
                a.appointment_time,
                a.created_at,
                a.clinic_id,
                a.doctor_id,
                c.name as clinic_name,
                c.doctor_name,
                c.doctor_whatsapp,
                d.name as assigned_doctor_name,
                d.specialization as assigned_doctor_specialization,
                d.whatsapp as assigned_doctor_whatsapp
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            LEFT JOIN doctors d ON a.doctor_id = d.id
            WHERE a.status = 'pending'
            AND a.created_at <= ${threshold.toISOString()}
            AND (a.auto_processed = false OR a.auto_processed IS NULL)
            ORDER BY a.created_at ASC
        `;
        
        log.info(`Found ${pending.length} appointments to auto-approve`, {
            thresholdTime: threshold.toISOString()
        });
        
        let approved = 0;
        let notified = 0;
        let errors = 0;
        
        for (const apt of pending) {
            try {
                const ageMinutes = Math.floor((Date.now() - new Date(apt.created_at).getTime()) / (1000 * 60));
                
                log.info(`Processing appointment #${apt.id}`, {
                    patient: apt.patient_name,
                    ageMinutes: ageMinutes
                });
                
                await sql`
                    UPDATE appointments
                    SET status = 'confirmed',
                        approved_at = NOW(),
                        auto_processed = true,
                        updated_at = NOW()
                    WHERE id = ${apt.id}
                `;
                
                approved++;
                log.success(`✅ Auto-approved appointment #${apt.id}`);
                
                const dateStr = new Date(apt.appointment_date).toLocaleDateString('en-IN', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric'
                });
                
                let patientMessage = `✅ *CONFIRMED!*\n\n━━━━━━━━━━━━━━━━━━━━\n📋 #${apt.id}\n🏥 ${apt.clinic_name}\n`;
                
                const doctorName = apt.assigned_doctor_name || apt.doctor_name;
                const doctorSpecialization = apt.assigned_doctor_specialization || 'General';
                
                if (doctorName) {
                    patientMessage += `👨‍⚕️ ${formatDoctorName(doctorName)}\n`;
                    patientMessage += `🩺 ${doctorSpecialization}\n`;
                }
                
                patientMessage += `📅 ${dateStr}\n⏰ ${apt.appointment_time}\n━━━━━━━━━━━━━━━━━━━━\n\n✔ Auto-approved\n✔ Arrive 10 min early\n\nSee you soon! 😊\n\n━━━━━━━━━━━━━━━━━━━━\n❌ CANCEL #${apt.id}\n🔄 RESCHEDULE #${apt.id}`;
                
                const patientSent = await sendWhatsApp(apt.patient_phone, patientMessage);
                
                if (patientSent) {
                    notified++;
                    log.success(`📱 Patient notified`, {
                        phone: apt.patient_phone.replace('whatsapp:', ''),
                        appointmentId: apt.id
                    });
                }
                
                const doctorPhone = apt.assigned_doctor_whatsapp || apt.doctor_whatsapp;
                
                if (doctorPhone) {
                    const hoursElapsed = Math.floor(ageMinutes / 60);
                    const timeElapsed = hoursElapsed >= 1 
                        ? `${hoursElapsed} hour${hoursElapsed > 1 ? 's' : ''}`
                        : `${ageMinutes} minutes`;
                    
                    let doctorMessage = `ℹ️ *AUTO-APPROVED*\n\n━━━━━━━━━━━━━━━━━━━━\n📋 #${apt.id}\n👤 ${apt.patient_name}\n📞 ${apt.patient_phone.replace('whatsapp:', '')}\n📅 ${dateStr}\n⏰ ${apt.appointment_time}\n━━━━━━━━━━━━━━━━━━━━\n\nAuto-approved after ${timeElapsed}.\nPatient notified.`;
                    
                    await sendWhatsApp(doctorPhone, doctorMessage);
                    log.info(`📱 Doctor notified`, {
                        phone: doctorPhone.replace('whatsapp:', ''),
                        appointmentId: apt.id
                    });
                }
                
            } catch (error) {
                errors++;
                log.error(`Error processing appointment #${apt.id}`, {
                    error: error.message,
                    appointmentId: apt.id
                });
            }
        }
        
        const duration = Date.now() - startTime;
        
        const summary = {
            success: true,
            processed: pending.length,
            approved: approved,
            notified: notified,
            errors: errors,
            durationMs: duration,
            timestamp: new Date().toISOString()
        };
        
        log.success('✅ Auto-approval cron completed', summary);
        
        res.json(summary);
        
    } catch (error) {
        const duration = Date.now() - startTime;
        log.error('❌ Auto-approval cron failed', {
            error: error.message,
            stack: error.stack
        });
        
        res.status(500).json({
            success: false,
            error: error.message,
            durationMs: duration
        });
    }
});

// REMINDER CRON ENDPOINT
// Sends 24-hour and 2-hour reminders
// SETUP: cron-job.org - Every 2 hours
app.post('/cron/send-reminders', async (req, res) => {
    const startTime = Date.now();
    
    try {
        log.info('🔔 Reminder cron started');
        
        let sent24h = 0;
        let sent2h = 0;
        let errors = 0;
        
        // 24-HOUR REMINDERS
        if (REMINDER_24H_ENABLED) {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const tomorrowDate = tomorrow.toISOString().split('T')[0];
            
            const reminder24h = await sql`
                SELECT 
                    a.id,
                    a.patient_name,
                    a.patient_phone,
                    a.appointment_date,
                    a.appointment_time,
                    c.name as clinic_name,
                    c.doctor_name,
                    d.name as assigned_doctor_name,
                    d.specialization as assigned_doctor_specialization
                FROM appointments a
                JOIN clinics c ON a.clinic_id = c.id
                LEFT JOIN doctors d ON a.doctor_id = d.id
                WHERE a.appointment_date = ${tomorrowDate}
                AND a.status = 'confirmed'
                AND a.reminder_24h_sent = false
                ORDER BY a.appointment_time
            `;
            
            log.info(`Found ${reminder24h.length} appointments for 24h reminders`);
            
            for (const apt of reminder24h) {
                try {
                    const doctorName = apt.assigned_doctor_name || apt.doctor_name;
                    const doctorSpec = apt.assigned_doctor_specialization || 'General';
                    
                    let message = `🔔 *REMINDER - TOMORROW*\n\n━━━━━━━━━━━━━━━━━━━━\n📋 #${apt.id}\n🏥 ${apt.clinic_name}\n`;
                    
                    if (doctorName) {
                        message += `👨‍⚕️ ${formatDoctorName(doctorName)}\n`;
                        message += `🩺 ${doctorSpec}\n`;
                    }
                    
                    message += `\n📅 *TOMORROW*\n⏰ ${apt.appointment_time}\n━━━━━━━━━━━━━━━━━━━━\n\n✔ Please arrive 10 min early\n✔ Bring any documents\n\nSee you tomorrow!\n\n━━━━━━━━━━━━━━━━━━━━\n✅ CONFIRM #${apt.id}\n❌ CANCEL #${apt.id}`;
                    
                    const success = await sendWhatsApp(apt.patient_phone, message);
                    
                    if (success) {
                        await sql`
                            UPDATE appointments 
                            SET reminder_24h_sent = true 
                            WHERE id = ${apt.id}
                        `;
                        
                        sent24h++;
                        log.success(`📅 24h reminder sent`, {
                            appointmentId: apt.id,
                            patient: apt.patient_name
                        });
                    }
                    
                } catch (error) {
                    errors++;
                    log.error(`Error sending 24h reminder for #${apt.id}`, error);
                }
            }
        }
        
        // 2-HOUR REMINDERS
        if (REMINDER_2H_ENABLED) {
            const now = new Date();
            const todayDate = now.toISOString().split('T')[0];
            const currentHour = now.getHours();
            
            const reminder2h = await sql`
                SELECT 
                    a.id,
                    a.patient_name,
                    a.patient_phone,
                    a.appointment_date,
                    a.appointment_time,
                    c.name as clinic_name,
                    c.doctor_name,
                    d.name as assigned_doctor_name
                FROM appointments a
                JOIN clinics c ON a.clinic_id = c.id
                LEFT JOIN doctors d ON a.doctor_id = d.id
                WHERE a.appointment_date = ${todayDate}
                AND a.status = 'confirmed'
                AND a.reminder_2h_sent = false
                ORDER BY a.appointment_time
            `;
            
            log.info(`Found ${reminder2h.length} potential appointments for 2h reminders`);
            
            for (const apt of reminder2h) {
                try {
                    const timeMatch = apt.appointment_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
                    if (!timeMatch) continue;
                    
                    let hour = parseInt(timeMatch[1]);
                    const period = timeMatch[3].toUpperCase();
                    
                    if (period === 'PM' && hour !== 12) {
                        hour += 12;
                    } else if (period === 'AM' && hour === 12) {
                        hour = 0;
                    }
                    
                    const hourDiff = hour - currentHour;
                    
                    if (hourDiff >= 2 && hourDiff <= 3) {
                        const doctorName = apt.assigned_doctor_name || apt.doctor_name;
                        
                        let message = `⏰ *REMINDER - IN 2 HOURS*\n\n━━━━━━━━━━━━━━━━━━━━\n📋 #${apt.id}\n🏥 ${apt.clinic_name}\n`;
                        
                        if (doctorName) {
                            message += `👨‍⚕️ ${formatDoctorName(doctorName)}\n`;
                        }
                        
                        message += `\n⏰ *TODAY at ${apt.appointment_time}*\n━━━━━━━━━━━━━━━━━━━━\n\n✔ Arrive 10 min early\n✔ Bring documents\n\nSee you soon!`;
                        
                        const success = await sendWhatsApp(apt.patient_phone, message);
                        
                        if (success) {
                            await sql`
                                UPDATE appointments 
                                SET reminder_2h_sent = true 
                                WHERE id = ${apt.id}
                            `;
                            
                            sent2h++;
                            log.success(`⏰ 2h reminder sent`, {
                                appointmentId: apt.id,
                                patient: apt.patient_name,
                                time: apt.appointment_time
                            });
                        }
                    }
                    
                } catch (error) {
                    errors++;
                    log.error(`Error sending 2h reminder for #${apt.id}`, error);
                }
            }
        }
        
        const duration = Date.now() - startTime;
        
        const summary = {
            success: true,
            reminder_24h_sent: sent24h,
            reminder_2h_sent: sent2h,
            errors: errors,
            durationMs: duration,
            timestamp: new Date().toISOString()
        };
        
        log.success('✅ Reminder cron completed', summary);
        
        res.json(summary);
        
    } catch (error) {
        const duration = Date.now() - startTime;
        log.error('❌ Reminder cron failed', {
            error: error.message,
            stack: error.stack
        });
        
        res.status(500).json({
            success: false,
            error: error.message,
            durationMs: duration
        });
    }
});

// Test endpoints
app.get('/cron/auto-approval/test', async (req, res) => {
    log.info('🧪 Auto-approval test endpoint accessed');
    
    try {
        const threshold = new Date(Date.now() - AUTO_APPROVAL_DELAY_MINUTES * 60 * 1000);
        
        const pending = await sql`
            SELECT COUNT(*) as count
            FROM appointments
            WHERE status = 'pending'
            AND created_at <= ${threshold.toISOString()}
            AND (auto_processed = false OR auto_processed IS NULL)
        `;
        
        res.json({
            message: 'Auto-approval cron endpoint ready ✅',
            config: {
                enabled: AUTO_APPROVAL_ENABLED,
                delayMinutes: AUTO_APPROVAL_DELAY_MINUTES,
                threshold: threshold.toISOString()
            },
            pendingToProcess: pending[0].count,
            endpoint: `POST ${process.env.BASE_URL}/cron/auto-approval`,
            setup: {
                step1: 'Go to cron-job.org',
                step2: `Add URL: POST ${process.env.BASE_URL}/cron/auto-approval`,
                step3: 'Schedule: Every 10 minutes',
                step4: 'Enable and save'
            }
        });
        
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

app.get('/cron/send-reminders/test', async (req, res) => {
    log.info('🧪 Reminder test endpoint accessed');
    
    try {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowDate = tomorrow.toISOString().split('T')[0];
        
        const today = new Date().toISOString().split('T')[0];
        
        const reminder24h = await sql`
            SELECT COUNT(*) as count
            FROM appointments
            WHERE appointment_date = ${tomorrowDate}
            AND status = 'confirmed'
            AND reminder_24h_sent = false
        `;
        
        const reminder2h = await sql`
            SELECT COUNT(*) as count
            FROM appointments
            WHERE appointment_date = ${today}
            AND status = 'confirmed'
            AND reminder_2h_sent = false
        `;
        
        res.json({
            message: 'Reminder cron endpoint ready ✅',
            config: {
                reminder_24h_enabled: REMINDER_24H_ENABLED,
                reminder_2h_enabled: REMINDER_2H_ENABLED
            },
            pending24hReminders: reminder24h[0].count,
            pending2hReminders: reminder2h[0].count,
            endpoint: `POST ${process.env.BASE_URL}/cron/send-reminders`,
            setup: {
                step1: 'Go to cron-job.org',
                step2: `Add URL: POST ${process.env.BASE_URL}/cron/send-reminders`,
                step3: 'Schedule: Every 2 hours',
                step4: 'Enable and save'
            }
        });
        
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// 25. ERROR HANDLERS
// ═══════════════════════════════════════════════════════════════════════
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

app.use((err, req, res, next) => { 
    log.error('Unhandled error', err); 
    res.status(500).json({ error: 'Internal Server Error' }); 
});

// ═══════════════════════════════════════════════════════════════════════
// 26. SERVER STARTUP - RAILWAY OPTIMIZED
// ═══════════════════════════════════════════════════════════════════════

// ✅ Start server IMMEDIATELY - before ANY async operations
const server = app.listen(PORT, HOST, async () => {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('🚀 WHATSAPP CLINIC BOT v8.2.0 - WITH QR CODE SUPPORT');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌐 Host: ${HOST}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('✅ SERVER LISTENING - All endpoints active');
    console.log(`✅ Health: http://localhost:${PORT}/health`);
    console.log(`✅ Webhook (PRIMARY): POST ${process.env.BASE_URL}/webhook`);
    console.log(`✅ Webhook (ALT): POST ${process.env.BASE_URL}/webhook/whatsapp`);
    console.log('═══════════════════════════════════════════════════════════\n');
    
    // ✅ Test database AFTER server is listening
    console.log('🔍 Testing database connection...');
    try {
        await sql`SELECT 1`;
        console.log('✅ Database: Connected');
        console.log(`💾 Database URL: ${process.env.DATABASE_URL?.substring(0, 30)}...`);
    } catch (dbError) {
        console.error('⚠️ Database: Connection failed');
        console.error(`❌ Error: ${dbError.message}`);
        console.error('⚠️ App will continue but database features unavailable');
    }
    
    // ✅ Verify Twilio credentials
    console.log('\n🔍 Verifying Twilio configuration...');
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        console.log('✅ Twilio: Configured');
        console.log(`📱 WABA Number: ${process.env.WABA_NUMBER || 'NOT SET'}`);
    } else {
        console.error('⚠️ Twilio: Missing credentials');
    }

    console.log('\n🔔 CRON SETUP REQUIRED:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n1️⃣ AUTO-APPROVAL CRON:');
    console.log('   • Visit: https://cron-job.org');
    console.log(`   • URL: POST ${process.env.BASE_URL}/cron/auto-approval`);
    console.log('   • Schedule: */10 * * * * (Every 10 minutes)');
    console.log(`   • Status: ${AUTO_APPROVAL_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    console.log('\n2️⃣ REMINDER CRON:');
    console.log('   • Visit: https://cron-job.org');
    console.log(`   • URL: POST ${process.env.BASE_URL}/cron/send-reminders`);
    console.log('   • Schedule: 0 */2 * * * (Every 2 hours)');
    console.log(`   • 24h Reminders: ${REMINDER_24H_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    console.log(`   • 2h Reminders: ${REMINDER_2H_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    console.log('\n✅ TWILIO WEBHOOK CONFIGURATION:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('1. Go to: https://console.twilio.com/');
    console.log('2. Navigate: Messaging → Try it out → Send a WhatsApp message');
    console.log('3. Click your number: +917980407413');
    console.log(`4. Set "When a message comes in": ${process.env.BASE_URL}/webhook`);
    console.log('5. Method: HTTP POST');
    console.log('6. Click: Save');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    console.log('\n🎯 QR CODE FEATURE:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ QR code clinic routing enabled');
    console.log('📋 Next steps:');
    console.log('   1. Run SQL to add clinic codes (see documentation)');
    console.log('   2. Generate QR codes for each clinic');
    console.log('   3. Test by sending clinic code (e.g., "ZAMZAM")');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    console.log('\n✅ ALL SYSTEMS OPERATIONAL\n');
});

// ✅ Handle server errors
server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`❌ FATAL: Port ${PORT} is already in use`);
        process.exit(1);
    } else if (error.code === 'EACCES') {
        console.error(`❌ FATAL: Permission denied to bind to port ${PORT}`);
        process.exit(1);
    } else {
        console.error('❌ FATAL: Server error:', error);
        process.exit(1);
    }
});

// ✅ Graceful shutdown handler
const gracefulShutdown = (signal) => {
    console.log(`\n⚠️ ${signal} received, shutting down gracefully...`);
    
    server.close(() => {
        console.log('✅ HTTP server closed');
        console.log('✅ Exiting process');
        process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
        console.error('❌ Forced shutdown - timeout exceeded');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => { 
    log.error('UNCAUGHT EXCEPTION - FATAL', error);
    console.error('\n❌ UNCAUGHT EXCEPTION:');
    console.error(error);
    process.exit(1); 
});

process.on('unhandledRejection', (reason, promise) => { 
    log.error('UNHANDLED REJECTION', { reason });
    console.error('\n⚠️ UNHANDLED PROMISE REJECTION:');
    console.error('Reason:', reason);
    console.error('Promise:', promise);
});

// ✅ Startup complete message
console.log('🔄 Server initialization in progress...');
console.log(`⏳ Waiting for port ${PORT} to bind...\n`);

module.exports = app;

// ═══════════════════════════════════════════════════════════════════════
// END OF FILE - WhatsApp Clinic Bot v8.2.0 - QR Code Support
// Total Lines: ~2855
// ═══════════════════════════════════════════════════════════════════════
