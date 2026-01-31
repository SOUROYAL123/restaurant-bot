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
const {
    createPaymentLink,
    verifyPayment,
    handlePaymentWebhook,
    getPaymentMessage
} = require('./features/payment');
const { FEATURES } = require('./features/config');

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
    connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
    console.error('💥 Unexpected database error:', err.message);
});

pool.query('SELECT NOW()')
    .then(() => console.log('✅ Initial database connection successful'))
    .catch(err => console.error('❌ Initial database connection failed:', err.message));

// =====================================================
// INITIALIZE SAFETY TABLES ON STARTUP
// =====================================================
async function initializeSafetyTables() {
    try {
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
    ttl: 5 * 60 * 1000
};

const otpStore = new Map();
const confirmationTimeouts = new Map();
const paymentTimeouts = new Map();

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
    PAYMENT_METHOD: 'payment_method',           // NEW
    AWAITING_PAYMENT: 'awaiting_payment',       // NEW
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
async function checkCustomerReliability(phoneNumber) {
    try {
        const result = await pool.query(
            'SELECT * FROM customer_reliability WHERE phone_number = $1',
            [phoneNumber]
        );

        if (result.rows.length === 0) {
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
        const completionRate = data.total_orders > 0 ? data.completed_orders / data.total_orders : 0;
        const cancelRate = data.total_orders > 0 ? data.cancelled_orders / data.total_orders : 0;
        const noShowRate = data.total_orders > 0 ? data.no_show_orders / data.total_orders : 0;

        const redFlags = [];
        if (cancelRate > 0.5) redFlags.push('High cancellation rate');
        if (noShowRate > 0.3) redFlags.push('Multiple no-shows');
        if (data.total_orders > 10 && completionRate < 0.3) redFlags.push('Low completion rate');

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

async function updateCustomerReliability(phoneNumber, outcome) {
    try {
        const existing = await pool.query(
            'SELECT * FROM customer_reliability WHERE phone_number = $1',
            [phoneNumber]
        );

        if (existing.rows.length === 0) {
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

            const stats = await pool.query(
                'SELECT * FROM customer_reliability WHERE phone_number = $1',
                [phoneNumber]
            );

            const data = stats.rows[0];
            const completionRate = data.completed_orders / data.total_orders;
            const trustScore = Math.max(0.1, completionRate);

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
// SMART RESTAURANT LOADER
// =====================================================
async function loadRestaurantsFromDatabase() {
    try {
        if (restaurantCache.data && 
            restaurantCache.lastUpdated &&
            (Date.now() - restaurantCache.lastUpdated) < restaurantCache.ttl) {
            console.log('📦 Using cached restaurant data');
            return restaurantCache;
        }

        console.log('🔄 Loading restaurants from database...');
        
        const result = await pool.query(`
            SELECT 
                id, name, cuisine_type, address, phone, whatsapp_number,
                qr_keyword, opening_time, closing_time, delivery_available,
                table_booking_available, min_delivery_amount, delivery_fee,
                notify_on_order, notify_on_booking, owner_name
            FROM restaurants
            WHERE (delivery_available = true OR table_booking_available = true)
            ORDER BY name
        `);

        const restaurants = result.rows;
        const keywords = {};

        restaurants.forEach(restaurant => {
            if (restaurant.qr_keyword) {
                const keyword = restaurant.qr_keyword.toLowerCase();
                keywords[keyword] = restaurant.id;
                console.log(`✅ Mapped keyword: ${restaurant.qr_keyword} → ${restaurant.name} (ID: ${restaurant.id})`);
            }
        });

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
        if (restaurantCache.data) {
            console.log('⚠️ Using stale cache due to error');
            return restaurantCache;
        }
        throw error;
    }
}

// =====================================================
// SEND WHATSAPP MESSAGE
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
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
}

// =====================================================
// ENHANCED OWNER NOTIFICATION WITH DETAILED LOGGING
// =====================================================
async function notifyRestaurantOwner(restaurantId, notificationType, data) {
    console.log('\n' + '='.repeat(70));
    console.log(`🔔 OWNER NOTIFICATION ATTEMPT`);
    console.log('='.repeat(70));
    console.log(`📊 Restaurant ID: ${restaurantId}`);
    console.log(`📊 Notification Type: ${notificationType}`);
    console.log(`📊 Timestamp: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    console.log('='.repeat(70));
    
    try {
        // Step 1: Query restaurant details
        console.log(`\n[STEP 1] Querying database for restaurant ID ${restaurantId}...`);
        const restaurantResult = await pool.query(`
            SELECT name, whatsapp_number, notify_on_order, notify_on_booking, owner_name
            FROM restaurants WHERE id = $1
        `, [restaurantId]);

        if (restaurantResult.rows.length === 0) {
            console.log(`❌ [FAIL] Restaurant ID ${restaurantId} not found in database`);
            console.log('='.repeat(70) + '\n');
            return;
        }

        const restaurant = restaurantResult.rows[0];
        console.log(`✅ [SUCCESS] Restaurant found: ${restaurant.name}`);
        console.log(`   ├─ Owner Name: ${restaurant.owner_name || 'Not set'}`);
        console.log(`   ├─ WhatsApp: ${restaurant.whatsapp_number || 'NOT SET'}`);
        console.log(`   ├─ Notify Orders: ${restaurant.notify_on_order ? '✅ ENABLED' : '❌ DISABLED'}`);
        console.log(`   └─ Notify Bookings: ${restaurant.notify_on_booking ? '✅ ENABLED' : '❌ DISABLED'}`);

        const ownerPhone = restaurant.whatsapp_number;

        // Step 2: Validate WhatsApp number
        console.log(`\n[STEP 2] Validating WhatsApp number...`);
        if (!ownerPhone) {
            console.log(`❌ [FAIL] No WhatsApp number configured for ${restaurant.name}`);
            console.log(`   └─ ACTION REQUIRED: Add whatsapp_number to database`);
            console.log('='.repeat(70) + '\n');
            return;
        }
        console.log(`✅ [VALID] WhatsApp number present: ${ownerPhone}`);

        // Step 3: Check notification preferences
        console.log(`\n[STEP 3] Checking notification preferences...`);
        if (notificationType === 'new_order' && !restaurant.notify_on_order) {
            console.log(`❌ [SKIP] Order notifications DISABLED for ${restaurant.name}`);
            console.log(`   └─ Database setting: notify_on_order = ${restaurant.notify_on_order}`);
            console.log('='.repeat(70) + '\n');
            return;
        }

        if (notificationType === 'new_booking' && !restaurant.notify_on_booking) {
            console.log(`❌ [SKIP] Booking notifications DISABLED for ${restaurant.name}`);
            console.log(`   └─ Database setting: notify_on_booking = ${restaurant.notify_on_booking}`);
            console.log('='.repeat(70) + '\n');
            return;
        }
        console.log(`✅ [ENABLED] Notifications are enabled for this type`);

        // Step 4: Prepare notification message
        console.log(`\n[STEP 4] Preparing notification message...`);
        let message = '';

        if (notificationType === 'new_order') {
            console.log(`   ├─ Getting customer reliability for ${data.customerPhone}...`);
            const reliability = await checkCustomerReliability(data.customerPhone);
            console.log(`   ├─ Customer Status: ${reliability.isNew ? 'NEW' : 'EXISTING'}`);
            console.log(`   ├─ Trust Score: ${(reliability.trustScore * 100).toFixed(0)}%`);
            console.log(`   └─ Is Blocked: ${reliability.isBlocked ? 'YES ⚠️' : 'NO ✅'}`);

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
            message += `💵 *Payment: ${data.paymentStatus === 'PAID' ? '✅ PAID ONLINE' : 'CASH ON DELIVERY'}*\n`;

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

        console.log(`✅ [SUCCESS] Message prepared`);
        console.log(`   ├─ Length: ${message.length} characters`);
        console.log(`   └─ Preview: ${message.substring(0, 80)}...`);

        // Step 5: Send WhatsApp message
        console.log(`\n[STEP 5] Sending WhatsApp message to ${ownerPhone}...`);
        console.log(`   ├─ From: ${process.env.WABA_NUMBER}`);
        console.log(`   ├─ To: whatsapp:${ownerPhone}`);
        console.log(`   └─ Attempting send...`);

        await sendWhatsAppMessage(ownerPhone, message);
        
        console.log(`\n${'🎉'.repeat(35)}`);
        console.log(`✅✅✅ NOTIFICATION SENT SUCCESSFULLY! ✅✅✅`);
        console.log(`${'🎉'.repeat(35)}`);
        console.log(`📱 Recipient: ${restaurant.name} owner`);
        console.log(`📞 WhatsApp: ${ownerPhone}`);
        console.log(`🕐 Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
        console.log('='.repeat(70) + '\n');

    } catch (error) {
        console.log(`\n${'❌'.repeat(35)}`);
        console.error(`❌ NOTIFICATION FAILED - CRITICAL ERROR`);
        console.log(`${'❌'.repeat(35)}`);
        console.error(`📊 Restaurant ID: ${restaurantId}`);
        console.error(`📊 Notification Type: ${notificationType}`);
        console.error(`❌ Error Message: ${error.message}`);
        console.error(`❌ Error Code: ${error.code || 'N/A'}`);
        console.error(`❌ Error Status: ${error.status || 'N/A'}`);
        console.error(`\n❌ Full Error Stack:`);
        console.error(error.stack);
        console.log('='.repeat(70) + '\n');
    }
}

// =====================================================
// TIME & DATE PARSERS
// =====================================================
function parseFlexibleTime(timeString) {
    const input = timeString.trim().toUpperCase();
    
    const pattern1 = input.match(/^(\d{1,2})\s*(AM|PM)$/);
    if (pattern1) {
        let hour = parseInt(pattern1[1]);
        const meridiem = pattern1[2];
        
        if (hour < 1 || hour > 12) return null;
        
        if (meridiem === 'PM' && hour !== 12) {
            hour += 12;
        } else if (meridiem === 'AM' && hour === 12) {
            hour = 0;
        }
        
        return `${hour.toString().padStart(2, '0')}:00`;
    }
    
    const pattern2 = input.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
    if (pattern2) {
        let hour = parseInt(pattern2[1]);
        const minute = parseInt(pattern2[2]);
        const meridiem = pattern2[3];
        
        if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
        
        if (meridiem === 'PM' && hour !== 12) {
            hour += 12;
        } else if (meridiem === 'AM' && hour === 12) {
            hour = 0;
        }
        
        return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    }
    
    const pattern3 = input.match(/^(\d{1,2}):(\d{2})$/);
    if (pattern3) {
        const hour = parseInt(pattern3[1]);
        const minute = parseInt(pattern3[2]);
        
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
        
        return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    }
    
    const pattern4 = input.match(/^(\d{1,2})$/);
    if (pattern4) {
        const hour = parseInt(pattern4[1]);
        
        if (hour < 0 || hour > 23) return null;
        
        return `${hour.toString().padStart(2, '0')}:00`;
    }
    
    return null;
}

function parseFlexibleDate(dateString) {
    const input = dateString.trim().toLowerCase();
    const today = new Date();
    
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
// KEYWORD DETECTION
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

        const categories = {};
        menuItems.rows.forEach(item => {
            const category = item.category || 'Other';
            if (!categories[category]) {
                categories[category] = [];
            }
            categories[category].push(item);
        });

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
// COD CONFIRMATION - FIXED
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

        const expiryTimestamp = Date.now() + (10 * 60 * 1000);
        
        console.log(`✅ COD confirmation sent to ${phoneNumber}`);
        console.log(`⏰ Expiry set to: ${new Date(expiryTimestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);

        const timeoutId = setTimeout(async () => {
            try {
                const session = await getUserSession(phoneNumber);
                const currentData = getSessionData(session);

                if (currentData.awaitingCODConfirmation && session.current_state === STATES.COD_CONFIRMATION) {
                    await updateCustomerReliability(phoneNumber, 'CANCELLED');
                    await sendWhatsAppMessage(phoneNumber,
                        '⏱️ Order confirmation expired. Your order has been cancelled.\n\nScan QR code to place order.');
                    await updateUserSession(phoneNumber, STATES.MAIN_MENU, {});
                    console.log(`⏰ Auto-cancelled order for ${phoneNumber} after 10 minutes`);
                }
            } catch (error) {
                console.error('❌ Timeout cleanup error:', error);
            }
        }, 10 * 60 * 1000);

        confirmationTimeouts.set(phoneNumber, timeoutId);

        return { 
            total, 
            deliveryFee, 
            subtotal,
            confirmationExpiry: expiryTimestamp,
            awaitingCODConfirmation: true
        };

    } catch (error) {
        console.error('❌ Error requesting COD confirmation:', error);
        return null;
    }
}

// =====================================================
// CREATE TEMPORARY ORDER (FOR PAYMENT)
// =====================================================
async function createTemporaryOrder(phoneNumber, sessionData, total, deliveryFee, paymentMethod) {
    try {
        const subtotal = total - deliveryFee;
        
        const orderResult = await pool.query(
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
                paymentMethod,
                'PENDING',
                'PENDING_PAYMENT'
            ]
        );

        const orderId = orderResult.rows[0].id;

        for (const item of sessionData.cart) {
            await pool.query(
                `INSERT INTO order_items (order_id, menu_item_id, quantity, price, subtotal)
                 VALUES ($1, $2, $3, $4, $5)`,
                [orderId, item.id, item.quantity, item.price, item.price * item.quantity]
            );
        }

        console.log(`✅ Temporary order #${orderId} created for payment`);
        return { success: true, orderId };
    } catch (error) {
        console.error('❌ Error creating temporary order:', error);
        return { success: false, error };
    }
}

// =====================================================
// CREATE ORDER - ENHANCED LOGGING
// =====================================================
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

        console.log(`✅ Order #${orderId} created in database`);

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
            paymentStatus: 'COD',
            specialInstructions: sessionData.specialInstructions
        }).catch(err => console.error('⚠️ Owner notification failed:', err.message));

        // Log to Google Sheets
        if (isConfigured()) {
            console.log(`📊 Logging order #${orderId} to Google Sheets...`);
            logOrderToSheets({
                orderId: orderId,
                restaurantName: restaurant.rows[0].name,
                restaurantId: sessionData.selectedRestaurant,
                customerPhone: phoneNumber,
                customerName: sessionData.customerName || 'Customer',
                orderType: 'delivery',
                deliveryAddress: sessionData.deliveryAddress,
                items: sessionData.cart,
                subtotal: subtotal,
                deliveryFee: deliveryFee,
                total: total,
                specialInstructions: sessionData.specialInstructions || '',
                status: 'Confirmed',
                paymentStatus: 'Pending',
                estimatedDeliveryTime: '45 minutes'
            }).catch(err => {
                console.error('⚠️ Sheets logging failed:', err.message);
            });
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

        const restaurant = await pool.query(
            'SELECT name, address, phone FROM restaurants WHERE id = $1',
            [sessionData.selectedRestaurant]
        );

        notifyRestaurantOwner(sessionData.selectedRestaurant, 'new_booking', {
            bookingId: result.rows[0].id,
            customerName: sessionData.customerName,
            customerPhone: phoneNumber,
            bookingDate: sessionData.bookingDate,
            bookingTime: sessionData.bookingTime,
            numberOfGuests: sessionData.numberOfGuests,
            specialRequests: sessionData.specialRequests
        }).catch(err => console.error('⚠️ Owner notification failed:', err.message));

        if (isConfigured()) {
            logBookingToSheets({
                bookingId: result.rows[0].id,
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
// MAIN MESSAGE HANDLER
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

        // COD CONFIRMATION STATE
        if (session.current_state === STATES.COD_CONFIRMATION) {
            const response = message.toUpperCase();
            
            console.log(`📋 COD Confirmation received from ${phoneNumber}: ${response}`);

            if (Date.now() > (sessionData.confirmationExpiry || 0)) {
                await updateCustomerReliability(phoneNumber, 'CANCELLED');
                responseMessage = '⏱️ Confirmation expired. Order cancelled.\n\nScan QR code to place order.';
                newState = STATES.MAIN_MENU;
                updatedData = {};
                
                if (confirmationTimeouts.has(phoneNumber)) {
                    clearTimeout(confirmationTimeouts.get(phoneNumber));
                    confirmationTimeouts.delete(phoneNumber);
                }
            }
            else if (response === 'CONFIRM') {
                const reliability = await checkCustomerReliability(phoneNumber);

                if (reliability.isBlocked) {
                    responseMessage = `❌ Sorry, you cannot place orders at this time.\n\n*Reason:* Multiple cancelled/no-show orders.\n\nContact support: +91 8013610018`;
                    newState = STATES.MAIN_MENU;
                    updatedData = {};
                } else {
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
                        responseMessage = '❌ Sorry, there was an error processing your order.\n\nContact support: +91 8013610018';
                        newState = STATES.MAIN_MENU;
                        updatedData = {};
                    }
                }

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

        // AWAITING PAYMENT STATE
        if (session.current_state === STATES.AWAITING_PAYMENT) {
            if (messageLower === 'check' || messageLower === 'status') {
                const paymentStatus = await verifyPayment(pool, sessionData.paymentId);
                
                if (paymentStatus.paid) {
                    const restaurant = await pool.query(
                        'SELECT name FROM restaurants WHERE id = $1',
                        [sessionData.selectedRestaurant]
                    );

                    responseMessage = '✅ *Payment Confirmed!*\n\n';
                    responseMessage += `Order ID: #${sessionData.orderId}\n`;
                    responseMessage += `Restaurant: ${restaurant.rows[0].name}\n\n`;
                    responseMessage += 'Your order is being prepared.\n';
                    responseMessage += `Estimated delivery: 45 minutes\n\n`;
                    responseMessage += 'Thank you for your order! 🍽️';
                    
                    await updateCustomerReliability(phoneNumber, 'COMPLETED');
                    
                    newState = STATES.MAIN_MENU;
                    updatedData = {};

                    if (paymentTimeouts.has(phoneNumber)) {
                        clearTimeout(paymentTimeouts.get(phoneNumber));
                        paymentTimeouts.delete(phoneNumber);
                    }
                } else {
                    responseMessage = '⏳ Payment pending.\n\nComplete payment using the link sent earlier.\n\nType "check" to verify payment status.';
                }
            } else if (messageLower === 'cancel') {
                await pool.query(
                    'UPDATE orders SET status = $1 WHERE id = $2',
                    ['CANCELLED', sessionData.orderId]
                );
                
                await updateCustomerReliability(phoneNumber, 'CANCELLED');
                
                responseMessage = '❌ Order cancelled.\n\nScan QR code to place new order.';
                newState = STATES.MAIN_MENU;
                updatedData = {};

                if (paymentTimeouts.has(phoneNumber)) {
                    clearTimeout(paymentTimeouts.get(phoneNumber));
                    paymentTimeouts.delete(phoneNumber);
                }
            } else {
                responseMessage = '⏳ Waiting for payment...\n\nType "check" to verify status\nType "cancel" to cancel order';
            }

            await updateUserSession(phoneNumber, newState, updatedData);
            return responseMessage;
        }

        // QR KEYWORD DETECTION
        const detectedRestaurant = await detectRestaurantFromKeyword(message);
        
        if (detectedRestaurant && !sessionData.selectedRestaurant) {
            const reliability = await checkCustomerReliability(phoneNumber);

            if (reliability.isBlocked) {
                return `❌ Sorry, you cannot place orders at this time.\n\n*Reason:* Multiple cancelled/no-show orders.\n\nContact support: +91 8013610018`;
            }

            updatedData.selectedRestaurant = detectedRestaurant.id;
            updatedData.restaurantName = detectedRestaurant.name;

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

        // MENU/RESTART COMMANDS
        if (messageLower === 'menu' || messageLower === 'restart' || messageLower === 'start') {
            responseMessage = getMainMenuMessage();
            newState = STATES.MAIN_MENU;
            updatedData = {};
        }
        // MAIN MENU
        else if (session.current_state === STATES.MAIN_MENU) {
            responseMessage = getMainMenuMessage();
        }
        // SELECT RESTAURANT
        else if (session.current_state === STATES.SELECT_RESTAURANT) {
            const choice = message.trim();

            if (!sessionData.selectedRestaurant) {
                responseMessage = '❌ No restaurant selected.\n\nScan QR code to start.';
                newState = STATES.MAIN_MENU;
            }
            else if (choice === '1') {
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
                    responseMessage = '❌ Sorry, delivery is not available at this restaurant.';
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
                const restaurant = await pool.query(
                    'SELECT * FROM restaurants WHERE id = $1',
                    [sessionData.selectedRestaurant]
                );

                if (restaurant.rows.length === 0) {
                    responseMessage = '❌ Restaurant not found.';
                    newState = STATES.MAIN_MENU;
                    updatedData = {};
                }
                else if (!restaurant.rows[0].table_booking_available) {
                    responseMessage = '❌ Sorry, table booking is not available at this restaurant.';
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
        // ADD ITEMS TO CART
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
        // DELIVERY ADDRESS
        else if (session.current_state === STATES.DELIVERY_ADDRESS) {
            updatedData.deliveryAddress = body.trim();
            responseMessage = '✅ Address saved!\n\n';
            responseMessage += 'Any special instructions? (Type "no" if none)';
            newState = STATES.CONFIRM_ORDER;
        }
        // SPECIAL INSTRUCTIONS → PAYMENT METHOD SELECTION
        else if (session.current_state === STATES.CONFIRM_ORDER) {
            if (messageLower !== 'no') {
                updatedData.specialInstructions = body.trim();
            }

            // Check if payment is enabled
            if (FEATURES.PAYMENT) {
                const restaurant = await pool.query(
                    'SELECT delivery_fee FROM restaurants WHERE id = $1',
                    [sessionData.selectedRestaurant]
                );
                const deliveryFee = parseFloat(restaurant.rows[0].delivery_fee || 0);
                const subtotal = sessionData.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
                const total = subtotal + deliveryFee;

                responseMessage = '💳 *Select Payment Method*\n\n';
                responseMessage += getCartSummary(sessionData, deliveryFee);
                responseMessage += '\n\n*Payment Options:*\n';
                responseMessage += '1️⃣ Online Payment (UPI/Card/Wallet)\n';
                responseMessage += '2️⃣ Cash on Delivery\n\n';
                responseMessage += 'Reply with 1 or 2';
                newState = STATES.PAYMENT_METHOD;
            } else {
                // If payment disabled, go directly to COD
                const confirmResult = await requestCODConfirmation(phoneNumber, sessionData);
                if (confirmResult) {
                    updatedData.confirmationExpiry = confirmResult.confirmationExpiry;
                    updatedData.awaitingCODConfirmation = confirmResult.awaitingCODConfirmation;
                    newState = STATES.COD_CONFIRMATION;
                    await updateUserSession(phoneNumber, newState, updatedData);
                    return '';
                }
            }
        }
        // PAYMENT METHOD SELECTION
        else if (session.current_state === STATES.PAYMENT_METHOD) {
            const choice = message.trim();
            
            if (choice === '1') {
                // Online Payment
                const restaurant = await pool.query(
                    'SELECT delivery_fee, name FROM restaurants WHERE id = $1',
                    [sessionData.selectedRestaurant]
                );
                const deliveryFee = parseFloat(restaurant.rows[0].delivery_fee || 0);
                const subtotal = sessionData.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
                const total = subtotal + deliveryFee;

                // Create temporary order to get order ID
                const tempOrder = await createTemporaryOrder(phoneNumber, sessionData, total, deliveryFee, 'ONLINE');
                
                if (tempOrder.success) {
                    // Create payment link
                    const paymentResult = await createPaymentLink(
                        pool,
                        tempOrder.orderId,
                        total,
                        phoneNumber,
                        sessionData.customerName || 'Customer'
                    );

                    if (paymentResult.success) {
                        responseMessage = getPaymentMessage(tempOrder.orderId, total, paymentResult.paymentLink);
                        responseMessage += '\n\n_Order will be confirmed after successful payment_\n';
                        responseMessage += '_Link expires in 15 minutes_\n\n';
                        responseMessage += 'Type "check" to verify payment status\n';
                        responseMessage += 'Type "cancel" to cancel order';
                        
                        updatedData.orderId = tempOrder.orderId;
                        updatedData.paymentId = paymentResult.paymentId;
                        updatedData.paymentExpiry = Date.now() + (15 * 60 * 1000);
                        newState = STATES.AWAITING_PAYMENT;

                        // Set timeout for payment expiry
                        const timeoutId = setTimeout(async () => {
                            try {
                                const session = await getUserSession(phoneNumber);
                                if (session.current_state === STATES.AWAITING_PAYMENT) {
                                    await pool.query(
                                        'UPDATE orders SET status = $1 WHERE id = $2',
                                        ['CANCELLED', updatedData.orderId]
                                    );
                                    await sendWhatsAppMessage(phoneNumber,
                                        '⏱️ Payment link expired. Order cancelled.\n\nScan QR code to place order.');
                                    await updateUserSession(phoneNumber, STATES.MAIN_MENU, {});
                                }
                            } catch (error) {
                                console.error('❌ Payment timeout error:', error);
                            }
                        }, 15 * 60 * 1000);

                        paymentTimeouts.set(phoneNumber, timeoutId);
                    } else {
                        responseMessage = '❌ Error creating payment link.\n\nPlease try Cash on Delivery instead.\n\nReply with 2';
                    }
                } else {
                    responseMessage = '❌ Error processing order.\n\nContact support: +91 8013610018';
                    newState = STATES.MAIN_MENU;
                    updatedData = {};
                }
            }
            else if (choice === '2') {
                // Cash on Delivery
                const confirmResult = await requestCODConfirmation(phoneNumber, sessionData);
                if (confirmResult) {
                    updatedData.confirmationExpiry = confirmResult.confirmationExpiry;
                    updatedData.awaitingCODConfirmation = confirmResult.awaitingCODConfirmation;
                    newState = STATES.COD_CONFIRMATION;
                    await updateUserSession(phoneNumber, newState, updatedData);
                    return '';
                }
            }
            else {
                responseMessage = '❌ Invalid choice.\n\nReply with:\n1️⃣ for Online Payment\n2️⃣ for Cash on Delivery';
            }
        }
        // BOOKING DATE
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
        // BOOKING TIME
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
        // NUMBER OF GUESTS
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
        // BOOKING NAME
        else if (session.current_state === STATES.BOOKING_NAME) {
            updatedData.customerName = body.trim();
            responseMessage = '📝 Any special requests? (Type "no" if none)';
            newState = STATES.CONFIRM_BOOKING;
        }
        // CONFIRM BOOKING
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
                responseMessage = '❌ Sorry, there was an error processing your booking.\n\nContact support: +91 8013610018';
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
        
        if (response) {
            await sendWhatsAppMessage(from.replace('whatsapp:', ''), response);
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).send('Error');
    }
});

// =====================================================
// PAYMENT WEBHOOK
// =====================================================
app.post('/payment/webhook', async (req, res) => {
    try {
        const webhookSignature = req.headers['x-razorpay-signature'];
        const webhookBody = req.body;

        console.log('📨 Payment webhook received');

        const result = await handlePaymentWebhook(pool, webhookBody, webhookSignature);

        if (result.success && result.orderId) {
            // Get order details
            const orderData = await pool.query(
                `SELECT o.*, r.name as restaurant_name, r.id as restaurant_id
                 FROM orders o
                 JOIN restaurants r ON o.restaurant_id = r.id
                 WHERE o.id = $1`,
                [result.orderId]
            );

            if (orderData.rows.length > 0) {
                const order = orderData.rows[0];
                
                // Get session to retrieve cart items
                const session = await getUserSession(order.customer_phone);
                const sessionData = getSessionData(session);
                
                // Get order items
                const items = await pool.query(
                    `SELECT mi.name, oi.quantity, oi.price
                     FROM order_items oi
                     JOIN menu_items mi ON oi.menu_item_id = mi.id
                     WHERE oi.order_id = $1`,
                    [result.orderId]
                );

                // Notify customer
                await sendWhatsAppMessage(order.customer_phone,
                    `✅ *Payment Received!*\n\nOrder #${order.id} confirmed.\n${order.restaurant_name} is preparing your food.\n\nEstimated delivery: 45 minutes\n\nThank you! 🍽️`
                );

                // Notify owner
                await notifyRestaurantOwner(order.restaurant_id, 'new_order', {
                    orderId: order.id,
                    customerPhone: order.customer_phone,
                    customerName: order.customer_name,
                    deliveryAddress: order.delivery_address,
                    items: items.rows,
                    total: order.total_amount,
                    paymentStatus: 'PAID',
                    specialInstructions: order.special_instructions
                });

                // Update reliability
                await updateCustomerReliability(order.customer_phone, 'COMPLETED');

                // Clear payment timeout
                if (paymentTimeouts.has(order.customer_phone)) {
                    clearTimeout(paymentTimeouts.get(order.customer_phone));
                    paymentTimeouts.delete(order.customer_phone);
                }

                // Reset session
                await updateUserSession(order.customer_phone, STATES.MAIN_MENU, {});
            }
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('❌ Payment webhook error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Payment callback page
app.get('/payment/callback', async (req, res) => {
    const { razorpay_payment_id, razorpay_payment_link_id, razorpay_payment_link_status } = req.query;
    
    const statusEmoji = razorpay_payment_link_status === 'paid' ? '✅' : '❌';
    const statusText = razorpay_payment_link_status === 'paid' ? 'Payment Successful!' : 'Payment Failed';
    const message = razorpay_payment_link_status === 'paid' 
        ? 'Your order has been confirmed. You will receive a WhatsApp message shortly.'
        : 'Payment was not completed. Please try again or contact support.';
    
    res.send(`
        <!DOCTYPE html>
        <html>
            <head>
                <title>Payment Status</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        text-align: center;
                        padding: 50px;
                        background: #f5f5f5;
                    }
                    .container {
                        background: white;
                        border-radius: 10px;
                        padding: 40px;
                        max-width: 500px;
                        margin: 0 auto;
                        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                    }
                    h1 { color: #333; margin-bottom: 20px; }
                    .emoji { font-size: 64px; margin-bottom: 20px; }
                    .details {
                        background: #f9f9f9;
                        padding: 15px;
                        border-radius: 5px;
                        margin-top: 20px;
                        font-size: 14px;
                        color: #666;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="emoji">${statusEmoji}</div>
                    <h1>${statusText}</h1>
                    <p>${message}</p>
                    ${razorpay_payment_id ? `<div class="details">Payment ID: ${razorpay_payment_id}</div>` : ''}
                </div>
            </body>
        </html>
    `);
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
            paymentEnabled: FEATURES.PAYMENT,
            razorpayConfigured: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
            safetyFeatures: {
                customerReliabilityTracking: true,
                codConfirmation: true,
                codTimeout: '10 minutes',
                paymentTimeout: '15 minutes',
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
        restaurantCache.lastUpdated = null;
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

app.get('/customer-reliability/:phone', async (req, res) => {
    try {
        const phoneNumber = req.params.phone;
        const reliability = await checkCustomerReliability(phoneNumber);
        res.json(reliability);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/test-session/:phone', async (req, res) => {
    try {
        const phoneNumber = req.params.phone;
        const session = await getUserSession(phoneNumber);
        const sessionData = getSessionData(session);
        
        res.json({
            phoneNumber: phoneNumber,
            currentState: session.current_state,
            confirmationExpiry: sessionData.confirmationExpiry,
            paymentExpiry: sessionData.paymentExpiry,
            awaitingCOD: sessionData.awaitingCODConfirmation,
            orderId: sessionData.orderId,
            paymentId: sessionData.paymentId
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Test owner notification
app.get('/test-owner-notify', async (req, res) => {
    try {
        console.log('\n🧪 MANUAL TEST: Testing owner notification...\n');
        
        await notifyRestaurantOwner(1, 'new_order', {
            orderId: 999,
            customerPhone: '+918013610018',
            customerName: 'Test Customer',
            deliveryAddress: 'Test Address, Kolkata',
            items: [
                { name: 'Test Biryani', quantity: 2, price: 250 },
                { name: 'Test Paneer', quantity: 1, price: 180 }
            ],
            total: 680,
            paymentStatus: 'PAID',
            specialInstructions: 'Test order - please ignore'
        });
        
        res.json({ 
            success: true, 
            message: 'Test notification sent! Check Railway logs for detailed 5-step output.'
        });
    } catch (error) {
        console.error('❌ Test failed:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message
        });
    }
});

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 SERVER STARTED - Port ${PORT}`);
    console.log(`${'='.repeat(60)}\n`);
    console.log(`✅ HTTP Server: RUNNING`);
    console.log(`📱 Webhook: https://restaurant.legacylens.co.in/webhook`);
    console.log(`💳 Payment Webhook: https://restaurant.legacylens.co.in/payment/webhook`);
    console.log(`🏥 Health: https://restaurant.legacylens.co.in/health\n`);
});

server.on('error', (error) => {
    console.error('❌ Server error:', error);
    if (error.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use`);
        process.exit(1);
    }
});

setImmediate(async () => {
    console.log('🔧 Starting feature initialization...\n');
    
    try {
        console.log('1️⃣ Testing database connection...');
        try {
            await pool.query('SELECT NOW()');
            console.log('   ✅ Database: CONNECTED\n');
        } catch (dbError) {
            console.error('   ❌ Database: FAILED');
            console.error('   Error:', dbError.message);
            console.error('   ⚠️ Bot will work with limited functionality\n');
        }

        console.log('2️⃣ Initializing safety tables...');
        try {
            await initializeSafetyTables();
            console.log('   ✅ Safety tables: READY\n');
        } catch (error) {
            console.error('   ❌ Safety tables: FAILED');
            console.error('   Error:', error.message, '\n');
        }

        console.log('3️⃣ Loading restaurants...');
        try {
            const restaurantData = await loadRestaurantsFromDatabase();
            console.log(`   ✅ Loaded ${restaurantData.data.length} restaurants`);
            console.log(`   ✅ Active keywords: ${Object.keys(restaurantData.keywords).join(', ')}\n`);
            
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

        console.log('5️⃣ Verifying Twilio credentials...');
        if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.WABA_NUMBER) {
            console.log('   ✅ Twilio: CONFIGURED\n');
        } else {
            console.error('   ❌ Twilio: Missing credentials');
            console.error('   ⚠️ WhatsApp messaging will not work\n');
        }

        console.log('6️⃣ Checking Payment Integration...');
        if (FEATURES.PAYMENT) {
            if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
                console.log('   ✅ Razorpay: CONFIGURED');
                console.log('   ✅ Online payments: ENABLED\n');
            } else {
                console.log('   ⚠️ Razorpay: Not configured');
                console.log('   ℹ️ Only COD available\n');
            }
        } else {
            console.log('   ℹ️ Payment feature: DISABLED');
            console.log('   ℹ️ Only COD available\n');
        }

        console.log('🔒 Safety Features:');
        console.log('   ✅ Customer reliability tracking');
        console.log('   ✅ COD confirmation (10-min timeout)');
        console.log('   ✅ Payment timeout (15 minutes)');
        console.log('   ✅ Fraud detection & auto-blocking');
        console.log('   ✅ Trust score system');
        console.log('   ✅ QR code-only access\n');
        
        console.log(`${'='.repeat(60)}`);
        console.log('✅ INITIALIZATION COMPLETE');
        console.log('🎉 Bot is ready to receive messages!');
        console.log(`${'='.repeat(60)}\n`);

        console.log('🧪 DEBUG ENDPOINTS:');
        console.log('   📍 Health: https://restaurant.legacylens.co.in/health');
        console.log('   📍 Restaurants: https://restaurant.legacylens.co.in/restaurants');
        console.log('   📍 Test notify: https://restaurant.legacylens.co.in/test-owner-notify\n');

    } catch (error) {
        console.error('\n⚠️ INITIALIZATION ERROR:', error.message);
        console.log('⚠️ Server is running but some features may be limited\n');
    }
});

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

process.on('uncaughtException', (error) => {
    console.error('\n❌ UNCAUGHT EXCEPTION:', error);
    console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('\n❌ UNHANDLED REJECTION at:', promise);
    console.error('Reason:', reason);
});
