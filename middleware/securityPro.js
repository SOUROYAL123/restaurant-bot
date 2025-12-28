/**
 * ═══════════════════════════════════════════════════════════
 * SECURITY MIDDLEWARE - Production Grade
 * - Twilio signature verification
 * - Razorpay webhook validation
 * - Rate limiting
 * - Request sanitization
 * ═══════════════════════════════════════════════════════════
 */

const crypto = require('crypto');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

/**
 * Verify Twilio webhook signature
 * CRITICAL: Prevents webhook spoofing
 */
function verifyTwilioSignature(req, res, next) {
    // Skip verification in development if explicitly disabled
    if (process.env.NODE_ENV === 'development' && process.env.SKIP_TWILIO_VERIFICATION === 'true') {
        console.log('⚠️  Twilio signature verification SKIPPED (development mode)');
        return next();
    }
    
    const twilioSignature = req.headers['x-twilio-signature'];
    
    if (!twilioSignature) {
        console.error('❌ Missing Twilio signature header');
        return res.status(403).json({ error: 'Forbidden - Missing signature' });
    }
    
    // Construct the URL Twilio used to make the request
    const protocol = req.protocol;
    const host = req.get('host');
    const url = `${protocol}://${host}${req.originalUrl}`;
    
    // Validate the request
    const isValid = twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN,
        twilioSignature,
        url,
        req.body
    );
    
    if (!isValid) {
        console.error('❌ Invalid Twilio signature', {
            url,
            headers: req.headers,
            body: req.body
        });
        return res.status(403).json({ error: 'Forbidden - Invalid signature' });
    }
    
    console.log('✅ Twilio signature verified');
    next();
}

/**
 * Verify Razorpay webhook signature
 * CRITICAL: Prevents payment callback spoofing
 */
function verifyRazorpaySignature(req, res, next) {
    // Skip verification in development if explicitly disabled
    if (process.env.NODE_ENV === 'development' && process.env.SKIP_RAZORPAY_VERIFICATION === 'true') {
        console.log('⚠️  Razorpay signature verification SKIPPED (development mode)');
        return next();
    }
    
    const razorpaySignature = req.headers['x-razorpay-signature'];
    
    if (!razorpaySignature) {
        console.error('❌ Missing Razorpay signature header');
        return res.status(403).json({ error: 'Forbidden - Missing signature' });
    }
    
    // Get the webhook body
    const webhookBody = JSON.stringify(req.body);
    
    // Generate expected signature
    const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(webhookBody)
        .digest('hex');
    
    // Constant-time comparison to prevent timing attacks
    const isValid = crypto.timingSafeEqual(
        Buffer.from(razorpaySignature),
        Buffer.from(expectedSignature)
    );
    
    if (!isValid) {
        console.error('❌ Invalid Razorpay signature', {
            received: razorpaySignature,
            expected: expectedSignature
        });
        return res.status(403).json({ error: 'Forbidden - Invalid signature' });
    }
    
    console.log('✅ Razorpay signature verified');
    next();
}

/**
 * Verify Razorpay payment callback (GET request)
 * Used for payment link callbacks
 */
function verifyRazorpayCallback(req, res, next) {
    const { razorpay_payment_id, razorpay_payment_link_id, razorpay_payment_link_status } = req.query;
    
    // Basic validation
    if (!razorpay_payment_id || !razorpay_payment_link_id || !razorpay_payment_link_status) {
        console.error('❌ Missing required Razorpay callback parameters');
        return res.status(400).send('Invalid payment callback - missing parameters');
    }
    
    // Payment link callbacks don't include signature in GET requests
    // We'll verify by fetching from Razorpay API in the handler
    console.log('✅ Razorpay callback parameters present');
    next();
}

/**
 * Rate limiting for webhooks
 */
const webhookRateLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute per IP
    message: 'Too many webhook requests, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        // Skip rate limiting for health checks
        return req.path === '/health' || req.path === '/ping';
    }
});

/**
 * Aggressive rate limiting for payment endpoints
 */
const paymentRateLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10, // 10 requests per minute per IP
    message: 'Too many payment requests, please try again later',
    standardHeaders: true,
    legacyHeaders: false
});

/**
 * API key authentication for admin endpoints
 */
function requireApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    
    if (!process.env.ADMIN_API_KEY) {
        console.error('❌ ADMIN_API_KEY not configured');
        return res.status(500).json({ error: 'Server misconfiguration' });
    }
    
    if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
        console.error('❌ Invalid or missing API key');
        return res.status(401).json({ error: 'Unauthorized - Invalid API key' });
    }
    
    console.log('✅ API key verified');
    next();
}

/**
 * Request sanitization middleware
 * Prevents injection attacks
 */
function sanitizeRequest(req, res, next) {
    // Sanitize query parameters
    if (req.query) {
        Object.keys(req.query).forEach(key => {
            if (typeof req.query[key] === 'string') {
                // Remove null bytes
                req.query[key] = req.query[key].replace(/\0/g, '');
                
                // Trim whitespace
                req.query[key] = req.query[key].trim();
            }
        });
    }
    
    // Sanitize body
    if (req.body && typeof req.body === 'object') {
        Object.keys(req.body).forEach(key => {
            if (typeof req.body[key] === 'string') {
                // Remove null bytes
                req.body[key] = req.body[key].replace(/\0/g, '');
                
                // Trim whitespace
                req.body[key] = req.body[key].trim();
            }
        });
    }
    
    next();
}

/**
 * CORS configuration for production
 */
function configureCORS() {
    const allowedOrigins = process.env.ALLOWED_ORIGINS 
        ? process.env.ALLOWED_ORIGINS.split(',') 
        : [];
    
    return {
        origin: (origin, callback) => {
            // Allow requests with no origin (mobile apps, Postman, etc.)
            if (!origin) return callback(null, true);
            
            // In development, allow all origins
            if (process.env.NODE_ENV === 'development') {
                return callback(null, true);
            }
            
            // In production, check whitelist
            if (allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        credentials: true,
        optionsSuccessStatus: 200
    };
}

/**
 * Security headers middleware
 */
function setSecurityHeaders(req, res, next) {
    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'DENY');
    
    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // Enable XSS protection
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    // Strict transport security (HTTPS only)
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    
    // Content security policy
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    
    next();
}

/**
 * Request logging for security audit
 */
function securityLogger(req, res, next) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.path,
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.get('user-agent'),
        referer: req.get('referer')
    };
    
    // Log sensitive endpoints
    if (req.path.includes('/payment') || req.path.includes('/webhook')) {
        console.log('🔒 Security Log:', JSON.stringify(logEntry));
    }
    
    next();
}

module.exports = {
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
};
