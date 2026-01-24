// features/config.js
// Feature Flag Configuration System

require('dotenv').config();

// Subscription plan tiers and their included features
const PLAN_FEATURES = {
    basic: {
        order_delivery: true,
        table_booking: true,
        payment: false,
        loyalty: false,
        reviews: false,
        order_history: true,
        reorder: false,
        broadcasts: false,
        analytics: false,
        multilanguage: false,
        menu_images: false,
        order_tracking: true,
        promo_codes: false,
        admin_dashboard: false
    },
    growth: {
        order_delivery: true,
        table_booking: true,
        payment: true,
        loyalty: false,
        reviews: true,
        order_history: true,
        reorder: true,
        broadcasts: false,
        analytics: false,
        multilanguage: false,
        menu_images: true,
        order_tracking: true,
        promo_codes: true,
        admin_dashboard: true
    },
    premium: {
        order_delivery: true,
        table_booking: true,
        payment: true,
        loyalty: true,
        reviews: true,
        order_history: true,
        reorder: true,
        broadcasts: true,
        analytics: true,
        multilanguage: false,
        menu_images: true,
        order_tracking: true,
        promo_codes: true,
        admin_dashboard: true
    },
    enterprise: {
        order_delivery: true,
        table_booking: true,
        payment: true,
        loyalty: true,
        reviews: true,
        order_history: true,
        reorder: true,
        broadcasts: true,
        analytics: true,
        multilanguage: true,
        menu_images: true,
        order_tracking: true,
        promo_codes: true,
        admin_dashboard: true
    }
};

// Get current subscription plan from environment
const CURRENT_PLAN = (process.env.SUBSCRIPTION_PLAN || 'basic').toLowerCase();

// Get plan features
const planFeatures = PLAN_FEATURES[CURRENT_PLAN] || PLAN_FEATURES.basic;

// Feature flags - can be overridden by environment variables
const FEATURES = {
    // Core features
    ORDER_DELIVERY: process.env.FEATURE_ORDER_DELIVERY === 'true' || planFeatures.order_delivery,
    TABLE_BOOKING: process.env.FEATURE_TABLE_BOOKING === 'true' || planFeatures.table_booking,
    
    // Payment
    PAYMENT: process.env.FEATURE_PAYMENT === 'true' || planFeatures.payment,
    
    // Loyalty
    LOYALTY: process.env.FEATURE_LOYALTY === 'true' || planFeatures.loyalty,
    
    // Reviews
    REVIEWS: process.env.FEATURE_REVIEWS === 'true' || planFeatures.reviews,
    
    // Order features
    ORDER_HISTORY: process.env.FEATURE_ORDER_HISTORY === 'true' || planFeatures.order_history,
    REORDER: process.env.FEATURE_REORDER === 'true' || planFeatures.reorder,
    ORDER_TRACKING: process.env.FEATURE_ORDER_TRACKING === 'true' || planFeatures.order_tracking,
    
    // Marketing
    BROADCASTS: process.env.FEATURE_BROADCASTS === 'true' || planFeatures.broadcasts,
    PROMO_CODES: process.env.FEATURE_PROMO_CODES === 'true' || planFeatures.promo_codes,
    
    // Analytics
    ANALYTICS: process.env.FEATURE_ANALYTICS === 'true' || planFeatures.analytics,
    ADMIN_DASHBOARD: process.env.FEATURE_ADMIN_DASHBOARD === 'true' || planFeatures.admin_dashboard,
    
    // Advanced
    MULTILANGUAGE: process.env.FEATURE_MULTILANGUAGE === 'true' || planFeatures.multilanguage,
    MENU_IMAGES: process.env.FEATURE_MENU_IMAGES === 'true' || planFeatures.menu_images
};

// Payment configuration
const PAYMENT_CONFIG = {
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET
};

// Loyalty configuration
const LOYALTY_CONFIG = {
    EARN_RATE: parseInt(process.env.LOYALTY_EARN_RATE || '1'),
    REDEEM_RATE: parseInt(process.env.LOYALTY_REDEEM_RATE || '1'),
    MIN_REDEEM: parseInt(process.env.LOYALTY_MIN_REDEEM || '100')
};

// Review configuration
const REVIEW_CONFIG = {
    PROMPT_DELAY: parseInt(process.env.REVIEW_PROMPT_DELAY || '3600')
};

// Restaurant configuration
const RESTAURANT_CONFIG = {
    ID: parseInt(process.env.RESTAURANT_ID || '1'),
    NAME: process.env.RESTAURANT_NAME || 'Restaurant',
    TIMEZONE: process.env.RESTAURANT_TIMEZONE || 'Asia/Kolkata'
};

// Business rules
const BUSINESS_RULES = {
    MIN_ORDER_AMOUNT: parseFloat(process.env.MIN_ORDER_AMOUNT || '100'),
    FREE_DELIVERY_ABOVE: parseFloat(process.env.FREE_DELIVERY_ABOVE || '500'),
    PEAK_HOURS_SURCHARGE: parseFloat(process.env.PEAK_HOURS_SURCHARGE || '0'),
    PREPARATION_TIME: parseInt(process.env.PREPARATION_TIME || '30')
};

// Helper function to check if a feature is enabled
function isFeatureEnabled(featureName) {
    return FEATURES[featureName.toUpperCase()] === true;
}

// Helper function to get feature status message
function getFeatureStatus() {
    const enabled = [];
    const disabled = [];
    
    for (const [key, value] of Object.entries(FEATURES)) {
        if (value) {
            enabled.push(key.toLowerCase());
        } else {
            disabled.push(key.toLowerCase());
        }
    }
    
    return {
        plan: CURRENT_PLAN,
        enabled,
        disabled
    };
}

module.exports = {
    FEATURES,
    PAYMENT_CONFIG,
    LOYALTY_CONFIG,
    REVIEW_CONFIG,
    RESTAURANT_CONFIG,
    BUSINESS_RULES,
    CURRENT_PLAN,
    isFeatureEnabled,
    getFeatureStatus
};
