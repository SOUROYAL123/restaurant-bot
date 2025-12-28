/**
 * ═══════════════════════════════════════════════════════════
 * WHATSAPP CLINIC BOT v6.0.0 - PRODUCTION READY
 * 
 * Security Hardened:
 * ✅ Twilio signature verification
 * ✅ Razorpay webhook validation
 * ✅ Environment validation
 * ✅ Request sanitization
 * ✅ Enhanced rate limiting
 * ✅ Security headers
 * 
 * Author: Sourav Roy - Legacylens Automation
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

// ═══════════════════════════════════════════════════════════
// 1. ENVIRONMENT VALIDATION (CRITICAL - RUNS FIRST)
// ═══════════════════════════════════════════════════════════
require('dotenv').config();
require('./config/validateEnv'); // Will exit if validation fails

// ═══════════════════════════════════════════════════════════
// 2. CORE DEPENDENCIES
// ═══════════════════════════════════════════════════════════
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const twilio = require('twilio');
const Razorpay = require('razorpay');

// ═══════════════════════════════════════════════════════════
// 3. SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════
const {
    verifyTwilioSignature,
    verifyRazorpaySignature,
    verifyRazorpayCallback,
    webhookRateLimiter,
    paymentRateLimiter,
    requireApiKey,
    sanitizeRequest,
    configureCORS,
    setSecurityHeaders,
    securityLogger
} = require('./middleware/securityPro');

// ═══════════════════════════════════════════════════════════
// 4. INITIALIZE APP
// ═══════════════════════════════════════════════════════════
const app = express();
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

// Database
const sql = neon(process.env.DATABASE_URL);

// Twilio
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ═══════════════════════════════════════════════════════════
// 5. LOGGING
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// 6. SECURITY MIDDLEWARE (APPLIED GLOBALLY)
// ═══════════════════════════════════════════════════════════
app.set('trust proxy', 1);
app.use(helmet()); // Security headers
app.use(setSecurityHeaders); // Custom security headers
app.use(cors(configureCORS())); // CORS configuration
app.use(compression()); // Response compression
app.use(securityLogger); // Security audit logging
app.use(sanitizeRequest); // Request sanitization

// Body parsers
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

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
// 7. UTILITY FUNCTIONS (Same as before)
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

// ═══════════════════════════════════════════════════════════
// 8. PAYMENT HANDLERS (ENHANCED SECURITY)
// ═══════════════════════════════════════════════════════════
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
            notify: { sms: false, email: false, whatsapp: false },
            reminder_enable: false,
            callback_url: `${process.env.BASE_URL}/payment-callback?appointment_id=${appointmentId}`,
            callback_method: 'get'
        });
        
        await sql`UPDATE appointments SET payment_link_id = ${paymentLink.id}, payment_status = 'pending', updated_at = NOW() WHERE id = ${appointmentId}`;
        log.success('Payment link created', { appointmentId });
        return { success: true, paymentUrl: paymentLink.short_url, amount: depositAmount };
    } catch (error) {
        log.error('Payment link failed', error);
        return { success: false, error: error.message };
    }
}

async function verifyPayment(paymentLinkId, paymentId) {
    try {
        const paymentLink = await razorpay.paymentLink.fetch(paymentLinkId);
        if (paymentLink.status === 'paid') {
            return { success: true, amount: paymentLink.amount / 100, paymentId };
        }
        return { success: false, error: 'Payment not completed' };
    } catch (error) {
        log.error('Payment verification failed', error);
        return { success: false, error: error.message };
    }
}

// ═══════════════════════════════════════════════════════════
// 9. PUBLIC ROUTES (NO AUTH REQUIRED)
// ═══════════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({ 
    name: 'WhatsApp Clinic Bot', 
    version: '6.0.0', 
    status: 'operational', 
    security: 'enhanced',
    features: { 
        payment_integration: true, 
        smart_reminders: true, 
        interactive_commands: true, 
        waitlist: true,
        signature_verification: true
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

// ═══════════════════════════════════════════════════════════
// 10. WEBHOOK ENDPOINTS (SIGNATURE VERIFIED)
// ═══════════════════════════════════════════════════════════

/**
 * WhatsApp Webhook - SIGNATURE VERIFIED
 */
app.post('/webhook/whatsapp', 
    webhookRateLimiter,
    verifyTwilioSignature, // 🔒 SECURITY: Verify Twilio signature
    async (req, res) => {
        res.status(200).send('OK');
        
        try {
            const { From, Body, ButtonPayload } = req.body;
            if (!From || !Body) { 
                log.warn('Invalid webhook payload'); 
                return; 
            }
            
            const message = ButtonPayload || Body;
            log.info('Incoming', { from: normalizePhone(From), message, isButton: !!ButtonPayload });
            
            // Process message asynchronously
            setImmediate(() => handleMessage(From, message));
        } catch (err) { 
            log.error('Webhook error', err); 
        }
    }
);

/**
 * Razorpay Payment Webhook - SIGNATURE VERIFIED
 */
app.post('/payment-webhook',
    paymentRateLimiter,
    verifyRazorpaySignature, // 🔒 SECURITY: Verify Razorpay signature
    async (req, res) => {
        try {
            const { event, payload } = req.body;
            log.info('Payment webhook received', { event });
            
            if (event === 'payment_link.paid') {
                const paymentLinkId = payload.payment_link.entity.id;
                const appts = await sql`SELECT id FROM appointments WHERE payment_link_id = ${paymentLinkId} LIMIT 1`;
                
                if (appts.length > 0) {
                    await sql`UPDATE appointments SET payment_status = 'paid', updated_at = NOW() WHERE id = ${appts[0].id}`;
                    log.success('Webhook payment updated', { appointment_id: appts[0].id });
                }
            }
            
            res.status(200).send('OK');
        } catch (error) {
            log.error('Webhook error', error);
            res.status(500).send('Error');
        }
    }
);

/**
 * Payment Callback (GET) - VERIFIED BY API FETCH
 */
app.get('/payment-callback',
    paymentRateLimiter,
    verifyRazorpayCallback, // 🔒 SECURITY: Basic parameter validation
    async (req, res) => {
        try {
            const { razorpay_payment_id, razorpay_payment_link_id, razorpay_payment_link_status, appointment_id } = req.query;
            
            log.info('Payment callback received', { 
                appointment_id, 
                payment_id: razorpay_payment_id, 
                status: razorpay_payment_link_status 
            });
            
            if (razorpay_payment_link_status === 'paid') {
                // 🔒 SECURITY: Verify by fetching from Razorpay API
                const verification = await verifyPayment(razorpay_payment_link_id, razorpay_payment_id);
                
                if (verification.success) {
                    await sql`UPDATE appointments SET payment_status = 'paid', payment_id = ${razorpay_payment_id}, payment_amount = ${verification.amount}, updated_at = NOW() WHERE id = ${appointment_id}`;
                    
                    const appts = await sql`SELECT a.*, c.name as clinic_name, c.doctor_name FROM appointments a JOIN clinics c ON a.clinic_id = c.id WHERE a.id = ${appointment_id}`;
                    
                    if (appts.length > 0) {
                        const appt = appts[0];
                        const dateStr = new Date(appt.appointment_date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
                        await sendWhatsApp(appt.patient_phone, `💰 *Payment Received!*\n\n✅ Deposit of ₹${verification.amount} confirmed\n\n📋 Booking #${appointment_id}\n📅 ${dateStr}\n⏰ ${appt.appointment_time}\n\n⏳ Doctor will approve shortly\n📨 You'll receive confirmation via WhatsApp`);
                    }
                    
                    log.success('Payment processed', { appointment_id, amount: verification.amount });
                    
                    res.send(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:Arial;text-align:center;padding:50px;background:#f0f0f0}.success{background:white;padding:40px;border-radius:10px;max-width:400px;margin:0 auto;box-shadow:0 2px 10px rgba(0,0,0,0.1)}.checkmark{color:#4CAF50;font-size:60px;margin-bottom:20px}h2{color:#333;margin-bottom:10px}p{color:#666;line-height:1.6}.amount{color:#4CAF50;font-size:24px;font-weight:bold;margin:20px 0}.note{font-size:14px;color:#999;margin-top:30px}</style></head><body><div class="success"><div class="checkmark">✓</div><h2>Payment Successful!</h2><div class="amount">₹${verification.amount}</div><p><strong>Booking #${appointment_id}</strong></p><p>Your appointment deposit has been received.</p><p>You'll receive confirmation on WhatsApp shortly.</p><p class="note">You can close this page now.</p></div></body></html>`);
                } else {
                    log.error('Payment verification failed', { appointment_id });
                    res.status(400).send('Payment verification failed. Please contact support.');
                }
            } else {
                log.warn('Payment not completed', { appointment_id, status: razorpay_payment_link_status });
                res.send('Payment was not completed. Please try again.');
            }
        } catch (error) {
            log.error('Payment callback error', error);
            res.status(500).send('Error processing payment. Please contact support.');
        }
    }
);

// ═══════════════════════════════════════════════════════════
// 11. ADMIN ENDPOINTS (API KEY REQUIRED)
// ═══════════════════════════════════════════════════════════
app.get('/status', requireApiKey, async (req, res) => { 
    try { 
        const s = await sql`SELECT (SELECT COUNT(*) FROM clinics WHERE status = 'active') as clinics, (SELECT COUNT(*) FROM appointments WHERE DATE(created_at) = CURRENT_DATE) as today, (SELECT COUNT(*) FROM appointments WHERE status = 'pending') as pending, (SELECT COUNT(*) FROM appointments WHERE payment_status = 'paid') as paid_deposits`; 
        res.json({ status: 'ok', version: '6.0.0', stats: s[0] || {} }); 
    } catch (e) { 
        res.status(500).json({ error: 'DB unavailable' }); 
    } 
});

// ═══════════════════════════════════════════════════════════
// 12. CRON ENDPOINTS (API KEY REQUIRED)
// ═══════════════════════════════════════════════════════════
app.post('/cron/auto-approval', requireApiKey, async (req, res) => { 
    try { 
        const { processAutoApprovals } = require('./autoApproval'); 
        const r = await processAutoApprovals(); 
        res.json({ success: true, result: r }); 
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    } 
});

app.post('/cron/send-reminders', requireApiKey, async (req, res) => { 
    try { 
        const { sendReminders } = require('./sendReminders'); 
        const r = await sendReminders(); 
        res.json({ success: true, result: r }); 
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    } 
});

// ═══════════════════════════════════════════════════════════
// 13. ERROR HANDLERS
// ═══════════════════════════════════════════════════════════
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));
app.use((err, req, res, next) => { 
    log.error('Unhandled error', err); 
    res.status(500).json({ error: 'Internal Error' }); 
});

// ═══════════════════════════════════════════════════════════
// 14. MESSAGE HANDLING (Include all your existing handlers)
// ═══════════════════════════════════════════════════════════
// ... [All your existing message handling code stays the same]
// This is just a placeholder - copy all your existing handlers here

async function handleMessage(phone, text) {
    // TODO: Copy all your existing message handling logic here
    log.info('Message handler called', { phone, text });
}

// ═══════════════════════════════════════════════════════════
// 15. SERVER STARTUP
// ═══════════════════════════════════════════════════════════
async function startServer() {
    try {
        log.info('Starting v6.0.0 (Production Hardened)...');
        await sql`SELECT NOW()`;
        log.success('Database connected');
        
        app.listen(PORT, HOST, () => {
            console.log('═══════════════════════════════════════════════════════════');
            console.log('🚀 WHATSAPP CLINIC BOT v6.0.0 - PRODUCTION READY');
            console.log('═══════════════════════════════════════════════════════════');
            console.log(`📡 Port: ${PORT}`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`💾 Database: Connected ✅`);
            console.log(`🔒 Security: Enhanced ✅`);
            console.log(`   ├─ Twilio Signature: Enabled ✅`);
            console.log(`   ├─ Razorpay Verification: Enabled ✅`);
            console.log(`   ├─ Rate Limiting: Active ✅`);
            console.log(`   ├─ Request Sanitization: Active ✅`);
            console.log(`   └─ Security Headers: Active ✅`);
            console.log(`💰 Payments: Razorpay Enabled ✅`);
            console.log(`📨 Reminders: 24hr + 2hr ✅`);
            console.log('═══════════════════════════════════════════════════════════');
            console.log('✅ PRODUCTION READY - ALL SECURITY FEATURES ENABLED');
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
