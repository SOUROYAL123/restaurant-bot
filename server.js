require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const twilio = require('twilio');
const {
    logOrderToSheets,
    logBookingToSheets,
    testConnection,
    getSpreadsheetUrl,
    isConfigured
} = require('./apps-script-logger');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================
// DATABASE CONNECTION WITH BETTER ERROR HANDLING
// =====================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000, // 10 seconds timeout
});

// Handle database errors without crashing
pool.on('error', (err) => {
    console.error('💥 Unexpected database error:', err.message);
    // Don't crash - just log the error
});

// Test connection on startup (non-blocking)
pool.query('SELECT NOW()')
    .then(() => console.log('✅ Initial database connection successful'))
    .catch(err => console.error('❌ Initial database connection failed:', err.message));

// =====================================================
// INITIALIZE SAFETY TABLES ON STARTUP
// =====================================================
async function initializeSafetyTables() {
    try {
        // Customer reliability tracking
        await pool.query(`
            CREATE TABLE IF NOT EXISTS customer_reliability (
                phone_number VARCHAR(20) PRIMARY KEY,
                total_orders INT DEFAULT 0,
                completed_orders INT DEFAULT 0,
                cancelled_orders INT DEFAULT 0,
                no_show_orders INT DEFAULT 0,
                trust_score DECIMAL(3,2) DEFAULT 1.00,
                is_blocked BOOLEAN DEFAULT FALSE,
                last_order_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Fraud alerts
        await pool.query(`
            CREATE TABLE IF NOT EXISTS fraud_alerts (
                id SERIAL PRIMARY KEY,
                phone_number VARCHAR(20),
                alert_type VARCHAR(50),
                order_id INT,
                details TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        console.log('✅ Safety tables initialized');
    } catch (error) {
        console.error('❌ Error initializing safety tables:', error.message);
    }
}

// =====================================================
// TWILIO CLIENT
// =====================================================
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// =====================================================
// IN-MEMORY CACHE FOR PERFORMANCE
// =====================================================
let restaurantCache = {
    data: null,
    keywords: {},
    lastUpdated: null,
    ttl: 5 * 60 * 1000 // 5 minutes cache
};

// OTP Store for verification
const otpStore = new Map();

// Confirmation timeouts
const confirmationTimeouts = new Map();

// =====================================================
// SESSION STATES
// =====================================================
const STATES = {
    MAIN_MENU: 'main_menu',
    SELECT_RESTAURANT: 'select_restaurant',
    VIEW_MENU: 'view_menu',
    ORDER_DELIVERY: 'order_delivery',
    ADD_ITEMS: 'add_items',
    DELIVERY_ADDRESS: 'delivery_address',
    CONFIRM_ORDER: 'confirm_order',
    COD_CONFIRMATION: 'cod_confirmation',
    BOOK_TABLE: 'book_table',
    BOOKING_DATE: 'booking_date',
    BOOKING_TIME: 'booking_time',
    BOOKING_GUESTS: 'booking_guests',
    BOOKING_NAME: 'booking_name',
    CONFIRM_BOOKING: 'confirm_booking'
};

// =====================================================
// CUSTOMER RELIABILITY FUNCTIONS
// =====================================================

// Check customer reliability and trust score
async function checkCustomerReliability(phoneNumber) {
    try {
        const result = await pool.query(
            'SELECT * FROM customer_reliability WHERE phone_number = $1',
            [phoneNumber]
        );

        if (result.rows.length === 0) {
            // New customer - create record
            await pool.query(
                'INSERT INTO customer_reliability (phone_number, trust_score) VALUES ($1, 1.0)',
                [phoneNumber]
            );
            return {
                isNew: true,
                isBlocked: false,
                trustScore: 1.0,
                totalOrders: 0,
                completedOrders: 0,
                completionRate: 0,
                redFlags: []
            };
        }

        const data = result.rows[0];
        
        // Calculate rates
        const completionRate = data.total_orders > 0 ? data.completed_orders / data.total_orders : 0;
        const cancelRate = data.total_orders > 0 ? data.cancelled_orders / data.total_orders : 0;
        const noShowRate = data.total_orders > 0 ? data.no_show_orders / data.total_orders : 0;

        // Identify red flags
        const redFlags = [];
        if (cancelRate > 0.5) redFlags.push('High cancellation rate');
        if (noShowRate > 0.3) redFlags.push('Multiple no-shows');
        if (data.total_orders > 10 && completionRate < 0.3) redFlags.push('Low completion rate');

        // Auto-block criteria
        const shouldBlock = (
            data.is_blocked ||
            (cancelRate > 0.7 && data.total_orders > 3) ||
            (noShowRate > 0.5 && data.total_orders > 2) ||
            data.no_show_orders >= 3
        );

        if (shouldBlock && !data.is_blocked) {
            await pool.query(
                'UPDATE customer_reliability SET is_blocked = TRUE, updated_at = NOW() WHERE phone_number = $1',
                [phoneNumber]
            );

            await pool.query(
                'INSERT INTO fraud_alerts (phone_number, alert_type, details) VALUES ($1, $2, $3)',
                [phoneNumber, 'AUTO_BLOCKED', `Cancel rate: ${(cancelRate * 100).toFixed(0)}%, No-shows: ${data.no_show_orders}`]
            );
        }

        return {
            isNew: false,
            isBlocked: shouldBlock,
            trustScore: data.trust_score,
            totalOrders: data.total_orders,
            completedOrders: data.completed_orders,
            completionRate: completionRate,
            cancelRate: cancelRate,
            noShowRate: noShowRate,
            redFlags: redFlags
        };

    } catch (error) {
        console.error('❌ Error checking customer reliability:', error);
        return { isNew: true, isBlocked: false, trustScore: 1.0, totalOrders: 0 };
    }
}

// Update customer reliability after order outcome
async function updateCustomerReliability(phoneNumber, outcome) {
    // outcome: 'COMPLETED', 'CANCELLED', 'NO_SHOW'
    try {
        const existing = await pool.query(
            'SELECT * FROM customer_reliability WHERE phone_number = $1',
            [phoneNumber]
        );

        if (existing.rows.length === 0) {
            // Create new record
            await pool.query(`
                INSERT INTO customer_reliability 
                (phone_number, total_orders, completed_orders, cancelled_orders, no_show_orders, last_order_at)
                VALUES ($1, 1, $2, $3, $4, NOW())
            `, [
                phoneNumber,
                outcome === 'COMPLETED' ? 1 : 0,
                outcome === 'CANCELLED' ? 1 : 0,
                outcome === 'NO_SHOW' ? 1 : 0
            ]);
        } else {
            // Update existing
            let updateQuery = `
                UPDATE customer_reliability 
                SET total_orders = total_orders + 1,
                    last_order_at = NOW(),
                    updated_at = NOW()
            `;

            if (outcome === 'COMPLETED') {
                updateQuery += ', completed_orders = completed_orders + 1';
            } else if (outcome === 'CANCELLED') {
                updateQuery += ', cancelled_orders = cancelled_orders + 1';
            } else if (outcome === 'NO_SHOW') {
                updateQuery += ', no_show_orders = no_show_orders + 1';
            }

            updateQuery += ' WHERE phone_number = $1';
            await pool.query(updateQuery, [phoneNumber]);

            // Recalculate trust score
            const stats = await pool.query(
                'SELECT * FROM customer_reliability WHERE phone_number = $1',
                [phoneNumber]
            );

            const data = stats.rows[0];
            const completionRate = data.completed_orders / data.total_orders;
            const trustScore = Math.max(0.1, completionRate); // Minimum 0.1

            await pool.query(
                'UPDATE customer_reliability SET trust_score = $1 WHERE phone_number = $2',
                [trustScore, phoneNumber]
            );
        }

        console.log(`✅ Updated reliability for ${phoneNumber}: ${outcome}`);

    } catch (error) {
        console.error('❌ Error updating customer reliability:', error);
    }
}

// =====================================================
// SMART RESTAURANT LOADER - LOADS FROM DATABASE
// =====================================================
async function loadRestaurantsFromDatabase() {
    try {
        // Check cache first
        if (restaurantCache.data && 
            restaurantCache.lastUpdated &&
            (Date.now() - restaurantCache.lastUpdated) < restaurantCache.ttl) {
            console.log('📦 Using cached restaurant data');
            return restaurantCache;
        }

        console.log('🔄 Loading restaurants from database...');
        
        const result = await pool.query(`
            SELECT 
                id,
                name,
                cuisine_type,
                address,
                phone,
                whatsapp_number,
                qr_keyword,
                opening_time,
                closing_time,
                delivery_available,
                table_booking_available,
                min_delivery_amount,
                delivery_fee,
                notify_on_order,
                notify_on_booking,
                owner_name
            FROM restaurants
            WHERE (delivery_available = true OR table_booking_available = true)
            ORDER BY name
        `);

        const restaurants = result.rows;
        const keywords = {};

        // Build keyword map (case-insensitive)
        restaurants.forEach(restaurant => {
            if (restaurant.qr_keyword) {
                const keyword = restaurant.qr_keyword.toLowerCase();
                keywords[keyword] = restaurant.id;
                console.log(`✅ Mapped keyword: ${restaurant.qr_keyword} → ${restaurant.name} (ID: ${restaurant.id})`);
            }
        });

        // Update cache
        restaurantCache = {
            data: restaurants,
            keywords: keywords,
            lastUpdated: Date.now(),
            ttl: 5 * 60 * 1000
        };

        console.log(`✅ Loaded ${restaurants.length} restaurants with ${Object.keys(keywords).length} keywords`);
        return restaurantCache;

    } catch (error) {
        console.error('❌ Error loading restaurants:', error);
        // Return existing cache if available
        if (restaurantCache.data) {
            console.log('⚠️ Using stale cache due to error');
            return restaurantCache;
        }
        throw error;
    }
}

// =====================================================
// SEND WHATSAPP MESSAGE WITH RETRY LOGIC
// =====================================================
async function sendWhatsAppMessage(to, body, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const message = await twilioClient.messages.create({
                body: body,
                from: process.env.WABA_NUMBER,
                to: `whatsapp:${to}`
            });
            console.log(`✅ Message sent to ${to}: ${message.sid}`);
            return message;
        } catch (error) {
            console.error(`❌ Attempt ${attempt}/${retries} failed for ${to}:`, error.message);
            if (attempt === retries) {
                throw error;
            }
            // Wait before retry (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
}

// =====================================================
// ENHANCED OWNER NOTIFICATION WITH TRUST SCORES
// =====================================================
async function notifyRestaurantOwner(restaurantId, notificationType, data) {
    try {
        // Get restaurant details from database
        const restaurantResult = await pool.query(`
            SELECT 
                name, 
                whatsapp_number, 
                notify_on_order, 
                notify_on_booking,
                owner_name
            FROM restaurants 
            WHERE id = $1
        `, [restaurantId]);

        if (restaurantResult.rows.length === 0) {
            console.log(`⚠️ Restaurant ID ${restaurantId} not found`);
            return;
        }

        const restaurant = restaurantResult.rows[0];
        const ownerPhone = restaurant.whatsapp_number;

        if (!ownerPhone) {
            console.log(`⚠️ No WhatsApp number configured for ${restaurant.name}`);
            return;
        }

        // Check notification preferences
        if (notificationType === 'new_order' && !restaurant.notify_on_order) {
            console.log(`ℹ️ Order notifications disabled for ${restaurant.name}`);
            return;
        }

        if (notificationType === 'new_booking' && !restaurant.notify_on_booking) {
            console.log(`ℹ️ Booking notifications disabled for ${restaurant.name}`);
            return;
        }

        let message = '';

        if (notificationType === 'new_order') {
            // Get customer reliability
            const reliability = await checkCustomerReliability(data.customerPhone);

            // Risk indicator
            let riskEmoji = '🟢';
            let riskText = 'Trusted Customer';

            if (reliability.isNew) {
                riskEmoji = '🟡';
                riskText = 'New Customer - First Order';
            } else if (reliability.trustScore < 0.5) {
                riskEmoji = '🔴';
                riskText = 'High Risk - Previous Issues';
            } else if (reliability.trustScore < 0.7) {
                riskEmoji = '🟡';
                riskText = 'Medium Risk - Monitor Closely';
            }

            message = `🔔 *NEW ORDER #${data.orderId}*\n\n`;
            message += `${riskEmoji} *${riskText}*\n\n`;
            message += `🏪 Restaurant: ${restaurant.name}\n`;
            message += `📱 Customer Phone: ${data.customerPhone}\n`;
            message += `👤 Customer Name: ${data.customerName || 'Not provided'}\n`;
            message += `📍 Address: ${data.deliveryAddress}\n\n`;

            // Customer history (if not new)
            if (!reliability.isNew) {
                message += `👤 *Customer History:*\n`;
                message += `• Total Orders: ${reliability.totalOrders}\n`;
                message += `• Completed: ${reliability.completedOrders}\n`;
                message += `• Success Rate: ${(reliability.completionRate * 100).toFixed(0)}%\n`;
                message += `• Trust Score: ${(reliability.trustScore * 100).toFixed(0)}%\n\n`;
            }

            message += `*Items:*\n`;
            data.items.forEach(item => {
                message += `• ${item.quantity}× ${item.name} - ₹${(item.price * item.quantity).toFixed(2)}\n`;
            });
            message += `\n💰 *Total: ₹${data.total.toFixed(2)}*\n`;
            message += `💵 *Payment: CASH ON DELIVERY*\n`;

            if (data.specialInstructions) {
                message += `\n📝 *Special Instructions:*\n${data.specialInstructions}\n`;
            }
            message += `\n⏰ Order Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n`;
            message += `\n✅ *Please confirm and prepare the order!*\n`;
            message += `\nExpected delivery: 30-45 minutes from now\n`;
            message += `\n---\nPowered by Legacylens Automation\nSupport: +91 8013610018`;

        } else if (notificationType === 'new_booking') {
            message = `📅 *NEW TABLE BOOKING #${data.bookingId}*\n\n`;
            message += `🏪 Restaurant: ${restaurant.name}\n`;
            message += `👤 Name: ${data.customerName}\n`;
            message += `📱 Phone: ${data.customerPhone}\n`;
            message += `📅 Date: ${data.bookingDate}\n`;
            message += `⏰ Time: ${data.bookingTime}\n`;
            message += `👥 Guests: ${data.numberOfGuests}\n`;
            if (data.specialRequests) {
                message += `\n📝 Requests: ${data.specialRequests}\n`;
            }
            message += `\n⏰ Booked at: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n`;
            message += `\n✅ Please confirm table availability!`;
        }

        await sendWhatsAppMessage(ownerPhone, message);
        console.log(`✅ Notification sent to ${restaurant.name} owner at ${ownerPhone}`);

    } catch (error) {
        console.error(`❌ Failed to notify owner for restaurant ${restaurantId}:`, error.message);
    }
}

// =====================================================
// SMART TIME PARSER - HANDLES MULTIPLE FORMATS
// =====================================================
function parseFlexibleTime(timeString) {
    const input = timeString.trim().toUpperCase();
    
    // Pattern 1: "8PM", "8 PM", "8pm"
    const pattern1 = input.match(/^(\d{1,2})\s*(AM|PM)$/);
    if (pattern1) {
        let hour = parseInt(pattern1[1]);
        const meridiem = pattern1[2];
        
        if (hour < 1 || hour > 12) {
            return null;
        }
        
        if (meridiem === 'PM' && hour !== 12) {
            hour += 12;
        } else if (meridiem === 'AM' && hour === 12) {
            hour = 0;
        }
        
        return `${hour.toString().padStart(2, '0')}:00`;
    }
    
    // Pattern 2: "8:30PM", "8:30 PM", "8:30pm"
    const pattern2 = input.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
    if (pattern2) {
        let hour = parseInt(pattern2[1]);
        const minute = parseInt(pattern2[2]);
        const meridiem = pattern2[3];
        
        if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
            return null;
        }
        
        if (meridiem === 'PM' && hour !== 12) {
            hour += 12;
        } else if (meridiem === 'AM' && hour === 12) {
            hour = 0;
        }
        
        return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    }
    
    // Pattern 3: "20:00", "08:30" (24-hour format)
    const pattern3 = input.match(/^(\d{1,2}):(\d{2})$/);
    if (pattern3) {
        const hour = parseInt(pattern3[1]);
        const minute = parseInt(pattern3[2]);
        
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            return null;
        }
        
        return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    }
    
    // Pattern 4: "8", "20" (just hour, no minutes)
    const pattern4 = input.match(/^(\d{1,2})$/);
    if (pattern4) {
        const hour = parseInt(pattern4[1]);
        
        if (hour < 0 || hour > 23) {
            return null;
        }
        
        return `${hour.toString().padStart(2, '0')}:00`;
    }
    
    return null;
}

// =====================================================
// SMART DATE PARSER - HANDLES MULTIPLE FORMATS
// =====================================================
function parseFlexibleDate(dateString) {
    const input = dateString.trim().toLowerCase();
    const today = new Date();
    
    // Pattern 1: "today", "tomorrow"
    if (input === 'today') {
        const year = today.getFullYear();
        const month = (today.getMonth() + 1).toString().padStart(2, '0');
        const day = today.getDate().toString().padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    
    if (input === 'tomorrow') {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const year = tomorrow.getFullYear();
        const month = (tomorrow.getMonth() + 1).toString().padStart(2, '0');
        const day = tomorrow.getDate().toString().padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    
    // Pattern 2: "DD-MM-YYYY", "DD/MM/YYYY", "DD.MM.YYYY"
    const pattern1 = input.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
    if (pattern1) {
        const day = parseInt(pattern1[1]);
        const month = parseInt(pattern1[2]);
        const year = parseInt(pattern1[3]);
        
        if (day < 1 || day > 31 || month < 1 || month > 12 || year < 2024 || year > 2030) {
            return null;
        }
        
        return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    }
    
    // Pattern 3: "DD-MM", "DD/MM" (assume current year)
    const pattern2 = input.match(/^(\d{1,2})[-\/.](\d{1,2})$/);
    if (pattern2) {
        const day = parseInt(pattern2[1]);
        const month = parseInt(pattern2[2]);
        const year = today.getFullYear();
        
        if (day < 1 || day > 31 || month < 1 || month > 12) {
            return null;
        }
        
        return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    }
    
    return null;
}

// =====================================================
// SESSION MANAGEMENT
// =====================================================
async function getUserSession(phoneNumber) {
    try {
        const result = await pool.query(
            'SELECT * FROM user_sessions WHERE phone_number = $1',
            [phoneNumber]
        );

        if (result.rows.length === 0) {
            const newSession = await pool.query(
                `INSERT INTO user_sessions (phone_number, current_state, session_data) 
                 VALUES ($1, $2, $3) RETURNING *`,
                [phoneNumber, STATES.MAIN_MENU, JSON.stringify({})]
            );
            return newSession.rows[0];
        }

        return result.rows[0];
    } catch (error) {
        console.error('❌ Error getting user session:', error);
        throw error;
    }
}

async function updateUserSession(phoneNumber, state, data = null) {
    try {
        const updates = ['current_state = $2', 'last_activity = CURRENT_TIMESTAMP'];
        const params = [phoneNumber, state];

        if (data !== null) {
            updates.push('session_data = $3');
            params.push(JSON.stringify(data));
        }

        const query = `UPDATE user_sessions SET ${updates.join(', ')} WHERE phone_number = $1 RETURNING *`;
        const result = await pool.query(query, params);
        return result.rows[0];
    } catch (error) {
        console.error('❌ Error updating user session:', error);
        throw error;
    }
}

function getSessionData(session) {
    try {
        return typeof session.session_data === 'string' 
            ? JSON.parse(session.session_data) 
            : session.session_data;
    } catch (error) {
        console.error('❌ Error parsing session data:', error);
        return {};
    }
}

// =====================================================
// SMART KEYWORD DETECTION - LOADS FROM DATABASE
// =====================================================
async function detectRestaurantFromKeyword(message) {
    try {
        const restaurantData = await loadRestaurantsFromDatabase();
        const keyword = message.replace(/\s+/g, '').toLowerCase();

        const restaurantId = restaurantData.keywords[keyword];
        
        if (restaurantId) {
            const restaurant = restaurantData.data.find(r => r.id === restaurantId);
            console.log(`✅ Keyword detected: ${keyword} → ${restaurant.name}`);
            return restaurant;
        }

        return null;
    } catch (error) {
        console.error('❌ Error detecting keyword:', error);
        return null;
    }
}

// =====================================================
// MENU FUNCTIONS
// =====================================================
function getMainMenuMessage() {
    return `🍽️ *Welcome to Restaurant Bot!*

Please scan a restaurant QR code to start ordering or booking a table.

If you need help, contact: +91 8013610018`;
}

async function getRestaurantMenu(restaurantId) {
    try {
        const restaurantResult = await pool.query(
            'SELECT * FROM restaurants WHERE id = $1',
            [restaurantId]
        );

        if (restaurantResult.rows.length === 0) {
            return { message: '❌ Restaurant not found', menuItems: [] };
        }

        const restaurant = restaurantResult.rows[0];

        const menuItems = await pool.query(
            `SELECT * FROM menu_items 
             WHERE restaurant_id = $1 AND is_available = true 
             ORDER BY category, name`,
            [restaurantId]
        );

        let message = `📋 *${restaurant.name} - Menu*\n\n`;

        // Group by category
        const categories = {};
        menuItems.rows.forEach(item => {
            const category = item.category || 'Other';
            if (!categories[category]) {
                categories[category] = [];
            }
            categories[category].push(item);
        });

        // Format menu
        for (const [category, items] of Object.entries(categories)) {
            message += `*${category.toUpperCase()}*\n`;
            items.forEach(item => {
                const vegSymbol = item.is_vegetarian ? '🟢' : '🔴';
                message += `${vegSymbol} ${item.id}. ${item.name} - ₹${parseFloat(item.price).toFixed(0)}\n`;
                if (item.description) {
                    message += `   _${item.description}_\n`;
                }
            });
            message += '\n';
        }

        return { message, menuItems: menuItems.rows, restaurant };
    } catch (error) {
        console.error('❌ Error getting restaurant menu:', error);
        return { 
            message: '❌ Sorry, unable to load menu. Please try again.', 
            menuItems: [] 
        };
    }
}

// =====================================================
// ORDER FUNCTIONS
// =====================================================
async function addOrderItem(sessionData, itemId, quantity) {
    try {
        if (!sessionData.cart) {
            sessionData.cart = [];
        }

        const menuItem = await pool.query(
            'SELECT * FROM menu_items WHERE id = $1 AND is_available = true',
            [itemId]
        );

        if (menuItem.rows.length === 0) {
            return { success: false, message: '❌ Invalid item ID or item unavailable. Please try again.' };
        }

        const item = menuItem.rows[0];
        const existingItemIndex = sessionData.cart.findIndex(i => i.id === itemId);

        if (existingItemIndex >= 0) {
            sessionData.cart[existingItemIndex].quantity += quantity;
        } else {
            sessionData.cart.push({
                id: itemId,
                name: item.name,
                price: parseFloat(item.price),
                quantity: quantity,
                category: item.category || 'Other',
                is_vegetarian: item.is_vegetarian || false
            });
        }

        return { success: true, sessionData };
    } catch (error) {
        console.error('❌ Error adding order item:', error);
        return { success: false, message: '❌ Error adding item to cart. Please try again.' };
    }
}

function getCartSummary(sessionData, deliveryFee = 0) {
    if (!sessionData.cart || sessionData.cart.length === 0) {
        return '🛒 Your cart is empty.';
    }

    let message = '🛒 *Your Cart:*\n\n';
    let subtotal = 0;

    sessionData.cart.forEach((item, index) => {
        const itemTotal = item.price * item.quantity;
        subtotal += itemTotal;
        message += `${index + 1}. ${item.name}\n`;
        message += `   Qty: ${item.quantity} × ₹${item.price.toFixed(0)} = ₹${itemTotal.toFixed(0)}\n\n`;
    });

    message += `Subtotal: ₹${subtotal.toFixed(0)}\n`;
    if (deliveryFee > 0) {
        message += `Delivery Fee: ₹${deliveryFee.toFixed(0)}\n`;
    }
    message += `*Total: ₹${(subtotal + deliveryFee).toFixed(0)}*`;

    return message;
}

// =====================================================
// COD CONFIRMATION WITH 10-MINUTE TIMEOUT
// =====================================================
async function requestCODConfirmation(phoneNumber, sessionData) {
    try {
        const restaurant = await pool.query(
            'SELECT * FROM restaurants WHERE id = $1',
            [sessionData.selectedRestaurant]
        );

        if (restaurant.rows.length === 0) {
            return null;
        }

        const deliveryFee = parseFloat(restaurant.rows[0].delivery_fee || 0);
        const subtotal = sessionData.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const total = subtotal + deliveryFee;

        // Format items list
        let itemsList = '';
        sessionData.cart.forEach(item => {
            itemsList += `${item.quantity}× ${item.name} - ₹${(item.price * item.quantity).toFixed(0)}\n`;
        });

        const confirmationMessage = `
📋 *CONFIRM YOUR ORDER*

🏪 ${restaurant.rows[0].name}

*Your Order:*
${itemsList}
💰 *Total: ₹${total.toFixed(0)}*
📍 Delivery: ${sessionData.deliveryAddress}

💵 *PAYMENT: CASH ON DELIVERY*

⚠️ *IMPORTANT - Please Read:*

By confirming, you agree to:
✅ Pay ₹${total.toFixed(0)} in CASH when food arrives
✅ Have EXACT change ready (helps delivery person)
✅ Be available at the delivery address
✅ Accept the order within 30-45 minutes

⚠️ Fake orders or no-shows may result in being blocked from the system.

---

Type *CONFIRM* to place your order
Type *CANCEL* to cancel

⏱️ You have 10 minutes to respond.`;

        await sendWhatsAppMessage(phoneNumber, confirmationMessage);

        // Store confirmation timestamp - 10 MINUTES
        sessionData.confirmationExpiry = Date.now() + (10 * 60 * 1000); // 10 minutes
        sessionData.awaitingCODConfirmation = true;

        // Set timeout to auto-cancel after 10 MINUTES
        const timeoutId = setTimeout(async () => {
            try {
                const session = await getUserSession(phoneNumber);
                const currentData = getSessionData(session);

                if (currentData.awaitingCODConfirmation && session.current_state === STATES.COD_CONFIRMATION) {
                    await updateCustomerReliability(phoneNumber, 'CANCELLED');
                    await sendWhatsAppMessage(phoneNumber,
                        '⏱️ Order confirmation expired. Your order has been cancelled.\n\nScan QR code to place order.');
                    await updateUserSession(phoneNumber, STATES.MAIN_MENU, {});
                }
            } catch (error) {
                console.error('❌ Timeout cleanup error:', error);
            }
        }, 10 * 60 * 1000); // 10 MINUTES

        confirmationTimeouts.set(phoneNumber, timeoutId);

        return { total, deliveryFee, subtotal };

    } catch (error) {
        console.error('❌ Error requesting COD confirmation:', error);
        return null;
    }
}

async function createOrder(phoneNumber, sessionData) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const restaurant = await client.query(
            'SELECT * FROM restaurants WHERE id = $1',
            [sessionData.selectedRestaurant]
        );

        if (restaurant.rows.length === 0) {
            throw new Error('Restaurant not found');
        }

        const deliveryFee = parseFloat(restaurant.rows[0].delivery_fee || 0);
        const subtotal = sessionData.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const total = subtotal + deliveryFee;

        const orderResult = await client.query(
            `INSERT INTO orders (customer_phone, customer_name, restaurant_id, order_type, 
             delivery_address, total_amount, delivery_fee, special_instructions, 
             payment_method, payment_status, status, estimated_delivery_time)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP + INTERVAL '45 minutes')
             RETURNING *`,
            [
                phoneNumber,
                sessionData.customerName || 'Customer',
                sessionData.selectedRestaurant,
                'delivery',
                sessionData.deliveryAddress,
                total,
                deliveryFee,
                sessionData.specialInstructions || null,
                'COD',
                'PENDING',
                'CONFIRMED'
            ]
        );

        const orderId = orderResult.rows[0].id;

        for (const item of sessionData.cart) {
            await client.query(
                `INSERT INTO order_items (order_id, menu_item_id, quantity, price, subtotal)
                 VALUES ($1, $2, $3, $4, $5)`,
                [orderId, item.id, item.quantity, item.price, item.price * item.quantity]
            );
        }

        await client.query('COMMIT');

        // Update customer reliability (async)
        updateCustomerReliability(phoneNumber, 'COMPLETED').catch(err => 
            console.error('⚠️ Reliability update failed:', err.message));

        // Send notification to owner (async)
        notifyRestaurantOwner(sessionData.selectedRestaurant, 'new_order', {
            orderId: orderId,
            customerPhone: phoneNumber,
            customerName: sessionData.customerName || 'Customer',
            deliveryAddress: sessionData.deliveryAddress,
            items: sessionData.cart,
            total: total,
            specialInstructions: sessionData.specialInstructions
        }).catch(err => console.error('⚠️ Owner notification failed:', err.message));

        // Log to Google Sheets (async)
        if (isConfigured()) {
            logOrderToSheets({
                orderId: orderId,
                dateTime: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                restaurantName: restaurant.rows[0].name,
                restaurantId: sessionData.selectedRestaurant,
                customerPhone: phoneNumber,
                customerName: sessionData.customerName || 'Customer',
                orderType: 'Delivery',
                deliveryAddress: sessionData.deliveryAddress,
                itemsOrdered: sessionData.cart.map(i => `${i.quantity}× ${i.name}`).join(', '),
                totalItems: sessionData.cart.reduce((sum, i) => sum + i.quantity, 0),
                subtotal: subtotal,
                deliveryFee: deliveryFee,
                totalAmount: total,
                specialInstructions: sessionData.specialInstructions || '',
                status: 'Confirmed',
                paymentStatus: 'Pending',
                estimatedDelivery: '45 minutes'
            }).catch(err => console.error('⚠️ Sheets logging failed:', err.message));
        }

        return { success: true, orderId, order: orderResult.rows[0], total, deliveryFee, subtotal };

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error creating order:', error);
        return { success: false, error };
    } finally {
        client.release();
    }
}

async function createBooking(phoneNumber, sessionData) {
    try {
        const result = await pool.query(
            `INSERT INTO table_bookings (customer_phone, customer_name, restaurant_id, 
             booking_date, booking_time, number_of_guests, special_requests, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
                phoneNumber,
                sessionData.customerName,
                sessionData.selectedRestaurant,
                sessionData.bookingDate,
                sessionData.bookingTime,
                sessionData.numberOfGuests,
                sessionData.specialRequests || null,
                'pending'
            ]
        );

        // Get restaurant details
        const restaurant = await pool.query(
            'SELECT name, address, phone FROM restaurants WHERE id = $1',
            [sessionData.selectedRestaurant]
        );

        // Send notification to owner (async)
        notifyRestaurantOwner(sessionData.selectedRestaurant, 'new_booking', {
            bookingId: result.rows[0].id,
            customerName: sessionData.customerName,
            customerPhone: phoneNumber,
            bookingDate: sessionData.bookingDate,
            bookingTime: sessionData.bookingTime,
            numberOfGuests: sessionData.numberOfGuests,
            specialRequests: sessionData.specialRequests
        }).catch(err => console.error('⚠️ Owner notification failed:', err.message));

        // Log to Google Sheets (async)
        if (isConfigured()) {
            logBookingToSheets({
                bookingId: result.rows[0].id,
                dateTime: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                restaurantName: restaurant.rows[0].name,
                restaurantId: sessionData.selectedRestaurant,
                customerPhone: phoneNumber,
                customerName: sessionData.customerName,
                bookingDate: sessionData.bookingDate,
                bookingTime: sessionData.bookingTime,
                numberOfGuests: sessionData.numberOfGuests,
                specialRequests: sessionData.specialRequests || '',
                status: 'pending'
            }).catch(err => console.error('⚠️ Sheets logging failed:', err.message));
        }

        return { success: true, bookingId: result.rows[0].id, booking: result.rows[0] };
    } catch (error) {
        console.error('❌ Error creating booking:', error);
        return { success: false, error };
    }
}

// =====================================================
// MAIN MESSAGE HANDLER - WITH UPDATED QR FLOW
// =====================================================
async function handleIncomingMessage(from, body) {
    const phoneNumber = from.replace('whatsapp:', '');
    const message = body.trim();
    const messageLower = message.toLowerCase();

    try {
        const session = await getUserSession(phoneNumber);
        const sessionData = getSessionData(session);

        let responseMessage = '';
        let newState = session.current_state;
        let updatedData = { ...sessionData };

        // =====================================================
        // HANDLE COD CONFIRMATION STATE
        // =====================================================
        if (session.current_state === STATES.COD_CONFIRMATION) {
            const response = message.toUpperCase();

            // Check expiry
            if (Date.now() > (sessionData.confirmationExpiry || 0)) {
                await updateCustomerReliability(phoneNumber, 'CANCELLED');
                responseMessage = '⏱️ Confirmation expired. Order cancelled.\n\nScan QR code to place order.';
                newState = STATES.MAIN_MENU;
                updatedData = {};
                
                // Clear timeout
                if (confirmationTimeouts.has(phoneNumber)) {
                    clearTimeout(confirmationTimeouts.get(phoneNumber));
                    confirmationTimeouts.delete(phoneNumber);
                }
            }
            else if (response === 'CONFIRM') {
                // Check if customer is blocked
                const reliability = await checkCustomerReliability(phoneNumber);

                if (reliability.isBlocked) {
                    responseMessage = `❌ Sorry, you cannot place orders at this time.\n\n*Reason:* Multiple cancelled/no-show orders.\n\nContact support: +91 8013610018\n\nScan QR code to try again.`;
                    newState = STATES.MAIN_MENU;
                    updatedData = {};
                } else {
                    // Create order
                    const orderResult = await createOrder(phoneNumber, sessionData);

                    if (orderResult.success) {
                        const restaurant = await pool.query(
                            'SELECT name FROM restaurants WHERE id = $1',
                            [sessionData.selectedRestaurant]
                        );

                        responseMessage = '🎉 *Order Confirmed!*\n\n';
                        responseMessage += `Order ID: #${orderResult.orderId}\n`;
                        responseMessage += `Restaurant: ${restaurant.rows[0].name}\n\n`;
                        responseMessage += getCartSummary(sessionData, orderResult.deliveryFee);
                        responseMessage += `\n\n📍 Delivery Address:\n${sessionData.deliveryAddress}\n`;
                        if (sessionData.specialInstructions) {
                            responseMessage += `\n📝 Instructions: ${sessionData.specialInstructions}\n`;
                        }
                        responseMessage += `\n💵 Payment: Cash on Delivery\n`;
                        responseMessage += `💰 Total: ₹${orderResult.total.toFixed(0)}\n`;
                        responseMessage += `\n⏱️ Estimated Delivery: 45 minutes\n`;
                        responseMessage += `\nThe restaurant has been notified and is preparing your food.\n`;
                        responseMessage += `\nThank you for your order! 🍽️\n\n`;
                        responseMessage += 'Scan QR code to place another order.';

                        newState = STATES.MAIN_MENU;
                        updatedData = {};
                    } else {
                        responseMessage = '❌ Sorry, there was an error processing your order.\n\nContact support: +91 8013610018\n\nScan QR code to try again.';
                        newState = STATES.MAIN_MENU;
                        updatedData = {};
                    }
                }

                // Clear timeout
                if (confirmationTimeouts.has(phoneNumber)) {
                    clearTimeout(confirmationTimeouts.get(phoneNumber));
                    confirmationTimeouts.delete(phoneNumber);
                }
            }
            else if (response === 'CANCEL') {
                await updateCustomerReliability(phoneNumber, 'CANCELLED');
                responseMessage = '❌ Order cancelled. Feel free to order again anytime!\n\nScan QR code to place order.';
                newState = STATES.MAIN_MENU;
                updatedData = {};

                // Clear timeout
                if (confirmationTimeouts.has(phoneNumber)) {
                    clearTimeout(confirmationTimeouts.get(phoneNumber));
                    confirmationTimeouts.delete(phoneNumber);
                }
            }
            else {
                const timeLeft = Math.floor(((sessionData.confirmationExpiry || 0) - Date.now()) / 1000);
                if (timeLeft > 0) {
                    const minutesLeft = Math.floor(timeLeft / 60);
                    const secondsLeft = timeLeft % 60;
                    responseMessage = `Please reply with *CONFIRM* or *CANCEL*\n\nTime remaining: ${minutesLeft}m ${secondsLeft}s`;
                } else {
                    responseMessage = '⏱️ Confirmation expired. Please start over.\n\nScan QR code to place order.';
                    newState = STATES.MAIN_MENU;
                    updatedData = {};
                }
            }

            await updateUserSession(phoneNumber, newState, updatedData);
            return responseMessage;
        }

        // =====================================================
        // SMART QR KEYWORD DETECTION - SHOWS DELIVERY/BOOKING OPTIONS
        // =====================================================
        const detectedRestaurant = await detectRestaurantFromKeyword(message);
        
        if (detectedRestaurant && !sessionData.selectedRestaurant) {
            // Check if customer is blocked
            const reliability = await checkCustomerReliability(phoneNumber);

            if (reliability.isBlocked) {
                return `❌ Sorry, you cannot place orders at this time.\n\n*Reason:* Multiple cancelled/no-show orders.\n\nContact support: +91 8013610018\n\nScan QR code to try again.`;
            }

            updatedData.selectedRestaurant = detectedRestaurant.id;
            updatedData.restaurantName = detectedRestaurant.name;

            // Show restaurant-specific menu with delivery and booking options
            responseMessage = `🎉 *Welcome to ${detectedRestaurant.name}!*\n\n`;
            responseMessage += `What would you like to do?\n\n`;
            
            if (detectedRestaurant.delivery_available && detectedRestaurant.table_booking_available) {
                responseMessage += `1️⃣ Order Delivery\n`;
                responseMessage += `2️⃣ Book a Table\n\n`;
                responseMessage += `Reply with 1 or 2`;
            } else if (detectedRestaurant.delivery_available) {
                responseMessage += `1️⃣ Order Delivery\n\n`;
                responseMessage += `Reply with 1 to start ordering`;
            } else if (detectedRestaurant.table_booking_available) {
                responseMessage += `2️⃣ Book a Table\n\n`;
                responseMessage += `Reply with 2 to book a table`;
            } else {
                responseMessage = `⚠️ Service temporarily unavailable at ${detectedRestaurant.name}.\n\nPlease contact: ${detectedRestaurant.phone || 'restaurant directly'}`;
                await updateUserSession(phoneNumber, STATES.MAIN_MENU, {});
                return responseMessage;
            }

            newState = STATES.SELECT_RESTAURANT;
            await updateUserSession(phoneNumber, newState, updatedData);
            return responseMessage;
        }

        // Handle menu/restart commands
        if (messageLower === 'menu' || messageLower === 'restart' || messageLower === 'start') {
            responseMessage = getMainMenuMessage();
            newState = STATES.MAIN_MENU;
            updatedData = {};
        }
        // Main menu - only accessible if someone types "menu" (not through QR)
        else if (session.current_state === STATES.MAIN_MENU) {
            // No options - just tell them to scan QR code
            responseMessage = getMainMenuMessage();
        }
        // Restaurant selection - handles delivery/booking choice from QR flow
        else if (session.current_state === STATES.SELECT_RESTAURANT) {
            const choice = message.trim();

            // Get current selected restaurant
            if (!sessionData.selectedRestaurant) {
                responseMessage = '❌ No restaurant selected.\n\nScan QR code to start.';
                newState = STATES.MAIN_MENU;
            }
            else if (choice === '1') {
                // Order Delivery
                const restaurant = await pool.query(
                    'SELECT * FROM restaurants WHERE id = $1',
                    [sessionData.selectedRestaurant]
                );

                if (restaurant.rows.length === 0) {
                    responseMessage = '❌ Restaurant not found.\n\nScan QR code to try again.';
                    newState = STATES.MAIN_MENU;
                    updatedData = {};
                }
                else if (!restaurant.rows[0].delivery_available) {
                    responseMessage = '❌ Sorry, delivery is not available at this restaurant.\n\nScan QR code to try another restaurant.';
                    newState = STATES.MAIN_MENU;
                    updatedData = {};
                }
                else {
                    const menuData = await getRestaurantMenu(sessionData.selectedRestaurant);
                    responseMessage = menuData.message;
                    responseMessage += '\n\n*To order:*\n';
                    responseMessage += 'Type item ID and quantity (e.g., "15 2")\n';
                    responseMessage += 'Type "done" when finished\n';
                    responseMessage += 'Type "cart" to view cart';
                    newState = STATES.ADD_ITEMS;
                    updatedData.cart = [];
                    updatedData.action = 'delivery';
                }
            }
            else if (choice === '2') {
                // Book a Table
                const restaurant = await pool.query(
                    'SELECT * FROM restaurants WHERE id = $1',
                    [sessionData.selectedRestaurant]
                );

                if (restaurant.rows.length === 0) {
                    responseMessage = '❌ Restaurant not found.\n\nScan QR code to try again.';
                    newState = STATES.MAIN_MENU;
                    updatedData = {};
                }
                else if (!restaurant.rows[0].table_booking_available) {
                    responseMessage = '❌ Sorry, table booking is not available at this restaurant.\n\nScan QR code to try another restaurant.';
                    newState = STATES.MAIN_MENU;
                    updatedData = {};
                }
                else {
                    responseMessage = `📅 *Table Booking at ${restaurant.rows[0].name}*\n\n`;
                    responseMessage += 'Please enter the date for your booking\n\n';
                    responseMessage += 'Examples:\n';
                    responseMessage += '• Today\n';
                    responseMessage += '• Tomorrow\n';
                    responseMessage += '• 25-01-2026\n';
                    responseMessage += '• 25/01 (this year)';
                    newState = STATES.BOOKING_DATE;
                    updatedData.action = 'booking';
                }
            }
            else {
                responseMessage = '❌ Invalid choice.\n\nPlease reply with:\n1️⃣ for Order Delivery\n2️⃣ for Book a Table';
            }
        }
        // Add items to cart
        else if (session.current_state === STATES.ADD_ITEMS) {
            if (messageLower === 'done') {
                if (!sessionData.cart || sessionData.cart.length === 0) {
                    responseMessage = '❌ Your cart is empty. Please add items before proceeding.';
                } else {
                    const restaurant = await pool.query(
                        'SELECT delivery_fee, min_delivery_amount FROM restaurants WHERE id = $1',
                        [sessionData.selectedRestaurant]
                    );
                    const deliveryFee = parseFloat(restaurant.rows[0].delivery_fee || 0);
                    const minAmount = parseFloat(restaurant.rows[0].min_delivery_amount || 0);
                    const subtotal = sessionData.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

                    if (subtotal < minAmount) {
                        responseMessage = `❌ Minimum order amount is ₹${minAmount}. Your cart total is ₹${subtotal}.\n\n`;
                        responseMessage += 'Please add more items or scan QR code to cancel.';
                    } else {
                        responseMessage = getCartSummary(sessionData, deliveryFee);
                        responseMessage += '\n\n📍 Please enter your delivery address:';
                        newState = STATES.DELIVERY_ADDRESS;
                    }
                }
            } else if (messageLower === 'cart') {
                const restaurant = await pool.query(
                    'SELECT delivery_fee FROM restaurants WHERE id = $1',
                    [sessionData.selectedRestaurant]
                );
                const deliveryFee = parseFloat(restaurant.rows[0].delivery_fee || 0);
                responseMessage = getCartSummary(sessionData, deliveryFee);
                responseMessage += '\n\nContinue adding items or type "done" to proceed.';
            } else {
                const parts = message.split(' ');
                if (parts.length === 2) {
                    const itemId = parseInt(parts[0]);
                    const quantity = parseInt(parts[1]);

                    if (!isNaN(itemId) && !isNaN(quantity) && quantity > 0) {
                        const result = await addOrderItem(sessionData, itemId, quantity);
                        if (result.success) {
                            updatedData = result.sessionData;
                            const restaurant = await pool.query(
                                'SELECT delivery_fee FROM restaurants WHERE id = $1',
                                [sessionData.selectedRestaurant]
                            );
                            const deliveryFee = parseFloat(restaurant.rows[0].delivery_fee || 0);
                            responseMessage = `✅ Added to cart!\n\n`;
                            responseMessage += getCartSummary(updatedData, deliveryFee);
                            responseMessage += '\n\nAdd more items or type "done" to proceed.';
                        } else {
                            responseMessage = result.message;
                        }
                    } else {
                        responseMessage = '❌ Invalid format. Use: item_id quantity (e.g., "15 2")';
                    }
                } else {
                    responseMessage = '❌ Invalid format. Use: item_id quantity (e.g., "15 2")';
                }
            }
        }
        // Delivery address
        else if (session.current_state === STATES.DELIVERY_ADDRESS) {
            updatedData.deliveryAddress = body.trim();
            responseMessage = '✅ Address saved!\n\n';
            responseMessage += 'Any special instructions? (Type "no" if none)';
            newState = STATES.CONFIRM_ORDER;
        }
        // Special instructions -> COD Confirmation
        else if (session.current_state === STATES.CONFIRM_ORDER) {
            if (messageLower !== 'no') {
                updatedData.specialInstructions = body.trim();
            }

            // Request COD confirmation
            const confirmResult = await requestCODConfirmation(phoneNumber, sessionData);

            if (confirmResult) {
                newState = STATES.COD_CONFIRMATION;
                // responseMessage already sent in requestCODConfirmation
                responseMessage = ''; // Prevent double message
            } else {
                responseMessage = '❌ Error preparing order confirmation.\n\nContact support: +91 8013610018\n\nScan QR code to try again.';
                newState = STATES.MAIN_MENU;
                updatedData = {};
            }
        }
        // Booking date
        else if (session.current_state === STATES.BOOKING_DATE) {
            const parsedDate = parseFlexibleDate(message);
            if (parsedDate) {
                updatedData.bookingDate = parsedDate;
                responseMessage = '⏰ *Booking Time*\n\n';
                responseMessage += 'Please enter the time for your booking\n';
                responseMessage += 'Examples: 8PM, 8:30PM, 20:00';
                newState = STATES.BOOKING_TIME;
            } else {
                responseMessage = '❌ Invalid date format.\n\n';
                responseMessage += 'Please try:\n';
                responseMessage += '• Today or Tomorrow\n';
                responseMessage += '• 25-01-2026\n';
                responseMessage += '• 25/01/2026\n';
                responseMessage += '• 25-01 (this year)';
            }
        }
        // Booking time
        else if (session.current_state === STATES.BOOKING_TIME) {
            const parsedTime = parseFlexibleTime(message);
            if (parsedTime) {
                updatedData.bookingTime = parsedTime;
                responseMessage = '👥 *Number of Guests*\n\n';
                responseMessage += 'How many people will be dining?';
                newState = STATES.BOOKING_GUESTS;
            } else {
                responseMessage = '❌ Invalid time format.\n\n';
                responseMessage += 'Please try:\n';
                responseMessage += '• 8PM or 8:30PM\n';
                responseMessage += '• 20:00 or 20:30\n';
                responseMessage += '• 8 PM or 8:30 PM';
            }
        }
        // Number of guests
        else if (session.current_state === STATES.BOOKING_GUESTS) {
            const guests = parseInt(message);
            if (!isNaN(guests) && guests > 0) {
                updatedData.numberOfGuests = guests;
                responseMessage = '👤 *Your Name*\n\n';
                responseMessage += 'Please enter your name for the booking:';
                newState = STATES.BOOKING_NAME;
            } else {
                responseMessage = '❌ Please enter a valid number of guests.';
            }
        }
        // Booking name
        else if (session.current_state === STATES.BOOKING_NAME) {
            updatedData.customerName = body.trim();
            responseMessage = '📝 Any special requests? (Type "no" if none)';
            newState = STATES.CONFIRM_BOOKING;
        }
        // Confirm booking
        else if (session.current_state === STATES.CONFIRM_BOOKING) {
            if (messageLower !== 'no') {
                updatedData.specialRequests = body.trim();
            }

            const bookingResult = await createBooking(phoneNumber, sessionData);

            if (bookingResult.success) {
                const restaurant = await pool.query(
                    'SELECT name FROM restaurants WHERE id = $1',
                    [sessionData.selectedRestaurant]
                );

                responseMessage = '🎉 *Table Booking Confirmed!*\n\n';
                responseMessage += `Booking ID: #${bookingResult.bookingId}\n`;
                responseMessage += `Restaurant: ${restaurant.rows[0].name}\n`;
                responseMessage += `Date: ${sessionData.bookingDate}\n`;
                responseMessage += `Time: ${sessionData.bookingTime}\n`;
                responseMessage += `Guests: ${sessionData.numberOfGuests}\n`;
                responseMessage += `Name: ${sessionData.customerName}\n`;
                if (sessionData.specialRequests) {
                    responseMessage += `Special Requests: ${sessionData.specialRequests}\n`;
                }
                responseMessage += '\nWe look forward to serving you!\n\n';
                responseMessage += 'Scan QR code to place order.';

                newState = STATES.MAIN_MENU;
                updatedData = {};
            } else {
                responseMessage = '❌ Sorry, there was an error processing your booking.\n\nContact support: +91 8013610018\n\nScan QR code to try again.';
            }
        }

        await updateUserSession(phoneNumber, newState, updatedData);
        return responseMessage;

    } catch (error) {
        console.error('❌ Error handling message:', error);
        return '❌ Sorry, something went wrong.\n\nScan QR code to place order.';
    }
}

// =====================================================
// WEBHOOK ENDPOINT
// =====================================================
app.post('/webhook', async (req, res) => {
    try {
        const from = req.body.From;
        const body = req.body.Body;

        console.log(`📨 Received message from ${from}: ${body}`);

        const response = await handleIncomingMessage(from, body);
        
        if (response) { // Only send if there's a response
            await sendWhatsAppMessage(from.replace('whatsapp:', ''), response);
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).send('Error');
    }
});

// =====================================================
// HEALTH CHECK & ADMIN ENDPOINTS
// =====================================================
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        const restaurantData = await loadRestaurantsFromDatabase();
        
        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            database: 'Connected',
            restaurants: restaurantData.data.length,
            keywords: Object.keys(restaurantData.keywords).length,
            googleSheets: isConfigured() ? 'Configured' : 'Not Configured',
            safetyFeatures: {
                customerReliabilityTracking: true,
                codConfirmation: true,
                codTimeout: '10 minutes',
                fraudDetection: true,
                autoBlocking: true
            },
            cache: {
                lastUpdated: restaurantData.lastUpdated ? new Date(restaurantData.lastUpdated).toISOString() : null,
                ttl: restaurantData.ttl / 1000 + 's'
            }
        });
    } catch (error) {
        res.status(500).json({
            status: 'ERROR',
            error: error.message
        });
    }
});

app.get('/restaurants', async (req, res) => {
    try {
        const restaurantData = await loadRestaurantsFromDatabase();
        res.json({
            success: true,
            count: restaurantData.data.length,
            restaurants: restaurantData.data,
            keywords: restaurantData.keywords
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post('/reload-cache', async (req, res) => {
    try {
        restaurantCache.lastUpdated = null; // Force reload
        const restaurantData = await loadRestaurantsFromDatabase();
        res.json({
            success: true,
            message: 'Cache reloaded successfully',
            restaurants: restaurantData.data.length,
            keywords: Object.keys(restaurantData.keywords).length
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/sheets-status', (req, res) => {
    const configured = isConfigured();
    res.json({
        configured: configured,
        spreadsheetUrl: configured ? getSpreadsheetUrl() : null,
        message: configured 
            ? 'Google Sheets integration is active' 
            : 'Google Sheets not configured - set GOOGLE_SHEET_ID in .env'
    });
});

// Customer reliability endpoint (for testing)
app.get('/customer-reliability/:phone', async (req, res) => {
    try {
        const phoneNumber = req.params.phone;
        const reliability = await checkCustomerReliability(phoneNumber);
        res.json(reliability);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =====================================================
// START SERVER - BULLETPROOF VERSION
// =====================================================
const PORT = process.env.PORT || 3000;

// Critical: Start HTTP server FIRST before any database operations
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 SERVER STARTED - Port ${PORT}`);
    console.log(`${'='.repeat(60)}\n`);
    console.log(`✅ HTTP Server: RUNNING`);
    console.log(`📱 Webhook: https://restaurant.legacylens.co.in/webhook`);
    console.log(`🏥 Health: https://restaurant.legacylens.co.in/health\n`);
});

// Keep server alive even if initialization fails
server.on('error', (error) => {
    console.error('❌ Server error:', error);
    if (error.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use`);
        process.exit(1);
    }
});

// Initialize features AFTER server is listening (async, non-blocking)
setImmediate(async () => {
    console.log('🔧 Starting feature initialization...\n');
    
    try {
        // Step 1: Test database
        console.log('1️⃣ Testing database connection...');
        try {
            await pool.query('SELECT NOW()');
            console.log('   ✅ Database: CONNECTED\n');
        } catch (dbError) {
            console.error('   ❌ Database: FAILED');
            console.error('   Error:', dbError.message);
            console.error('   ⚠️ Bot will work with limited functionality\n');
        }

        // Step 2: Initialize safety tables
        console.log('2️⃣ Initializing safety tables...');
        try {
            await initializeSafetyTables();
            console.log('   ✅ Safety tables: READY\n');
        } catch (error) {
            console.error('   ❌ Safety tables: FAILED');
            console.error('   Error:', error.message, '\n');
        }

        // Step 3: Load restaurants
        console.log('3️⃣ Loading restaurants...');
        try {
            const restaurantData = await loadRestaurantsFromDatabase();
            console.log(`   ✅ Loaded ${restaurantData.data.length} restaurants`);
            console.log(`   ✅ Active keywords: ${Object.keys(restaurantData.keywords).join(', ')}\n`);
            
            // Display configuration
            if (restaurantData.data.length > 0) {
                console.log('📋 Restaurant Details:\n');
                restaurantData.data.forEach(r => {
                    console.log(`   ${r.name}`);
                    console.log(`   ├─ Keyword: ${r.qr_keyword || 'Not set'}`);
                    console.log(`   ├─ WhatsApp: ${r.whatsapp_number || 'Not set'}`);
                    console.log(`   ├─ Delivery: ${r.delivery_available ? '✅' : '❌'}`);
                    console.log(`   └─ Booking: ${r.table_booking_available ? '✅' : '❌'}\n`);
                });
            }
        } catch (error) {
            console.error('   ❌ Restaurant loading: FAILED');
            console.error('   Error:', error.message, '\n');
        }

        // Step 4: Test Google Sheets (optional)
        console.log('4️⃣ Testing Google Sheets...');
        if (isConfigured()) {
            try {
                const connected = await testConnection();
                if (connected) {
                    console.log('   ✅ Google Sheets: CONNECTED');
                    console.log(`   📊 Sheet: ${getSpreadsheetUrl()}\n`);
                } else {
                    console.log('   ⚠️ Google Sheets: Test failed (optional)\n');
                }
            } catch (error) {
                console.log('   ⚠️ Google Sheets: SKIPPED (optional)\n');
            }
        } else {
            console.log('   ℹ️ Google Sheets: Not configured (optional)\n');
        }

        // Step 5: Verify Twilio
        console.log('5️⃣ Verifying Twilio credentials...');
        if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.WABA_NUMBER) {
            console.log('   ✅ Twilio: CONFIGURED\n');
        } else {
            console.error('   ❌ Twilio: Missing credentials');
            console.error('   ⚠️ WhatsApp messaging will not work\n');
        }

        // Final status
        console.log('🔒 Safety Features:');
        console.log('   ✅ Customer reliability tracking');
        console.log('   ✅ COD confirmation (10-min timeout)');
        console.log('   ✅ Fraud detection & auto-blocking');
        console.log('   ✅ Trust score system');
        console.log('   ✅ QR code-only access\n');
        
        console.log(`${'='.repeat(60)}`);
        console.log('✅ INITIALIZATION COMPLETE');
        console.log('🎉 Bot is ready to receive messages!');
        console.log(`${'='.repeat(60)}\n`);

    } catch (error) {
        console.error('\n⚠️ INITIALIZATION ERROR:', error.message);
        console.log('⚠️ Server is running but some features may be limited');
        console.log('⚠️ Check environment variables and database connection\n');
    }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('\n⚠️ SIGTERM received, shutting down gracefully...');
    server.close(async () => {
        console.log('✅ HTTP server closed');
        try {
            await pool.end();
            console.log('✅ Database connections closed');
        } catch (error) {
            console.error('❌ Error closing database:', error.message);
        }
        process.exit(0);
    });
    
    // Force close after 10 seconds
    setTimeout(() => {
        console.error('❌ Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
});

process.on('SIGINT', async () => {
    console.log('\n⚠️ SIGINT received, shutting down gracefully...');
    server.close(async () => {
        console.log('✅ HTTP server closed');
        try {
            await pool.end();
            console.log('✅ Database connections closed');
        } catch (error) {
            console.error('❌ Error closing database:', error.message);
        }
        process.exit(0);
    });
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('\n❌ UNCAUGHT EXCEPTION:', error);
    console.error('Stack:', error.stack);
    // Don't exit - let the server continue running
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('\n❌ UNHANDLED REJECTION at:', promise);
    console.error('Reason:', reason);
    // Don't exit - let the server continue running
});
