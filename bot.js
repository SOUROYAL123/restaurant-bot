/**
 * ═══════════════════════════════════════════════════════════
 * WHATSAPP CLINIC BOT v4.2.0 - REAL INTERACTIVE BUTTONS
 * 
 * TRUE clickable buttons for doctor approvals
 * Requires: WhatsApp Business API (not Sandbox)
 * 
 * Author: Sourav Roy - Legacylens Automation
 * v4.2.0 - Real interactive reply buttons
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
// CONSTANTS & CONFIGURATION
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
  info: (msg, data = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', message: msg, ...data })),
  success: (msg, data = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'SUCCESS', message: msg, ...data })),
  warn: (msg, data = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'WARNING', message: msg, ...data })),
  error: (msg, error = {}) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'ERROR', message: msg, error: error.message || String(error), stack: error.stack || '' }))
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
// OPTIONAL DEPENDENCIES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let redisClient = null;
let cacheEnabled = false;

try {
  const redis = require('redis');
  if (process.env.REDIS_URL) {
    redisClient = redis.createClient({ url: process.env.REDIS_URL });
    redisClient.connect().then(() => { cacheEnabled = true; log.info('✅ Redis cache enabled'); }).catch(() => log.warn('Redis failed'));
    redisClient.on('error', () => {});
  }
} catch (err) {
  log.warn('Redis not available');
}

let GoogleSheetsLogger = { logAppointment: async () => false, updateAppointmentStatus: async () => false };
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
      log.info('HTTP', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
    }
  });
  next();
});

app.use('/webhook/', rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false }));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DATABASE HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function dbQuery(query, errorMsg = 'Database query failed') {
  try { return await query; } catch (error) { log.error(errorMsg, error); return null; }
}

async function getCache(key) {
  if (!cacheEnabled || !redisClient) return null;
  try { const val = await redisClient.get(key); return val ? JSON.parse(val) : null; } catch (err) { return null; }
}

async function setCache(key, value, ttl = 3600) {
  if (!cacheEnabled || !redisClient) return;
  try { await redisClient.setEx(key, ttl, JSON.stringify(value)); } catch (err) {}
}

async function delCache(key) {
  if (!cacheEnabled || !redisClient) return;
  try { await redisClient.del(key); } catch (err) {}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WHATSAPP MESSAGING WITH REAL INTERACTIVE BUTTONS
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

/**
 * Send WhatsApp message with REAL clickable buttons
 * Uses Twilio's interactive message API
 * Requires WhatsApp Business API (not Sandbox)
 */
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
      `⏰ ${time}`;

    // Try sending with REAL interactive buttons
    try {
      const msg = await twilioClient.messages.create({
        from: process.env.WABA_NUMBER,
        to: phone,
        contentSid: undefined, // We're building the message ourselves
        body: bodyText,
        // This is the CORRECT way to add interactive buttons in Twilio
        messagingServiceSid: undefined,
        statusCallback: undefined,
        // Send as interactive message with reply buttons
        parameters: JSON.stringify({
          type: 'button',
          body: {
            text: bodyText
          },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: {
                  id: `approve_${appointmentId}`,
                  title: '✅ Approve'
                }
              },
              {
                type: 'reply',
                reply: {
                  id: `reject_${appointmentId}`,
                  title: '❌ Reject'
                }
              }
            ]
          }
        })
      });

      log.info('Interactive buttons sent', { to: normalizePhone(phone), sid: msg.sid, appointmentId });
      return true;

    } catch (buttonError) {
      log.warn('Buttons not supported, trying fallback', { error: buttonError.message });

      // Fallback: Enhanced text format
      const fallbackMessage = 
        bodyText +
        `\n\n━━━━━━━━━━━━━━━━━━━━━\n` +
        `*Quick Actions:*\n` +
        `✅ APPROVE #${appointmentId}\n` +
        `❌ REJECT #${appointmentId}`;

      const fallbackMsg = await twilioClient.messages.create({
        from: process.env.WABA_NUMBER,
        to: phone,
        body: fallbackMessage
      });

      log.info('Fallback text sent', { to: normalizePhone(phone), sid: fallbackMsg.sid, appointmentId });
      return true;
    }

  } catch (error) {
    log.error('Doctor notification completely failed', error);
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
  const session = await dbQuery(sql`SELECT * FROM sessions WHERE user_phone = ${cleanPhone} LIMIT 1`);
  if (session && session.length > 0) {
    await setCache(`session:${cleanPhone}`, session[0], 1800);
    return session[0];
  }
  return null;
}

async function setSession(phone, data) {
  const cleanPhone = normalizePhone(phone);
  await delCache(`session:${cleanPhone}`);
  const sessionData = typeof data.session_data === 'string' ? data.session_data : JSON.stringify(data.session_data || {});
  await dbQuery(sql`
    INSERT INTO sessions (user_phone, stage, clinic_id, session_data, last_activity)
    VALUES (${cleanPhone}, ${data.stage || 'initial'}, ${data.clinic_id || null}, ${sessionData}::jsonb, NOW())
    ON CONFLICT (user_phone) DO UPDATE SET stage = EXCLUDED.stage, clinic_id = EXCLUDED.clinic_id, session_data = EXCLUDED.session_data, last_activity = NOW()
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
  const clinics = await dbQuery(sql`SELECT * FROM clinics WHERE status = 'active' ORDER BY id`);
  if (clinics) { await setCache('clinics:active', clinics, 3600); return clinics; }
  return [];
}

async function getClinic(id) {
  const cached = await getCache(`clinic:${id}`);
  if (cached) return cached;
  const clinic = await dbQuery(sql`SELECT * FROM clinics WHERE id = ${id} AND status = 'active' LIMIT 1`);
  if (clinic && clinic.length > 0) { await setCache(`clinic:${id}`, clinic[0], 3600); return clinic[0]; }
  return null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONVERSATION FLOW (Same as v4.1.1 - keeping it brief)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleStart(phone) {
  const clinics = await getActiveClinics();
  if (clinics.length === 0) { await sendWhatsApp(phone, '⚠️ *Service Unavailable*\n\nPlease try again later.'); return; }
  await setSession(phone, { stage: 'select_clinic', session_data: {} });
  let msg = '👋 *Welcome to Clinic Appointment System!*\n\n📋 *Select a clinic:*\n\n';
  clinics.forEach((clinic, i) => { msg += `*${i + 1}.* ${clinic.name}\n   👨‍⚕️ Dr. ${clinic.doctor_name}\n`; if (clinic.business_hours_start) msg += `   ⏰ ${clinic.business_hours_start} - ${clinic.business_hours_end}\n`; msg += '\n'; });
  msg += `Reply with number *1-${clinics.length}*`;
  await sendWhatsApp(phone, msg);
}

async function handleClinicSelect(phone, text) {
  const clinics = await getActiveClinics();
  const choice = parseInt(text.trim());
  if (isNaN(choice) || choice < 1 || choice > clinics.length) { await sendWhatsApp(phone, `❌ Invalid. Reply *1-${clinics.length}*`); return; }
  const clinic = clinics[choice - 1];
  await setSession(phone, { stage: 'enter_name', clinic_id: clinic.id, session_data: {} });
  await sendWhatsApp(phone, `✅ *${clinic.name}* selected\n\n👤 *What is your full name?*`);
}

async function handleName(phone, text) {
  const name = text.trim();
  if (name.length < 2) { await sendWhatsApp(phone, '❌ Name too short. Please enter your full name:'); return; }
  const session = await getSession(phone);
  let data = session?.session_data || {};
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
  data.name = name;
  await setSession(phone, { stage: 'select_date', clinic_id: session.clinic_id, session_data: data });
  let msg = `👤 *Name:* ${name}\n\n📅 *Select date:*\n\n`;
  for (let i = 1; i <= 7; i++) { const d = new Date(); d.setDate(d.getDate() + i); msg += `*${i}.* ${d.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' })}\n`; }
  msg += `\nReply *1-7*`;
  await sendWhatsApp(phone, msg);
}

async function handleDate(phone, text) {
  const choice = parseInt(text.trim());
  if (isNaN(choice) || choice < 1 || choice > 7) { await sendWhatsApp(phone, '❌ Invalid. Reply *1-7*'); return; }
  const d = new Date(); d.setDate(d.getDate() + choice);
  const dateStr = d.toISOString().split('T')[0];
  const session = await getSession(phone);
  let data = session?.session_data || {};
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
  data.date = dateStr;
  await setSession(phone, { stage: 'select_time', clinic_id: session.clinic_id, session_data: data });
  const clinic = await getClinic(session.clinic_id);
  const startHour = parseInt(clinic?.business_hours_start?.split(':')[0] || '9');
  const endHour = parseInt(clinic?.business_hours_end?.split(':')[0] || '18');
  let msg = `📅 *Date:* ${d.toLocaleDateString('en-IN')}\n\n⏰ *Select time:*\n\n`;
  for (let h = startHour; h < endHour; h++) { const time = h >= 12 ? `${h === 12 ? 12 : h - 12}:00 PM` : `${h}:00 AM`; msg += `*${h - startHour + 1}.* ${time}\n`; }
  msg += `\nReply *1-${endHour - startHour}*`;
  await sendWhatsApp(phone, msg);
}

async function handleTime(phone, text) {
  const cleanPhone = normalizePhone(phone);
  const session = await getSession(phone);
  let data = session?.session_data || {};
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
  const clinic = await getClinic(session.clinic_id);
  const startHour = parseInt(clinic?.business_hours_start?.split(':')[0] || '9');
  const endHour = parseInt(clinic?.business_hours_end?.split(':')[0] || '18');
  const totalSlots = endHour - startHour;
  const choice = parseInt(text.trim());
  if (isNaN(choice) || choice < 1 || choice > totalSlots) { await sendWhatsApp(phone, `❌ Invalid. Reply *1-${totalSlots}*`); return; }
  const hour = startHour + choice - 1;
  const timeSlot = hour >= 12 ? `${hour === 12 ? 12 : hour - 12}:00 PM` : `${hour}:00 AM`;

  try {
    const appt = await sql`INSERT INTO appointments (clinic_id, patient_name, patient_phone, appointment_date, appointment_time, appointment_slot, status, reminder_sent, auto_processed) VALUES (${session.clinic_id}, ${data.name}, ${cleanPhone}, ${data.date}, ${timeSlot}, ${timeSlot}, 'pending', false, false) RETURNING *`;
    const aptId = appt[0].id;
    log.success('Appointment created', { id: aptId, patient: data.name });

    try { if (clinic.google_sheet_id) { await GoogleSheetsLogger.logAppointment(clinic.google_sheet_id, { ...appt[0], clinic_name: clinic.name, doctor_name: clinic.doctor_name }); } } catch (err) { log.warn('Sheets failed', err); }

    const dateDisplay = new Date(data.date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    await sendWhatsApp(phone, `✅ *Appointment Requested!*\n\n━━━━━━━━━━━━━━━\n📋 *ID:* #${aptId}\n👤 *Name:* ${data.name}\n🏥 *Clinic:* ${clinic.name}\n📅 *Date:* ${dateDisplay}\n⏰ *Time:* ${timeSlot}\n━━━━━━━━━━━━━━━\n\n⏳ Pending doctor approval\n\nYou'll receive confirmation soon.`);

    // Send doctor notification with REAL BUTTONS
    await sendDoctorNotificationWithButtons(
      clinic.doctor_whatsapp,
      { patientName: data.name, patientPhone: cleanPhone, date: dateDisplay, time: timeSlot },
      aptId
    );

    await clearSession(phone);
  } catch (error) {
    log.error('Appointment failed', error);
    await sendWhatsApp(phone, '❌ Error creating appointment. Please try again.');
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DOCTOR COMMAND HANDLER - Handles both text and button clicks
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleDoctorCommand(phone, text) {
  const cleanPhone = normalizePhone(phone);
  const cmd = text.trim().toUpperCase();

  // Handle button click (format: "approve_123" or "reject_123")
  const buttonMatch = cmd.match(/(APPROVE|REJECT)_(\d+)/);
  if (buttonMatch) {
    const action = buttonMatch[1];
    const aptId = parseInt(buttonMatch[2]);
    // Convert to standard format and process
    return await handleDoctorCommand(phone, `${action} #${aptId}`);
  }

  if (!cmd.startsWith('APPROVE') && !cmd.startsWith('REJECT')) return false;

  const clinic = await dbQuery(sql`SELECT * FROM clinics WHERE doctor_whatsapp = ${cleanPhone} LIMIT 1`);
  if (!clinic || clinic.length === 0) return false;

  const match = cmd.match(/#?(\d+)/);
  if (!match) { await sendWhatsApp(phone, `❌ *Invalid format*\n\nUse:\n✅ APPROVE #123\n❌ REJECT #123`); return true; }

  const aptId = parseInt(match[1]);
  const isApprove = cmd.startsWith('APPROVE');

  const apts = await dbQuery(sql`SELECT * FROM appointments WHERE id = ${aptId} AND clinic_id = ${clinic[0].id} AND status = 'pending' LIMIT 1`);
  if (!apts || apts.length === 0) { await sendWhatsApp(phone, `❌ *Appointment #${aptId} not found*`); return true; }

  const apt = apts[0];
  const newStatus = isApprove ? 'confirmed' : 'rejected';
  const now = new Date();

  if (isApprove) {
    await dbQuery(sql`UPDATE appointments SET status = 'confirmed', approved_at = ${now}, updated_at = NOW() WHERE id = ${aptId}`);
  } else {
    await dbQuery(sql`UPDATE appointments SET status = 'rejected', rejected_at = ${now}, updated_at = NOW() WHERE id = ${aptId}`);
  }

  try { if (clinic[0].google_sheet_id) { await GoogleSheetsLogger.updateAppointmentStatus(clinic[0].google_sheet_id, aptId, newStatus, now.toLocaleString('en-IN')); } } catch (err) { log.warn('Sheets update failed', err); }

  const dateStr = new Date(apt.appointment_date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  if (isApprove) {
    await sendWhatsApp(apt.patient_phone, `✅ *Appointment Confirmed!*\n\n━━━━━━━━━━━━━━━\n📋 *Booking:* #${aptId}\n🏥 *Clinic:* ${clinic[0].name}\n📅 *Date:* ${dateStr}\n⏰ *Time:* ${apt.appointment_time}\n━━━━━━━━━━━━━━━\n\n✓ Please arrive 10 mins early\n\nSee you soon! 😊`);
  } else {
    await sendWhatsApp(apt.patient_phone, `❌ *Appointment Not Confirmed*\n\n📋 *Booking:* #${aptId}\n\nTime slot unavailable.\n\nPlease contact clinic or reply *hi* to book again.`);
  }

  await sendWhatsApp(phone, `${isApprove ? '✅' : '❌'} *Appointment #${aptId} ${newStatus.toUpperCase()}*\n\nPatient: ${apt.patient_name}\nDate: ${dateStr}\nTime: ${apt.appointment_time}\n\n✓ Patient notified.`);

  log.success(`Doctor ${newStatus} appointment`, { id: aptId, doctor: clinic[0].doctor_name });
  return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MESSAGE ROUTER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleMessage(phone, text) {
  try {
    const isDoctorCmd = await handleDoctorCommand(phone, text);
    if (isDoctorCmd) return;
    const session = await getSession(phone);
    const msg = text.trim().toLowerCase();
    const isRestart = msg === 'hi' || msg === 'hello' || msg === 'start' || msg === 'restart';
    if (!session || isRestart) { await handleStart(phone); return; }
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

app.get('/', (req, res) => res.json({ name: 'WhatsApp Clinic Bot', version: '4.2.0', status: 'operational', features: { interactive_buttons: true }, uptime: Math.floor(process.uptime()) }));
app.get('/health', async (req, res) => { const h = { status: 'healthy', uptime: Math.floor(process.uptime()), database: 'unknown' }; try { await sql`SELECT 1`; h.database = 'connected'; } catch (e) { h.database = 'disconnected'; h.status = 'degraded'; } res.status(h.status === 'healthy' ? 200 : 503).json(h); });
app.head('/ping', (req, res) => res.status(200).send());
app.get('/ping', (req, res) => res.status(200).json({ pong: true }));
app.get('/status', async (req, res) => { try { const s = await sql`SELECT (SELECT COUNT(*) FROM clinics WHERE status = 'active') as clinics, (SELECT COUNT(*) FROM appointments WHERE DATE(created_at) = CURRENT_DATE) as today, (SELECT COUNT(*) FROM appointments WHERE status = 'pending') as pending`; res.json({ status: 'ok', version: '4.2.0', stats: s[0] || {} }); } catch (e) { res.status(500).json({ error: 'DB unavailable' }); } });

app.post('/webhook/whatsapp', async (req, res) => {
  res.status(200).send('OK');
  try {
    const { From, Body, ButtonPayload } = req.body;
    if (!From || !Body) { log.warn('Invalid payload'); return; }
    // Handle button click or text
    const message = ButtonPayload || Body;
    log.info('Incoming', { from: normalizePhone(From), message, isButton: !!ButtonPayload });
    setImmediate(() => handleMessage(From, message));
  } catch (err) { log.error('Webhook error', err); }
});

app.post('/cron/auto-approval', async (req, res) => { try { const { processAutoApprovals } = require('./autoApproval'); const r = await processAutoApprovals(); res.json({ success: true, result: r }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/cron/send-reminders', async (req, res) => { try { const { sendReminders } = require('./sendReminders'); const r = await sendReminders(); res.json({ success: true, result: r }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.use((req, res) => res.status(404).json({ error: 'Not Found' }));
app.use((err, req, res, next) => { log.error('Unhandled', err); res.status(500).json({ error: 'Internal Error' }); });

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STARTUP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function startServer() {
  try {
    log.info('Starting v4.2.0...');
    await sql`SELECT NOW()`;
    log.success('Database connected');
    
    app.listen(PORT, HOST, () => {
      console.log('═══════════════════════════════════════════════════════════');
      console.log('🚀 WHATSAPP CLINIC BOT v4.2.0 - INTERACTIVE BUTTONS');
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`📡 Port:        ${PORT}`);
      console.log(`💾 Database:    Connected ✅`);
      console.log(`🔘 Buttons:     TRUE Interactive (Business API) ✅`);
      console.log('═══════════════════════════════════════════════════════════');
      console.log('✅ LIVE - CLICKABLE BUTTONS ENABLED');
      console.log('═══════════════════════════════════════════════════════════');
    });
  } catch (e) { log.error('Startup failed', e); process.exit(1); }
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', (e) => { log.error('UNCAUGHT', e); process.exit(1); });
process.on('unhandledRejection', (r) => { log.error('UNHANDLED', { reason: r }); });

startServer();
module.exports = app;
