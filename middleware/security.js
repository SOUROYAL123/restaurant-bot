const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

/**
 * Rate limiting for webhook endpoint
 */
const webhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute per IP
    message: 'Too many requests, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * Verify Twilio webhook signature
 */
function verifyTwilioSignature(req, res, next) {
    if (process.env.NODE_ENV === 'development') {
        return next(); // Skip in development
    }
    
    const twilioSignature = req.headers['x-twilio-signature'];
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    
    const twilio = require('twilio');
    const isValid = twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN,
        twilioSignature,
        url,
        req.body
    );
    
    if (!isValid) {
        console.error('⚠️ Invalid Twilio signature');
        return res.status(403).send('Forbidden');
    }
    
    next();
}

/**
 * API key authentication for admin endpoints
 */
function requireApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    next();
}

module.exports = {
    webhookLimiter,
    verifyTwilioSignature,
    requireApiKey
};