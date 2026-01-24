require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Twilio client
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// Session states
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

// Helper function to send WhatsApp message
async function sendWhatsAppMessage(to, body) {
    try {
        const message = await twilioClient.messages.create({
            body: body,
            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
            to: `whatsapp:${to}`
        });
        console.log(`Message sent: ${message.sid}`);
        return message;
    } catch (error) {
        console.error('Error sending message:', error);
        throw error;
    }
}

// Get or create user session
async function getUserSession(phoneNumber) {
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
}

// Update user session
async function updateUserSession(phoneNumber, state, data = null) {
    const updates = ['current_state = $2', 'last_activity = CURRENT_TIMESTAMP'];
    const params = [phoneNumber, state];
    
    if (data !== null) {
        updates.push('session_data = $3');
        params.push(JSON.stringify(data));
    }
    
    const query = `UPDATE user_sessions SET ${updates.join(', ')} WHERE phone_number = $1 RETURNING *`;
    const result = await pool.query(query, params);
    return result.rows[0];
}

// Get session data
function getSessionData(session) {
    return typeof session.session_data === 'string' 
        ? JSON.parse(session.session_data) 
        : session.session_data;
}

// Main menu message
function getMainMenuMessage() {
    return `🍽️ *Welcome to Restaurant Bot!*

What would you like to do today?

1️⃣ Order Delivery
2️⃣ Book a Table
3️⃣ View Restaurants

Reply with the number of your choice.`;
}

// Get restaurants list
async function getRestaurantsList() {
    const result = await pool.query(
        'SELECT * FROM restaurants ORDER BY name'
    );
    
    let message = '🏪 *Available Restaurants:*\n\n';
    result.rows.forEach((restaurant, index) => {
        message += `${index + 1}️⃣ *${restaurant.name}*\n`;
        message += `   ${restaurant.cuisine_type}\n`;
        message += `   📍 ${restaurant.address}\n`;
        if (restaurant.delivery_available) {
            message += `   🚚 Delivery: ₹${restaurant.delivery_fee} (Min order: ₹${restaurant.min_delivery_amount})\n`;
        }
        if (restaurant.table_booking_available) {
            message += `   🪑 Table booking available\n`;
        }
        message += `   ⏰ ${restaurant.opening_time.substring(0, 5)} - ${restaurant.closing_time.substring(0, 5)}\n\n`;
    });
    
    message += 'Reply with the restaurant number to continue.';
    return { message, restaurants: result.rows };
}

// Get menu for restaurant
async function getRestaurantMenu(restaurantId) {
    const restaurant = await pool.query(
        'SELECT * FROM restaurants WHERE id = $1',
        [restaurantId]
    );
    
    const menuItems = await pool.query(
        'SELECT * FROM menu_items WHERE restaurant_id = $1 AND is_available = true ORDER BY category, name',
        [restaurantId]
    );
    
    let message = `📋 *${restaurant.rows[0].name} - Menu*\n\n`;
    
    const categories = {};
    menuItems.rows.forEach(item => {
        if (!categories[item.category]) {
            categories[item.category] = [];
        }
        categories[item.category].push(item);
    });
    
    for (const [category, items] of Object.entries(categories)) {
        message += `*${category.toUpperCase()}*\n`;
        items.forEach((item, index) => {
            const vegSymbol = item.is_vegetarian ? '🟢' : '🔴';
            message += `${vegSymbol} ${item.id}. ${item.name} - ₹${item.price}\n`;
            if (item.description) {
                message += `   _${item.description}_\n`;
            }
        });
        message += '\n';
    }
    
    return { message, menuItems: menuItems.rows };
}

// Process order items
async function addOrderItem(sessionData, itemId, quantity) {
    if (!sessionData.cart) {
        sessionData.cart = [];
    }
    
    const menuItem = await pool.query(
        'SELECT * FROM menu_items WHERE id = $1',
        [itemId]
    );
    
    if (menuItem.rows.length === 0) {
        return { success: false, message: '❌ Invalid item ID. Please try again.' };
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
}

// Get cart summary
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
        message += `   Qty: ${item.quantity} × ₹${item.price} = ₹${itemTotal}\n\n`;
    });
    
    message += `Subtotal: ₹${subtotal}\n`;
    if (deliveryFee > 0) {
        message += `Delivery Fee: ₹${deliveryFee}\n`;
    }
    message += `*Total: ₹${subtotal + deliveryFee}*`;
    
    return message;
}

// Create order in database
async function createOrder(phoneNumber, sessionData) {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const restaurant = await client.query(
            'SELECT * FROM restaurants WHERE id = $1',
            [sessionData.selectedRestaurant]
        );
        
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
        return { success: true, orderId, order: orderResult.rows[0] };
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating order:', error);
        return { success: false, error };
    } finally {
        client.release();
    }
}

// Create table booking
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
        
        return { success: true, bookingId: result.rows[0].id, booking: result.rows[0] };
    } catch (error) {
        console.error('Error creating booking:', error);
        return { success: false, error };
    }
}

// Handle incoming messages
async function handleIncomingMessage(from, body) {
    const phoneNumber = from.replace('whatsapp:', '');
    const message = body.trim().toLowerCase();
    
    const session = await getUserSession(phoneNumber);
    const sessionData = getSessionData(session);
    
    let responseMessage = '';
    let newState = session.current_state;
    let updatedData = { ...sessionData };
    
    // Handle main menu
    if (message === 'menu' || message === 'restart' || session.current_state === STATES.MAIN_MENU) {
        if (message === 'menu' || message === 'restart') {
            responseMessage = getMainMenuMessage();
            newState = STATES.MAIN_MENU;
            updatedData = {};
        } else if (message === '1') {
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
            newState = STATES.MAIN_MENU;
        } else {
            responseMessage = getMainMenuMessage();
        }
    }
    // Handle restaurant selection
    else if (session.current_state === STATES.SELECT_RESTAURANT) {
        const restaurantNumber = parseInt(message);
        const restaurants = await pool.query('SELECT * FROM restaurants ORDER BY name');
        
        if (restaurantNumber > 0 && restaurantNumber <= restaurants.rows.length) {
            const selectedRestaurant = restaurants.rows[restaurantNumber - 1];
            updatedData.selectedRestaurant = selectedRestaurant.id;
            updatedData.restaurantName = selectedRestaurant.name;
            
            if (sessionData.action === 'delivery') {
                const menu = await getRestaurantMenu(selectedRestaurant.id);
                responseMessage = menu.message;
                responseMessage += '\n\n*To order:*\n';
                responseMessage += 'Type item ID and quantity (e.g., "15 2" for 2 Mango Lassi)\n';
                responseMessage += 'Type "done" when finished adding items\n';
                responseMessage += 'Type "cart" to view your cart';
                newState = STATES.ADD_ITEMS;
                updatedData.cart = [];
            } else if (sessionData.action === 'booking') {
                responseMessage = `📅 *Table Booking at ${selectedRestaurant.name}*\n\n`;
                responseMessage += 'Please enter the date for your booking\n';
                responseMessage += 'Format: DD-MM-YYYY (e.g., 25-01-2026)';
                newState = STATES.BOOKING_DATE;
            }
        } else {
            responseMessage = '❌ Invalid selection. Please enter a valid restaurant number.';
        }
    }
    // Handle adding items to cart
    else if (session.current_state === STATES.ADD_ITEMS) {
        if (message === 'done') {
            if (!sessionData.cart || sessionData.cart.length === 0) {
                responseMessage = '❌ Your cart is empty. Please add items before proceeding.';
            } else {
                const restaurant = await pool.query('SELECT * FROM restaurants WHERE id = $1', [sessionData.selectedRestaurant]);
                const deliveryFee = parseFloat(restaurant.rows[0].delivery_fee || 0);
                responseMessage = getCartSummary(sessionData, deliveryFee);
                responseMessage += '\n\n📍 Please enter your delivery address:';
                newState = STATES.DELIVERY_ADDRESS;
            }
        } else if (message === 'cart') {
            const restaurant = await pool.query('SELECT * FROM restaurants WHERE id = $1', [sessionData.selectedRestaurant]);
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
                        responseMessage = `✅ Added to cart!\n\n`;
                        const restaurant = await pool.query('SELECT * FROM restaurants WHERE id = $1', [sessionData.selectedRestaurant]);
                        const deliveryFee = parseFloat(restaurant.rows[0].delivery_fee || 0);
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
    // Handle delivery address
    else if (session.current_state === STATES.DELIVERY_ADDRESS) {
        updatedData.deliveryAddress = body.trim();
        responseMessage = '✅ Address saved!\n\n';
        responseMessage += 'Any special instructions? (Type "no" if none)';
        newState = STATES.CONFIRM_ORDER;
    }
    // Handle order confirmation
    else if (session.current_state === STATES.CONFIRM_ORDER) {
        if (message !== 'no') {
            updatedData.specialInstructions = body.trim();
        }
        
        const orderResult = await createOrder(phoneNumber, sessionData);
        
        if (orderResult.success) {
            const restaurant = await pool.query('SELECT * FROM restaurants WHERE id = $1', [sessionData.selectedRestaurant]);
            const deliveryFee = parseFloat(restaurant.rows[0].delivery_fee || 0);
            
            responseMessage = '🎉 *Order Confirmed!*\n\n';
            responseMessage += `Order ID: #${orderResult.orderId}\n`;
            responseMessage += `Restaurant: ${sessionData.restaurantName}\n\n`;
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
            responseMessage = '❌ Sorry, there was an error processing your order. Please try again.';
        }
    }
    // Handle booking date
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
    // Handle booking time
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
    // Handle number of guests
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
    // Handle customer name for booking
    else if (session.current_state === STATES.BOOKING_NAME) {
        updatedData.customerName = body.trim();
        responseMessage = '📝 Any special requests? (Type "no" if none)';
        newState = STATES.CONFIRM_BOOKING;
    }
    // Handle booking confirmation
    else if (session.current_state === STATES.CONFIRM_BOOKING) {
        if (message !== 'no') {
            updatedData.specialRequests = body.trim();
        }
        
        const bookingResult = await createBooking(phoneNumber, sessionData);
        
        if (bookingResult.success) {
            responseMessage = '🎉 *Table Booking Confirmed!*\n\n';
            responseMessage += `Booking ID: #${bookingResult.bookingId}\n`;
            responseMessage += `Restaurant: ${sessionData.restaurantName}\n`;
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
            responseMessage = '❌ Sorry, there was an error processing your booking. Please try again.';
        }
    }
    
    await updateUserSession(phoneNumber, newState, updatedData);
    return responseMessage;
}

// Webhook endpoint for incoming messages
app.post('/webhook', async (req, res) => {
    try {
        const from = req.body.From;
        const body = req.body.Body;
        
        console.log(`Received message from ${from}: ${body}`);
        
        const response = await handleIncomingMessage(from, body);
        await sendWhatsAppMessage(from.replace('whatsapp:', ''), response);
        
        res.status(200).send('OK');
    } catch (error) {
        console.error('Error handling webhook:', error);
        res.status(500).send('Error');
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Restaurant Bot server running on port ${PORT}`);
    console.log(`📱 Webhook URL: https://your-domain.com/webhook`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing server...');
    await pool.end();
    process.exit(0);
});