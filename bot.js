/**
 * ═══════════════════════════════════════════════════════════
 * WHATSAPP CLINIC BOT v4.0.0 - ULTIMATE EDITION
 * 
 * Enterprise-grade multi-clinic appointment booking system
 * 
 * Features:
 * - Multi-clinic support
 * - Auto-approval workflow
 * - 24-hour reminders
 * - Google Sheets logging
 * - Redis caching
 * - Winston logging
 * - Email notifications
 * - Helmet security
 * - Rate limiting
 * - Input validation
 * - Health monitoring
 * - Error tracking
 * 
 * Author: Sourav Roy - Legacylens Automation
 * Version: 4.0.0
 * ═══════════════════════════════════════════════════════════
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// IMPORTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const twilio = require('twilio');
const { createClient } = require('redis');
const winston = require('winston');
require('winston-daily-rotate-file');

// Import custom modules (create these files)
// const { logToGoogleSheets } = require('./utils/googleSheets');
// const { sendReminders } = require('./utils/sendReminders');
// const { sendEmail, sendAdminAlert } = require('./utils/email');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIGURATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Database
const sql = neon(process.env.DATABASE_URL);

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WINSTON LOGGING SETUP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'clinic-bot' },
  transports: [
    new winston.transports.DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '30d',
      maxSize: '20m',
    }),
    new winston.transports.DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      maxSize: '20m',
    }),
  ],
});

if (NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    })
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REDIS CACHE SETUP (Optional)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let redisClient = null;
let cacheEnabled = false;

async function initializeCache() {
  if (!process.env.REDIS_URL) {
    logger.warn('Redis not configured - caching disabled');
    return;
  }

  try {
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (err) => logger.error('Redis error:', err));
    redisClient.on('connect', () => {
      logger.info('Redis connected');
      cacheEnabled = true;
    });
    await redisClient.connect();
  } catch (error) {
    logger.error('Redis initialization failed:', error);
    cacheEnabled = false;
  }
}

async function getCache(key) {
  if (!cacheEnabled || !redisClient) return null;
  try {
    const value = await redisClient.get(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    logger.error('Cache get error:', error);
    return null;
  }
}

async function setCache(key, value, expirySeconds = 3600) {
  if (!cacheEnabled || !redisClient) return;
  try {
    await redisClient.setEx(key, expirySeconds, JSON.stringify(value));
  } catch (error) {
    logger.error('Cache set error:', error);
  }
}

async function deleteCache(key) {
  if (!cacheEnabled || !redisClient) return;
  try {
    await redisClient.del(key);
  } catch (error) {
    logger.error('Cache delete error:', error);
  }
}

initializeCache();

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
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests',
});
app.use('/api/', limiter);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UTILITY FUNCTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function sendWhatsAppMessage(to, message) {
  try {
    const result = await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to,
      body: message,
    });
    logger.info('WhatsApp sent', { to, sid: result.sid });
    return { success: true, sid: result.sid };
  } catch (error) {
    logger.error('WhatsApp failed', { to, error: error.message });
    return { success: false, error: error.message };
  }
}

async function getSession(phoneNumber) {
  const cacheKey = `session:${phoneNumber}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const session = await sql`
    SELECT * FROM sessions 
    WHERE phone_number = ${phoneNumber} 
    AND expires_at > NOW()
    ORDER BY created_at DESC 
    LIMIT 1
  `;

  if (session.length > 0) {
    await setCache(cacheKey, session[0], 300);
    return session[0];
  }
  return null;
}

async function updateSession(phoneNumber, updates) {
  const result = await sql`
    UPDATE sessions 
    SET 
      step = ${updates.step || null},
      clinic_id = ${updates.clinic_id || null},
      patient_name = ${updates.patient_name || null},
      appointment_date = ${updates.appointment_date || null},
      updated_at = NOW()
    WHERE phone_number = ${phoneNumber}
    RETURNING *
  `;
  await deleteCache(`session:${phoneNumber}`);
  return result[0];
}

async function getActiveClinics() {
  const cacheKey = 'clinics:active';
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const clinics = await sql`
    SELECT * FROM clinics 
    WHERE status = 'active' 
    ORDER BY id
  `;

  await setCache(cacheKey, clinics, 3600);
  return clinics;
}

async function getClinicById(clinicId) {
  const cacheKey = `clinic:${clinicId}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

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

  await sql`
    INSERT INTO sessions (phone_number, step, expires_at)
    VALUES (${phoneNumber}, 'select_clinic', NOW() + INTERVAL '1 hour')
    ON CONFLICT (phone_number) 
    DO UPDATE SET 
      step = 'select_clinic',
      expires_at = NOW() + INTERVAL '1 hour',
      updated_at = NOW()
  `;

  let message = '👋 Welcome to Clinic Appointment System!\n\n';
  message += '📋 Select a clinic:\n\n';

  clinics.forEach((clinic, index) => {
    message += `${index + 1}. ${clinic.name}\n`;
    message += `   👨‍⚕️ Dr. ${clinic.doctor_name}\n`;
    message += `   ⏰ ${clinic.business_hours_start} - ${clinic.business_hours_end}\n\n`;
  });

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
    step: 'enter_name',
    clinic_id: clinic.id,
  });

  await sendWhatsAppMessage(
    phoneNumber,
    `✅ Selected: ${clinic.name}\n\n👤 Enter your full name:`
  );
}

async function handleNameEntry(phoneNumber, message) {
  const name = message.trim();

  if (name.length < 2) {
    await sendWhatsAppMessage(phoneNumber, '❌ Name too short (min 2 chars)');
    return;
  }

  await updateSession(phoneNumber, {
    step: 'select_date',
    patient_name: name,
  });

  const dates = [];
  for (let i = 1; i <= 7; i++) {
    const date = new Date();
    date.setDate(date.getDate() + i);
    dates.push(date.toISOString().split('T')[0]);
  }

  let msg = `👤 Name: ${name}\n\n📅 Select date:\n\n`;
  dates.forEach((date, i) => {
    const d = new Date(date);
    msg += `${i + 1}. ${d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}\n`;
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
  const clinic = await getClinicById(session.clinic_id);

  await updateSession(phoneNumber, {
    step: 'select_time',
    appointment_date: appointmentDate,
  });

  const startHour = parseInt(clinic.business_hours_start.split(':')[0]);
  const endHour = parseInt(clinic.business_hours_end.split(':')[0]);

  let msg = `📅 ${date.toLocaleDateString()}\n\n⏰ Select time:\n\n`;
  for (let hour = startHour; hour < endHour; hour++) {
    const time = hour > 12 ? `${hour - 12}:00 PM` : `${hour}:00 AM`;
    msg += `${hour - startHour + 1}. ${time}\n`;
  }

  await sendWhatsAppMessage(phoneNumber, msg);
}

async function handleTimeSelection(phoneNumber, message) {
  const session = await getSession(phoneNumber);
  const clinic = await getClinicById(session.clinic_id);

  const selection = parseInt(message.trim());
  const startHour = parseInt(clinic.business_hours_start.split(':')[0]);
  const endHour = parseInt(clinic.business_hours_end.split(':')[0]);
  const totalSlots = endHour - startHour;

  if (isNaN(selection) || selection < 1 || selection > totalSlots) {
    await sendWhatsAppMessage(phoneNumber, `❌ Invalid. Reply 1-${totalSlots}`);
    return;
  }

  const hour = startHour + selection - 1;
  const time = hour > 12 ? `${hour - 12}:00 PM` : `${hour}:00 AM`;

  try {
    const appt = await sql`
      INSERT INTO appointments (
        clinic_id, patient_name, patient_phone,
        appointment_date, appointment_time, appointment_slot,
        status, reminder_sent
      ) VALUES (
        ${session.clinic_id}, ${session.patient_name}, ${phoneNumber},
        ${session.appointment_date}, ${time}, ${time},
        'pending', false
      ) RETURNING *
    `;

    logger.info('Appointment created', { id: appt[0].id });

    // Patient confirmation
    await sendWhatsAppMessage(
      phoneNumber,
      `✅ Appointment Requested!\n\n` +
        `📋 ID: #${appt[0].id}\n` +
        `👤 ${session.patient_name}\n` +
        `🏥 ${clinic.name}\n` +
        `📅 ${new Date(session.appointment_date).toLocaleDateString()}\n` +
        `⏰ ${time}\n\n` +
        `⏳ Pending doctor approval\n` +
        `You'll be notified once confirmed.`
    );

    // Doctor notification
    await sendWhatsAppMessage(
      clinic.doctor_whatsapp,
      `📅 New Appointment\n\n` +
        `#${appt[0].id}\n` +
        `👤 ${session.patient_name}\n` +
        `📞 ${phoneNumber}\n` +
        `📅 ${new Date(session.appointment_date).toLocaleDateString()}\n` +
        `⏰ ${time}\n\n` +
        `Reply:\n` +
        `✅ APPROVE\n` +
        `❌ REJECT`
    );

    // Cleanup
    await sql`DELETE FROM sessions WHERE phone_number = ${phoneNumber}`;
    await deleteCache(`session:${phoneNumber}`);
  } catch (error) {
    logger.error('Appointment creation failed:', error);
    await sendWhatsAppMessage(phoneNumber, '❌ Error creating appointment. Try again.');
  }
}

async function handleDoctorResponse(phoneNumber, message) {
  const normalized = message.trim().toUpperCase();

  const clinic = await sql`
    SELECT * FROM clinics 
    WHERE doctor_whatsapp = ${phoneNumber} 
    LIMIT 1
  `;

  if (clinic.length === 0) return;

  const appts = await sql`
    SELECT * FROM appointments 
    WHERE clinic_id = ${clinic[0].id} 
    AND status = 'pending'
    ORDER BY created_at DESC 
    LIMIT 1
  `;

  if (appts.length === 0) {
    await sendWhatsAppMessage(phoneNumber, '❌ No pending appointments');
    return;
  }

  const appt = appts[0];

  if (normalized === 'APPROVE' || normalized === '✅') {
    await sql`
      UPDATE appointments 
      SET status = 'confirmed', approved_at = NOW()
      WHERE id = ${appt.id}
    `;

    await sendWhatsAppMessage(
      appt.patient_phone,
      `✅ Appointment Confirmed!\n\n` +
        `#${appt.id}\n` +
        `🏥 ${clinic[0].name}\n` +
        `📅 ${new Date(appt.appointment_date).toLocaleDateString()}\n` +
        `⏰ ${appt.appointment_time}\n\n` +
        `See you soon! 😊`
    );

    await sendWhatsAppMessage(phoneNumber, `✅ Appointment #${appt.id} APPROVED`);
  } else if (normalized === 'REJECT' || normalized === '❌') {
    await sql`
      UPDATE appointments 
      SET status = 'rejected', rejected_at = NOW()
      WHERE id = ${appt.id}
    `;

    await sendWhatsAppMessage(
      appt.patient_phone,
      `❌ Appointment Not Available\n\n` +
        `#${appt.id}\n\n` +
        `Please call us to reschedule.`
    );

    await sendWhatsAppMessage(phoneNumber, `❌ Appointment #${appt.id} REJECTED`);
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
    checks: { database: 'unknown', cache: cacheEnabled ? 'enabled' : 'disabled' },
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
    const [clinics] = await sql`SELECT COUNT(*) FROM clinics WHERE status = 'active'`;
    const [today] = await sql`SELECT COUNT(*) FROM appointments WHERE DATE(created_at) = CURRENT_DATE`;
    const [pending] = await sql`SELECT COUNT(*) FROM appointments WHERE status = 'pending'`;

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
    logger.info('Message', { from, body });
    res.status(200).send('OK');

    const session = await getSession(from);

    // Check if doctor
    const doctor = await sql`
      SELECT * FROM clinics 
      WHERE doctor_whatsapp = ${from} 
      LIMIT 1
    `;

    if (doctor.length > 0) {
      await handleDoctorResponse(from, body);
      return;
    }

    // Handle patient flow
    if (!session || body.toLowerCase().trim() === 'hi') {
      await handleGreeting(from);
    } else if (session.step === 'select_clinic') {
      await handleClinicSelection(from, body);
    } else if (session.step === 'enter_name') {
      await handleNameEntry(from, body);
    } else if (session.step === 'select_date') {
      await handleDateSelection(from, body);
    } else if (session.step === 'select_time') {
      await handleTimeSelection(from, body);
    } else {
      await handleGreeting(from);
    }
  } catch (error) {
    logger.error('Webhook error:', error);
    res.status(200).send('OK');
  }
});

app.post('/cron/auto-process', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const appts = await sql`
      SELECT a.*, c.name, c.doctor_name, c.auto_action, c.auto_approve_after_hours
      FROM appointments a
      JOIN clinics c ON a.clinic_id = c.id
      WHERE a.status = 'pending'
        AND c.auto_approve = true
        AND a.created_at <= NOW() - (c.auto_approve_after_hours * INTERVAL '1 hour')
    `;

    let processed = 0;
    for (const appt of appts) {
      const action = appt.auto_action || 'approve';
      const status = action === 'reject' ? 'rejected' : 'confirmed';

      await sql`
        UPDATE appointments 
        SET status = ${status}, auto_processed = true, auto_processed_at = NOW()
        WHERE id = ${appt.id}
      `;

      if (action === 'approve') {
        await sendWhatsAppMessage(appt.patient_phone, `✅ Auto-Confirmed! #${appt.id}`);
      } else {
        await sendWhatsAppMessage(appt.patient_phone, `❌ Not confirmed #${appt.id}`);
      }

      processed++;
    }

    res.json({ processed, total: appts.length });
  } catch (error) {
    logger.error('Auto-process error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/cron/send-reminders', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const appts = await sql`
      SELECT a.*, c.name as clinic_name, c.doctor_name
      FROM appointments a
      JOIN clinics c ON a.clinic_id = c.id
      WHERE a.status = 'confirmed'
        AND a.reminder_sent = false
        AND a.appointment_date BETWEEN NOW() + INTERVAL '22 hours' AND NOW() + INTERVAL '26 hours'
    `;

    let sent = 0;
    for (const appt of appts) {
      await sendWhatsAppMessage(
        appt.patient_phone,
        `🔔 Reminder\n\n` +
          `Appointment tomorrow!\n` +
          `#${appt.id}\n` +
          `🏥 ${appt.clinic_name}\n` +
          `📅 ${new Date(appt.appointment_date).toLocaleDateString()}\n` +
          `⏰ ${appt.appointment_time}`
      );

      await sql`
        UPDATE appointments 
        SET reminder_sent = true, reminder_sent_at = NOW()
        WHERE id = ${appt.id}
      `;

      sent++;
    }

    res.json({ sent, total: appts.length });
  } catch (error) {
    logger.error('Reminders error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ERROR HANDLING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use((err, req, res, next) => {
  logger.error('Error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STARTUP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function startServer() {
  try {
    await sql`SELECT NOW()`;
    logger.info('✅ Database connected');

    app.listen(PORT, () => {
      logger.info('═══════════════════════════════════════');
      logger.info(`🚀 Clinic Bot v4.0.0 ULTIMATE`);
      logger.info(`📡 Port: ${PORT}`);
      logger.info(`🌍 Env: ${NODE_ENV}`);
      logger.info(`⚡ Cache: ${cacheEnabled ? 'ON' : 'OFF'}`);
      logger.info('═══════════════════════════════════════');
    });
  } catch (error) {
    logger.error('Startup failed:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  if (redisClient) await redisClient.quit();
  process.exit(0);
});

startServer();

module.exports = app;
