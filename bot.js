/**
 * ═══════════════════════════════════════════════════════════
 * WHATSAPP CLINIC BOT v4.0.0 - PRODUCTION EDITION
 * 
 * Multi-clinic appointment booking system with auto-approval
 * 
 * Features:
 * - Multi-clinic support
 * - Auto-approval workflow
 * - Doctor command handling (APPROVE/REJECT)
 * - 24-hour reminders
 * - Google Sheets logging (optional)
 * - Redis caching (optional)
 * - Session management
 * - Comprehensive error handling
 * 
 * Author: Sourav Roy - Legacylens Automation
 * ═══════════════════════════════════════════════════════════
 */

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
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';

// Database
const sql = neon(process.env.DATABASE_URL);

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LOGGER SETUP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const logger = {
  info: (msg, data = {}) => {
    const timestamp = new Date().toISOString();
    console.log(JSON.stringify({ timestamp, level: 'INFO', message: msg, ...data }));
  },
  success: (msg, data = {}) => {
    const timestamp = new Date().toISOString();
    console.log(JSON.stringify({ timestamp, level: 'SUCCESS', message: msg, ...data }));
  },
  warning: (msg, data = {}) => {
    const timestamp = new Date().toISOString();
    console.log(JSON.stringify({ timestamp, level: 'WARNING', message: msg, ...data }));
  },
  error: (msg, error = {}) => {
    const timestamp = new Date().toISOString();
    console.error(JSON.stringify({ 
      timestamp, 
      level: 'ERROR', 
      message: msg, 
      error: error.message || error,
      stack: error.stack 
    }));
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REDIS CACHE SETUP (OPTIONAL)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let redisClient = null;
let cacheEnabled = false;
let createClient = null;

// Try to load Redis (optional)
try {
  const redis = require('redis');
  createClient = redis.createClient;
} catch (err) {
  logger.warning('Redis module not available - caching disabled');
}

async function initializeCache() {
  if (!createClient || !process.env.REDIS_URL) {
    logger.warning('Redis not configured - caching disabled');
    return;
  }

  try {
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (err) => logger.error('Redis error', err));
    redisClient.on('connect', () => {
      logger.info('Redis connected');
      cacheEnabled = true;
    });
    await redisClient.connect();
  } catch (error) {
    logger.error('Redis initialization failed', error);
    cacheEnabled = false;
  }
}

async function getCache(key) {
  if (!cacheEnabled || !redisClient) return null;
  try {
    const value = await redisClient.get(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    logger.error('Cache get error', error);
    return null;
  }
}

async function setCache(key, value, expirySeconds = 3600) {
  if (!cacheEnabled || !redisClient) return;
  try {
    await redisClient.setEx(key, expirySeconds, JSON.stringify(value));
  } catch (error) {
    logger.error('Cache set error', error);
  }
}

async function deleteCache(key) {
  if (!cacheEnabled || !redisClient) return;
  try {
    await redisClient.del(key);
  } catch (error) {
    logger.error('Cache delete error', error);
  }
}

// Initialize cache (async, non-blocking)
initializeCache().catch(err => logger.error('Cache init failed', err));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GOOGLE SHEETS SETUP (OPTIONAL)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let GoogleSheetsLogger = null;

try {
  GoogleSheetsLogger = require('./utils/googleSheetsLogger');
  logger.info('Google Sheets logger loaded');
} catch (err) {
  logger.warning('Google Sheets not available - logging to DB only');
  GoogleSheetsLogger = {
    logAppointment: async () => false,
    updateAppointmentStatus: async () => false
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MIDDLEWARE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(compression());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('HTTP Request', {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${Date.now() - start}ms`,
    });
  });
  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests',
});
app.use('/webhook/', limiter);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UTILITY FUNCTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function sendWhatsAppMessage(to, message) {
  try {
    // Ensure proper WhatsApp format
    let toNumber = to;
    if (!toNumber.startsWith('whatsapp:')) {
      toNumber = `whatsapp:${toNumber.replace(/[^0-9+]/g, '')}`;
    }

    const result = await twilioClient.messages.create({
      from: process.env.WABA_NUMBER,
      to: toNumber,
      body: message,
    });
    
    logger.info('WhatsApp sent', { to: toNumber, sid: result.sid });
    return { success: true, sid: result.sid };
  } catch (error) {
    logger.error('WhatsApp failed', error);
    return { success: false, error: error.message };
  }
}

async function getSession(phoneNumber) {
  const cacheKey = `session:${phoneNumber}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  try {
    const session = await sql`
      SELECT * FROM sessions 
      WHERE user_phone = ${phoneNumber}
      ORDER BY last_activity DESC 
      LIMIT 1
    `;

    if (session.length > 0) {
      await setCache(cacheKey, session[0], 300);
      return session[0];
    }
    return null;
  } catch (error) {
    logger.error('Get session error', error);
    return null;
  }
}

async function updateSession(phoneNumber, updates) {
  try {
    // Build update query dynamically
    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (updates.stage !== undefined) {
      fields.push(`stage = $${paramIndex++}`);
      values.push(updates.stage);
    }
    if (updates.clinic_id !== undefined) {
      fields.push(`clinic_id = $${paramIndex++}`);
      values.push(updates.clinic_id);
    }
    if (updates.session_data !== undefined) {
      fields.push(`session_data = $${paramIndex++}`);
      values.push(JSON.stringify(updates.session_data));
    }
    if (updates.language !== undefined) {
      fields.push(`language = $${paramIndex++}`);
      values.push(updates.language);
    }

    fields.push(`last_activity = NOW()`);
    values.push(phoneNumber);

    const query = `
      UPDATE sessions 
      SET ${fields.join(', ')}
      WHERE user_phone = $${paramIndex}
      RETURNING *
    `;

    const result = await sql.unsafe(query, values);
    await deleteCache(`session:${phoneNumber}`);
    
    return result[0];
  } catch (error) {
    logger.error('Update session error', error);
    return null;
  }
}

async function ensureSession(phoneNumber) {
  try {
    await sql`
      INSERT INTO sessions (user_phone, stage, last_activity)
      VALUES (${phoneNumber}, 'initial', NOW())
      ON CONFLICT (user_phone) 
      DO UPDATE SET last_activity = NOW()
    `;
  } catch (error) {
    logger.error('Ensure session error', error);
  }
}

async function getActiveClinics() {
  const cacheKey = 'clinics:active';
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  try {
    const clinics = await sql`
      SELECT * FROM clinics 
      WHERE status = 'active' 
      ORDER BY id
    `;

    await setCache(cacheKey, clinics, 3600);
    return clinics;
  } catch (error) {
    logger.error('Get clinics error', error);
    return [];
  }
}

async function getClinicById(clinicId) {
  const cacheKey = `clinic:${clinicId}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  try {
    const clinic = await sql`
      SELECT * FROM clinics 
      WHERE id = ${clinicId} 
      AND status = 'active'
    `;

    if (clinic.length > 0) {
      await setCache(cacheKey, clinic[0], 3600);
      return clinic[0];
    }
    return null;
  } catch (error) {
    logger.error('Get clinic error', error);
    return null;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONVERSATION HANDLERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleGreeting(phoneNumber) {
  logger.info('Greeting', { phoneNumber });

  const clinics = await getActiveClinics();

  if (clinics.length === 0) {
    await sendWhatsAppMessage(phoneNumber, '⚠️ No clinics available. Try again later.');
    return;
  }

  await ensureSession(phoneNumber);
  await updateSession(phoneNumber, { 
    stage: 'select_clinic',
    session_data: {}
  });

  let message = '👋 *Welcome to Clinic Appointment System!*\n\n';
  message += '📋 Select a clinic:\n\n';

  clinics.forEach((clinic, index) => {
    message += `${index + 1}. *${clinic.name}*\n`;
    message += `   👨‍⚕️ Dr. ${clinic.doctor_name}\n`;
    if (clinic.business_hours_start && clinic.business_hours_end) {
      message += `   ⏰ ${clinic.business_hours_start} - ${clinic.business_hours_end}\n`;
    }
    message += `\n`;
  });

  message += `Reply with number (1-${clinics.length})`;

  await sendWhatsAppMessage(phoneNumber, message);
}

async function handleClinicSelection(phoneNumber, message) {
  const clinics = await getActiveClinics();
  const selection = parseInt(message.trim());

  if (isNaN(selection) || selection < 1 || selection > clinics.length) {
    await sendWhatsAppMessage(phoneNumber, `❌ Invalid. Reply 1-${clinics.length}`);
    return;
  }

  const clinic = clinics[selection - 1];
  await updateSession(phoneNumber, {
    stage: 'enter_name',
    clinic_id: clinic.id,
  });

  await sendWhatsAppMessage(
    phoneNumber,
    `✅ Selected: *${clinic.name}*\n\n👤 What is your full name?`
  );
}

async function handleNameEntry(phoneNumber, message) {
  const name = message.trim();

  if (name.length < 2) {
    await sendWhatsAppMessage(phoneNumber, '❌ Name too short (min 2 chars)');
    return;
  }

  const session = await getSession(phoneNumber);
  const sessionData = session?.session_data || {};
  sessionData.name = name;

  await updateSession(phoneNumber, {
    stage: 'select_date',
    session_data: sessionData,
  });

  const dates = [];
  for (let i = 1; i <= 7; i++) {
    const date = new Date();
    date.setDate(date.getDate() + i);
    dates.push(date.toISOString().split('T')[0]);
  }

  let msg = `👤 Name: *${name}*\n\n📅 Select date:\n\n`;
  dates.forEach((date, i) => {
    const d = new Date(date);
    msg += `${i + 1}. ${d.toLocaleDateString('en-IN', { 
      weekday: 'short', 
      month: 'short', 
      day: 'numeric' 
    })}\n`;
  });

  await sendWhatsAppMessage(phoneNumber, msg);
}

async function handleDateSelection(phoneNumber, message) {
  const selection = parseInt(message.trim());

  if (isNaN(selection) || selection < 1 || selection > 7) {
    await sendWhatsAppMessage(phoneNumber, '❌ Invalid. Reply 1-7');
    return;
  }

  const date = new Date();
  date.setDate(date.getDate() + selection);
  const appointmentDate = date.toISOString().split('T')[0];

  const session = await getSession(phoneNumber);
  const sessionData = session?.session_data || {};
  sessionData.date = appointmentDate;

  const clinic = await getClinicById(session.clinic_id);

  await updateSession(phoneNumber, {
    stage: 'select_time',
    session_data: sessionData,
  });

  const startHour = parseInt(clinic.business_hours_start?.split(':')[0] || '9');
  const endHour = parseInt(clinic.business_hours_end?.split(':')[0] || '18');

  let msg = `📅 ${date.toLocaleDateString('en-IN')}\n\n⏰ Select time:\n\n`;
  for (let hour = startHour; hour < endHour; hour++) {
    const time = hour >= 12 
      ? `${hour === 12 ? 12 : hour - 12}:00 PM` 
      : `${hour}:00 AM`;
    msg += `${hour - startHour + 1}. ${time}\n`;
  }

  await sendWhatsAppMessage(phoneNumber, msg);
}

async function handleTimeSelection(phoneNumber, message) {
  const session = await getSession(phoneNumber);
  const sessionData = session?.session_data || {};
  const clinic = await getClinicById(session.clinic_id);

  const selection = parseInt(message.trim());
  const startHour = parseInt(clinic.business_hours_start?.split(':')[0] || '9');
  const endHour = parseInt(clinic.business_hours_end?.split(':')[0] || '18');
  const totalSlots = endHour - startHour;

  if (isNaN(selection) || selection < 1 || selection > totalSlots) {
    await sendWhatsAppMessage(phoneNumber, `❌ Invalid. Reply 1-${totalSlots}`);
    return;
  }

  const hour = startHour + selection - 1;
  const time = hour >= 12 
    ? `${hour === 12 ? 12 : hour - 12}:00 PM` 
    : `${hour}:00 AM`;

  try {
    const appt = await sql`
      INSERT INTO appointments (
        clinic_id, patient_name, patient_phone,
        appointment_date, appointment_time, appointment_slot,
        status, reminder_sent, auto_processed
      ) VALUES (
        ${session.clinic_id}, ${sessionData.name}, ${phoneNumber},
        ${sessionData.date}, ${time}, ${time},
        'pending', false, false
      ) RETURNING *
    `;

    logger.info('Appointment created', { id: appt[0].id });

    // Log to Google Sheets (optional)
    if (clinic.google_sheet_id) {
      await GoogleSheetsLogger.logAppointment(clinic.google_sheet_id, {
        ...appt[0],
        clinic_name: clinic.name,
        doctor_name: clinic.doctor_name,
      }).catch(err => logger.warning('Sheets log failed', err));
    }

    // Patient confirmation
    await sendWhatsAppMessage(
      phoneNumber,
      `✅ *Appointment Requested!*\n\n` +
        `📋 Booking ID: #${appt[0].id}\n` +
        `👤 ${sessionData.name}\n` +
        `🏥 ${clinic.name}\n` +
        `📅 ${new Date(sessionData.date).toLocaleDateString('en-IN')}\n` +
        `⏰ ${time}\n\n` +
        `⏳ Pending doctor approval\n` +
        `You'll be notified once confirmed.`
    );

    // Doctor notification
    const autoInfo = clinic.auto_approve 
      ? `\n⚠️ Will auto-approve in ${clinic.auto_approve_after_hours}h if no response`
      : '';
      
    await sendWhatsAppMessage(
      clinic.doctor_whatsapp,
      `🔔 *New Appointment Request*\n\n` +
        `📋 ID: #${appt[0].id}\n` +
        `👤 Patient: ${sessionData.name}\n` +
        `📞 Phone: ${phoneNumber}\n` +
        `📅 Date: ${new Date(sessionData.date).toLocaleDateString('en-IN')}\n` +
        `🕒 Time: ${time}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `To approve: *APPROVE #${appt[0].id}*\n` +
        `To reject: *REJECT #${appt[0].id}*${autoInfo}`
    );

    // Cleanup session
    await sql`DELETE FROM sessions WHERE user_phone = ${phoneNumber}`;
    await deleteCache(`session:${phoneNumber}`);
    
  } catch (error) {
    logger.error('Appointment creation failed', error);
    await sendWhatsAppMessage(phoneNumber, '❌ Error creating appointment. Try again.');
  }
}

async function handleDoctorResponse(phoneNumber, message) {
  const normalized = message.trim().toUpperCase();

  // Check if it's a doctor command
  if (!normalized.startsWith('APPROVE') && !normalized.startsWith('REJECT')) {
    return false;
  }

  try {
    const clinic = await sql`
      SELECT * FROM clinics 
      WHERE doctor_whatsapp = ${phoneNumber} 
      LIMIT 1
    `;

    if (clinic.length === 0) return false;

    // Extract appointment ID
    const match = normalized.match(/#?(\d+)/);
    if (!match) {
      await sendWhatsAppMessage(phoneNumber, '❌ Use: APPROVE #<id> or REJECT #<id>');
      return true;
    }

    const appointmentId = parseInt(match[1]);
    const isApprove = normalized.startsWith('APPROVE');
    const newStatus = isApprove ? 'confirmed' : 'rejected';
    const timestamp = new Date();

    const appts = await sql`
      SELECT * FROM appointments 
      WHERE id = ${appointmentId}
      AND clinic_id = ${clinic[0].id}
      AND status = 'pending'
    `;

    if (appts.length === 0) {
      await sendWhatsAppMessage(phoneNumber, `❌ Appointment #${appointmentId} not found or already processed`);
      return true;
    }

    const appt = appts[0];

    // Update appointment
    if (isApprove) {
      await sql`
        UPDATE appointments 
        SET 
          status = 'confirmed',
          approved_at = ${timestamp},
          updated_at = NOW()
        WHERE id = ${appointmentId}
      `;
    } else {
      await sql`
        UPDATE appointments 
        SET 
          status = 'rejected',
          rejected_at = ${timestamp},
          updated_at = NOW()
        WHERE id = ${appointmentId}
      `;
    }

    // Update Google Sheets
    if (clinic[0].google_sheet_id) {
      await GoogleSheetsLogger.updateAppointmentStatus(
        clinic[0].google_sheet_id,
        appointmentId,
        newStatus,
        timestamp.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      ).catch(err => logger.warning('Sheets update failed', err));
    }

    const formattedDate = new Date(appt.appointment_date).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      timeZone: 'Asia/Kolkata'
    });

    // Notify patient
    const patientMessage = isApprove
      ? `✅ *Appointment Confirmed!*\n\n` +
        `📋 Booking #${appointmentId}\n` +
        `🏥 ${clinic[0].name}\n` +
        `📅 ${formattedDate}\n` +
        `🕒 ${appt.appointment_time}\n\n` +
        `Please arrive 10 minutes early.\n\n` +
        `See you soon! 😊`
      : `❌ *Appointment Not Available*\n\n` +
        `📋 Booking #${appointmentId}\n\n` +
        `Your appointment request could not be confirmed.\n` +
        `Please contact the clinic directly or try another time slot.\n\n` +
        `Reply "1" to book again.`;

    await sendWhatsAppMessage(appt.patient_phone, patientMessage);

    // Confirm to doctor
    await sendWhatsAppMessage(
      phoneNumber, 
      `✅ Appointment #${appointmentId} ${newStatus.toUpperCase()}`
    );

    logger.success(`Doctor ${newStatus} appointment #${appointmentId}`);
    return true;

  } catch (error) {
    logger.error('Doctor response error', error);
    await sendWhatsAppMessage(phoneNumber, '❌ Error processing command. Try again.');
    return true;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/', (req, res) => {
  res.json({
    name: 'WhatsApp Clinic Bot',
    version: '4.0.0',
    status: 'operational',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    uptime: process.uptime(),
    checks: { 
      database: 'unknown', 
      cache: cacheEnabled ? 'enabled' : 'disabled' 
    },
  };

  try {
    await sql`SELECT NOW()`;
    health.checks.database = 'healthy';
  } catch (error) {
    health.checks.database = 'unhealthy';
    health.status = 'degraded';
  }

  res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

app.get('/status', async (req, res) => {
  try {
    const [clinics] = await sql`SELECT COUNT(*) as count FROM clinics WHERE status = 'active'`;
    const [today] = await sql`SELECT COUNT(*) as count FROM appointments WHERE DATE(created_at) = CURRENT_DATE`;
    const [pending] = await sql`SELECT COUNT(*) as count FROM appointments WHERE status = 'pending'`;

    res.json({
      status: 'operational',
      version: '4.0.0',
      uptime: process.uptime(),
      cache: cacheEnabled,
      stats: {
        clinics: parseInt(clinics.count),
        today: parseInt(today.count),
        pending: parseInt(pending.count),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const { From: from, Body: body } = req.body;
    logger.info('Message received', { from, body });
    
    // Always respond 200 immediately
    res.status(200).send('OK');

    // Process message asynchronously
    const session = await getSession(from);

    // Check if doctor
    const isDoctorCommand = await handleDoctorResponse(from, body);
    if (isDoctorCommand) return;

    // Handle patient flow
    const normalizedMessage = body.toLowerCase().trim();
    
    if (!session || normalizedMessage === 'hi' || normalizedMessage === '1') {
      await handleGreeting(from);
    } else if (session.stage === 'select_clinic') {
      await handleClinicSelection(from, body);
    } else if (session.stage === 'enter_name') {
      await handleNameEntry(from, body);
    } else if (session.stage === 'select_date') {
      await handleDateSelection(from, body);
    } else if (session.stage === 'select_time') {
      await handleTimeSelection(from, body);
    } else {
      await handleGreeting(from);
    }
    
  } catch (error) {
    logger.error('Webhook error', error);
    // Already responded with 200
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CRON ENDPOINTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post('/cron/auto-approval', async (req, res) => {
  try {
    logger.info('Auto-approval cron triggered');
    
    const { processAutoApprovals } = require('./autoApproval');
    const result = await processAutoApprovals();
    
    logger.success('Auto-approval cron completed', result);
    res.json({ success: true, ...result });
    
  } catch (error) {
    logger.error('Auto-approval cron failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/cron/send-reminders', async (req, res) => {
  try {
    logger.info('Reminder cron triggered');
    
    const { sendReminders } = require('./sendReminders');
    const result = await sendReminders();
    
    logger.success('Reminder cron completed', result);
    res.json({ success: true, ...result });
    
  } catch (error) {
    logger.error('Reminder cron failed', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ERROR HANDLING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STARTUP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function startServer() {
  try {
    // Test database
    await sql`SELECT NOW()`;
    logger.info('✅ Database connected');

    // Start server
    app.listen(PORT, () => {
      logger.info('═══════════════════════════════════════');
      logger.info(`🚀 Clinic Bot v4.0.0 ULTIMATE`);
      logger.info(`📡 Port: ${PORT}`);
      logger.info(`🌍 Env: ${NODE_ENV}`);
      logger.info(`⚡ Cache: ${cacheEnabled ? 'ON' : 'OFF'}`);
      logger.info('═══════════════════════════════════════');
    });
  } catch (error) {
    logger.error('Startup failed', error);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  logger.info('Shutting down gracefully...');
  if (redisClient) await redisClient.quit().catch(() => {});
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection', error);
});

startServer();

module.exports = app;
