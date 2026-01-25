require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================
// DATABASE CONNECTION WITH RETRY LOGIC
// =====================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Database health check
pool.on('error', (err) => {
    console.error('Unexpected database error:', err);
});

// Test connection
pool.query('SELECT NOW()', (err) => {
    if (err) {
        console.error('❌ Database connection failed:', err);
    } else {
        console.log('✅ Database connected successfully');
    }
});

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
    BOOK_TABLE: 'book_table',
    BOOKING_DATE: 'booking_date',
    BOOKING_TIME: 'booking_time',
    BOOKING_GUESTS: 'booking_guests',
    BOOKING_NAME: 'booking_name',
    CONFIRM_BOOKING: 'confirm_booking'
};

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
                messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
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
// SMART OWNER NOTIFICATION - USES DB WHATSAPP NUMBER
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
            message = `🔔 *NEW ORDER #${data.orderId}*\n\n`;
            message += `🏪 Restaurant: ${restaurant.name}\n`;
            message += `📱 Customer: ${data.customerPhone}\n`;
            message += `📍 Address: ${data.deliveryAddress}\n\n`;
            message += `*Items:*\n`;
            data.items.forEach(item => {
                message += `• ${item.quantity}× ${item.name} - ₹${(item.price * item.quantity).toFixed(2)}\n`;
            });
            message += `\n💰 Total: ₹${data.total.toFixed(2)}\n`;
            if (data.specialInstructions) {
                message += `\n📝 Special: ${data.specialInstructions}\n`;
            }
            message += `\n⏰ Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n`;
            message += `\n✅ Please confirm and prepare!`;
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
        console.error(`❌ Failed to notify owner for restaurant ${restaurantId}:`, error);
    }
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
        console.error('Error getting user session:', error);
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
        console.error('Error updating user session:', error);
        throw error;
    }
}

function getSessionData(session) {
    try {
        return typeof session.session_data === 'string' 
            ? JSON.parse(session.session_data) 
            : session.session_data;
    } catch (error) {
        console.error('Error parsing session data:', error);
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
        console.error('Error detecting keyword:', error);
        return null;
    }
}

// =====================================================
// MENU FUNCTIONS
// =====================================================
function getMainMenuMessage() {
    return `🍽️ *Welcome to Restaurant Bot!*

What would you like to do today?

1️⃣ Order Delivery
2️⃣ Book a Table
3️⃣ View Restaurants

Reply with the number of your choice.`;
}

async function getRestaurantsList() {
    try {
        const restaurantData = await loadRestaurantsFromDatabase();
        const restaurants = restaurantData.data;

        let message = '🏪 *Available Restaurants:*\n\n';
        
        restaurants.forEach((restaurant, index) => {
            message += `${index + 1}️⃣ *${restaurant.name}*\n`;
            message += `   ${restaurant.cuisine_type || 'Multi-Cuisine'}\n`;
            message += `   📍 ${restaurant.address || 'Location available'}\n`;
            
            if (restaurant.delivery_available) {
                const minOrder = restaurant.min_delivery_amount || 0;
                const deliveryFee = restaurant.delivery_fee || 0;
                message += `   🚚 Delivery: ₹${deliveryFee} (Min: ₹${minOrder})\n`;
            }
            
            if (restaurant.table_booking_available) {
                message += `   🪑 Table booking available\n`;
            }
            
            if (restaurant.opening_time && restaurant.closing_time) {
                const openTime = restaurant.opening_time.substring(0, 5);
                const closeTime = restaurant.closing_time.substring(0, 5);
                message += `   ⏰ ${openTime} - ${closeTime}\n`;
            }
            
            message += `\n`;
        });

        message += 'Reply with the restaurant number to continue.';
        return { message, restaurants };
    } catch (error) {
        console.error('Error getting restaurants list:', error);
        return { 
            message: '❌ Sorry, unable to load restaurants. Please try again.', 
            restaurants: [] 
        };
    }
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
        console.error('Error getting restaurant menu:', error);
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
                quantity: quantity
            });
        }

        return { success: true, sessionData };
    } catch (error) {
        console.error('Error adding order item:', error);
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
             delivery_address, total_amount, delivery_fee, special_instructions, estimated_delivery_time)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP + INTERVAL '45 minutes')
             RETURNING *`,
            [
                phoneNumber,
                sessionData.customerName || 'Customer',
                sessionData.selectedRestaurant,
                'delivery',
                sessionData.deliveryAddress,
                total,
                deliveryFee,
                sessionData.specialInstructions || null
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

        // Send notification to owner
        await notifyRestaurantOwner(sessionData.selectedRestaurant, 'new_order', {
            orderId: orderId,
            customerPhone: phoneNumber,
            deliveryAddress: sessionData.deliveryAddress,
            items: sessionData.cart,
            total: total,
            specialInstructions: sessionData.specialInstructions
        });

        return { success: true, orderId, order: orderResult.rows[0] };

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating order:', error);
        return { success: false, error };
    } finally {
        client.release();
    }
}

async function createBooking(phoneNumber, sessionData) {
    try {
        const result = await pool.query(
            `INSERT INTO table_bookings (customer_phone, customer_name, restaurant_id, 
             booking_date, booking_time, number_of_guests, special_requests)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
                phoneNumber,
                sessionData.customerName,
                sessionData.selectedRestaurant,
                sessionData.bookingDate,
                sessionData.bookingTime,
                sessionData.numberOfGuests,
                sessionData.specialRequests || null
            ]
        );

        // Send notification to owner
        await notifyRestaurantOwner(sessionData.selectedRestaurant, 'new_booking', {
            bookingId: result.rows[0].id,
            customerName: sessionData.customerName,
            customerPhone: phoneNumber,
            bookingDate: sessionData.bookingDate,
            bookingTime: sessionData.bookingTime,
            numberOfGuests: sessionData.numberOfGuests,
            specialRequests: sessionData.specialRequests
        });

        return { success: true, bookingId: result.rows[0].id, booking: result.rows[0] };
    } catch (error) {
        console.error('Error creating booking:', error);
        return { success: false, error };
    }
}

// =====================================================
// MAIN MESSAGE HANDLER - ULTRA SMART
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
        // SMART QR KEYWORD DETECTION (DATABASE-DRIVEN)
        // =====================================================
        const detectedRestaurant = await detectRestaurantFromKeyword(message);
        
        if (detectedRestaurant && !sessionData.selectedRestaurant) {
            updatedData.selectedRestaurant = detectedRestaurant.id;
            updatedData.restaurantName = detectedRestaurant.name;
            updatedData.action = 'delivery';

            const menuData = await getRestaurantMenu(detectedRestaurant.id);
            responseMessage = `🎉 Welcome to *${detectedRestaurant.name}*!\n\n`;
            responseMessage += menuData.message;
            responseMessage += '\n\n*To order:*\n';
            responseMessage += 'Type item ID and quantity (e.g., "15 2")\n';
            responseMessage += 'Type "done" when finished\n';
            responseMessage += 'Type "cart" to view cart\n';
            if (detectedRestaurant.table_booking_available) {
                responseMessage += 'Type "booking" for table reservation';
            }

            newState = STATES.ADD_ITEMS;
            updatedData.cart = [];

            await updateUserSession(phoneNumber, newState, updatedData);
            return responseMessage;
        }

        // Handle booking from QR flow
        if (messageLower === 'booking' && sessionData.selectedRestaurant) {
            const restaurant = await pool.query(
                'SELECT * FROM restaurants WHERE id = $1',
                [sessionData.selectedRestaurant]
            );

            if (restaurant.rows.length > 0) {
                if (!restaurant.rows[0].table_booking_available) {
                    return '❌ Sorry, table booking is not available at this location.\n\nYou can still order delivery! Type "menu" to continue.';
                }

                responseMessage = `📅 *Table Booking at ${restaurant.rows[0].name}*\n\n`;
                responseMessage += 'Please enter the date for your booking\n';
                responseMessage += 'Format: DD-MM-YYYY (e.g., 25-01-2026)';
                newState = STATES.BOOKING_DATE;
                await updateUserSession(phoneNumber, newState, updatedData);
                return responseMessage;
            }
        }

        // Handle menu/restart commands
        if (messageLower === 'menu' || messageLower === 'restart' || messageLower === 'start') {
            responseMessage = getMainMenuMessage();
            newState = STATES.MAIN_MENU;
            updatedData = {};
        }
        // Main menu
        else if (session.current_state === STATES.MAIN_MENU) {
            if (message === '1') {
                const restaurants = await getRestaurantsList();
                responseMessage = restaurants.message + '\n\n_Type "menu" anytime to return to main menu._';
                updatedData.action = 'delivery';
                newState = STATES.SELECT_RESTAURANT;
            } else if (message === '2') {
                const restaurants = await getRestaurantsList();
                responseMessage = restaurants.message + '\n\n_Type "menu" anytime to return to main menu._';
                updatedData.action = 'booking';
                newState = STATES.SELECT_RESTAURANT;
            } else if (message === '3') {
                const restaurants = await getRestaurantsList();
                responseMessage = restaurants.message + '\n\n_Type "menu" anytime to return to main menu._';
                updatedData.action = 'delivery'; // Default to delivery when just viewing
                newState = STATES.SELECT_RESTAURANT; // FIX: Move to SELECT_RESTAURANT state
            } else {
                responseMessage = getMainMenuMessage();
            }
        }
        // Restaurant selection
        else if (session.current_state === STATES.SELECT_RESTAURANT) {
            const restaurantNumber = parseInt(message);
            const restaurantData = await loadRestaurantsFromDatabase();
            const restaurants = restaurantData.data;

            if (restaurantNumber > 0 && restaurantNumber <= restaurants.length) {
                const selectedRestaurant = restaurants[restaurantNumber - 1];
                updatedData.selectedRestaurant = selectedRestaurant.id;
                updatedData.restaurantName = selectedRestaurant.name;

                if (sessionData.action === 'delivery') {
                    if (!selectedRestaurant.delivery_available) {
                        responseMessage = '❌ Sorry, delivery is not available at this restaurant.\n\nPlease select another restaurant or type "menu" to return.';
                    } else {
                        const menuData = await getRestaurantMenu(selectedRestaurant.id);
                        responseMessage = menuData.message;
                        responseMessage += '\n\n*To order:*\n';
                        responseMessage += 'Type item ID and quantity (e.g., "15 2")\n';
                        responseMessage += 'Type "done" when finished\n';
                        responseMessage += 'Type "cart" to view cart';
                        newState = STATES.ADD_ITEMS;
                        updatedData.cart = [];
                    }
                } else if (sessionData.action === 'booking') {
                    if (!selectedRestaurant.table_booking_available) {
                        responseMessage = '❌ Sorry, table booking is not available at this restaurant.\n\nPlease select another restaurant or type "menu" to return.';
                    } else {
                        responseMessage = `📅 *Table Booking at ${selectedRestaurant.name}*\n\n`;
                        responseMessage += 'Please enter the date for your booking\n';
                        responseMessage += 'Format: DD-MM-YYYY (e.g., 25-01-2026)';
                        newState = STATES.BOOKING_DATE;
                    }
                }
            } else {
                responseMessage = '❌ Invalid selection. Please enter a valid restaurant number.';
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
                        responseMessage += 'Please add more items or type "menu" to cancel.';
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
        // Confirm order
        else if (session.current_state === STATES.CONFIRM_ORDER) {
            if (messageLower !== 'no') {
                updatedData.specialInstructions = body.trim();
            }

            const orderResult = await createOrder(phoneNumber, sessionData);

            if (orderResult.success) {
                const restaurant = await pool.query(
                    'SELECT name, delivery_fee FROM restaurants WHERE id = $1',
                    [sessionData.selectedRestaurant]
                );
                const deliveryFee = parseFloat(restaurant.rows[0].delivery_fee || 0);

                responseMessage = '🎉 *Order Confirmed!*\n\n';
                responseMessage += `Order ID: #${orderResult.orderId}\n`;
                responseMessage += `Restaurant: ${restaurant.rows[0].name}\n\n`;
                responseMessage += getCartSummary(sessionData, deliveryFee);
                responseMessage += `\n\n📍 Delivery Address:\n${sessionData.deliveryAddress}\n`;
                if (sessionData.specialInstructions) {
                    responseMessage += `\n📝 Instructions: ${sessionData.specialInstructions}\n`;
                }
                responseMessage += `\n⏱️ Estimated Delivery: 45 minutes\n`;
                responseMessage += `\nThank you for your order!\n\n`;
                responseMessage += 'Type "menu" to place another order.';

                newState = STATES.MAIN_MENU;
                updatedData = {};
            } else {
                responseMessage = '❌ Sorry, there was an error processing your order. Please try again or contact support.';
            }
        }
        // Booking date
        else if (session.current_state === STATES.BOOKING_DATE) {
            const dateMatch = message.match(/(\d{2})-(\d{2})-(\d{4})/);
            if (dateMatch) {
                const [, day, month, year] = dateMatch;
                const bookingDate = `${year}-${month}-${day}`;
                updatedData.bookingDate = bookingDate;

                responseMessage = '⏰ *Booking Time*\n\n';
                responseMessage += 'Please enter the time for your booking\n';
                responseMessage += 'Format: HH:MM (e.g., 19:30 for 7:30 PM)';
                newState = STATES.BOOKING_TIME;
            } else {
                responseMessage = '❌ Invalid date format. Please use DD-MM-YYYY (e.g., 25-01-2026)';
            }
        }
        // Booking time
        else if (session.current_state === STATES.BOOKING_TIME) {
            const timeMatch = message.match(/(\d{2}):(\d{2})/);
            if (timeMatch) {
                updatedData.bookingTime = message;
                responseMessage = '👥 *Number of Guests*\n\n';
                responseMessage += 'How many people will be dining?';
                newState = STATES.BOOKING_GUESTS;
            } else {
                responseMessage = '❌ Invalid time format. Please use HH:MM (e.g., 19:30)';
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
                responseMessage += 'Type "menu" for more options.';

                newState = STATES.MAIN_MENU;
                updatedData = {};
            } else {
                responseMessage = '❌ Sorry, there was an error processing your booking. Please try again or contact support.';
            }
        }

        await updateUserSession(phoneNumber, newState, updatedData);
        return responseMessage;

    } catch (error) {
        console.error('❌ Error handling message:', error);
        return '❌ Sorry, something went wrong. Please type "menu" to restart.';
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
        await sendWhatsAppMessage(from.replace('whatsapp:', ''), response);

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

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 SMART RESTAURANT BOT - FULLY DYNAMIC`);
    console.log(`${'='.repeat(60)}\n`);
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📱 Webhook URL: https://your-domain.railway.app/webhook\n`);
    
    try {
        // Load restaurants on startup
        const restaurantData = await loadRestaurantsFromDatabase();
        console.log(`✅ Loaded ${restaurantData.data.length} restaurants from database`);
        console.log(`✅ Active keywords: ${Object.keys(restaurantData.keywords).join(', ')}\n`);
        
        // Display restaurant details
        console.log('📋 Restaurant Configuration:\n');
        restaurantData.data.forEach(r => {
            console.log(`   ${r.name}`);
            console.log(`   ├─ Keyword: ${r.qr_keyword || 'Not set'}`);
            console.log(`   ├─ WhatsApp: ${r.whatsapp_number || 'Not set'}`);
            console.log(`   ├─ Delivery: ${r.delivery_available ? '✅' : '❌'}`);
            console.log(`   └─ Booking: ${r.table_booking_available ? '✅' : '❌'}\n`);
        });
        
    } catch (error) {
        console.error('⚠️ Warning: Could not load restaurants on startup');
        console.error('   Error:', error.message);
    }
    
    console.log(`${'='.repeat(60)}`);
    console.log('Bot is ready to receive messages! 🎉');
    console.log(`${'='.repeat(60)}\n`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('\n⚠️ SIGTERM received, closing server gracefully...');
    await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\n⚠️ SIGINT received, closing server gracefully...');
    await pool.end();
    process.exit(0);
});
