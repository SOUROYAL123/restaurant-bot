// ============================================
// RESTAURANT WHATSAPP BOT - PRODUCTION v3.0
// Multi-Restaurant Order & Booking System
// ============================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { Pool } = require('pg');
const path = require('path');

// Import feature modules
const { sendToGoogleSheets, getSheetsStatus } = require('./features/sheets');
const { 
  createPaymentLink, 
  verifyPayment, 
  handlePaymentWebhook,
  getPaymentMessage 
} = require('./features/payment');
const { FEATURES } = require('./features/config');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE
// ============================================
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Trust Railway proxy
app.set('trust proxy', true);

// ============================================
// TWILIO SETUP
// ============================================
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const wabaNumber = process.env.WABA_NUMBER;

if (!accountSid || !authToken || !wabaNumber) {
  console.error('❌ Missing Twilio credentials in .env file');
  process.exit(1);
}

const twilioClient = twilio(accountSid, authToken);

// ============================================
// DATABASE CONNECTION (Scalable Configuration)
// ============================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000'),
  max: parseInt(process.env.DB_POOL_MAX || '50'),
  min: parseInt(process.env.DB_POOL_MIN || '10'),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000')
});

// Database connection handler with retry
let dbConnected = false;
const connectDB = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const client = await pool.connect();
      console.log('✅ Database connected successfully');
      dbConnected = true;
      client.release();
      return;
    } catch (err) {
      console.error(`❌ Database connection attempt ${i + 1} failed:`, err.message);
      if (i < retries - 1) {
        console.log(`⏳ Retrying in 2 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  console.error('❌ Failed to connect to database after multiple attempts');
  process.exit(1);
};

connectDB();

// ============================================
// IN-MEMORY CACHES & SESSIONS (Scalable)
// ============================================
let restaurantCache = [];
let lastCacheUpdate = 0;
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '300000'); // Default: 5 minutes
const CACHE_MAX_SIZE = parseInt(process.env.CACHE_MAX_SIZE || '1000');

const sessions = new Map();
const pendingPayments = new Map(); // Track payment timeouts

// Customer reliability tracking
const customerReliability = new Map();
const FRAUD_LOG = [];

// Session timeout configurations
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT || '1800000'); // 30 minutes
const OTP_TIMEOUT = parseInt(process.env.OTP_TIMEOUT || '300000'); // 5 minutes
const PAYMENT_TIMEOUT = parseInt(process.env.PAYMENT_TIMEOUT || '900000'); // 15 minutes
const COD_CONFIRMATION_TIMEOUT = parseInt(process.env.COD_CONFIRMATION_TIMEOUT || '600000'); // 10 minutes

// ============================================
// RESTAURANT TRIGGERS (case-insensitive)
// ============================================
const RESTAURANT_TRIGGERS = {
  'ZAM ZAM': ['ZAMZAM', 'ZAM ZAM', 'ZAM-ZAM'],
  'SPICE GARDEN': ['SPICEGARDEN', 'SPICE GARDEN', 'SPICE-GARDEN'],
  'CURRY HOUSE': ['CURRYHOUSE', 'CURRY HOUSE', 'CURRY-HOUSE'],
  'BIRYANI EXPRESS': ['BIRYANIEXPRESS', 'BIRYANI EXPRESS', 'BIRYANI-EXPRESS']
};

// ============================================
// STATE MACHINE CONSTANTS
// ============================================
const STATES = {
  INITIAL: 'INITIAL',
  SELECT_SERVICE: 'SELECT_SERVICE',
  ENTER_PHONE: 'ENTER_PHONE',
  VERIFY_OTP: 'VERIFY_OTP',
  BROWSE_MENU: 'BROWSE_MENU',
  CONFIRM_ORDER: 'CONFIRM_ORDER',
  PAYMENT_METHOD: 'PAYMENT_METHOD',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  BOOKING_DATE: 'BOOKING_DATE',
  BOOKING_TIME: 'BOOKING_TIME',
  BOOKING_GUESTS: 'BOOKING_GUESTS',
  BOOKING_CONFIRM: 'BOOKING_CONFIRM'
};

// ============================================
// HELPER FUNCTIONS
// ============================================

// Load restaurants from database
async function loadRestaurants() {
  const now = Date.now();
  if (restaurantCache.length > 0 && (now - lastCacheUpdate) < CACHE_TTL) {
    return restaurantCache;
  }

  try {
    const result = await pool.query(
      'SELECT id, name, phone, address, delivery_fee, min_order FROM restaurants WHERE active = true ORDER BY name'
    );
    restaurantCache = result.rows;
    lastCacheUpdate = now;
    console.log(`📋 Loaded ${restaurantCache.length} restaurants into cache`);
    return restaurantCache;
  } catch (error) {
    console.error('❌ Error loading restaurants:', error);
    return restaurantCache; // Return cached data on error
  }
}

// Get menu items for a restaurant
async function getMenuItems(restaurantId) {
  try {
    const result = await pool.query(
      'SELECT id, name, description, price, category, available FROM menu_items WHERE restaurant_id = $1 AND available = true ORDER BY category, name',
      [restaurantId]
    );
    return result.rows;
  } catch (error) {
    console.error('❌ Error fetching menu:', error);
    return [];
  }
}

// Send WhatsApp message
async function sendMessage(to, body) {
  try {
    const message = await twilioClient.messages.create({
      from: wabaNumber,
      to: `whatsapp:${to}`,
      body: body
    });
    console.log(`✅ Message sent to ${to}: ${message.sid}`);
    return message;
  } catch (error) {
    console.error(`❌ Error sending message to ${to}:`, error.message);
    throw error;
  }
}

// Generate 4-digit OTP
function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// Format menu for display
function formatMenu(menuItems) {
  const grouped = {};
  menuItems.forEach(item => {
    if (!grouped[item.category]) {
      grouped[item.category] = [];
    }
    grouped[item.category].push(item);
  });

  let message = '📋 *MENU*\n\n';
  Object.keys(grouped).forEach(category => {
    message += `*${category.toUpperCase()}*\n`;
    grouped[category].forEach((item, index) => {
      message += `${index + 1}. ${item.name} - ₹${item.price}\n`;
      if (item.description) {
        message += `   _${item.description}_\n`;
      }
    });
    message += '\n';
  });

  message += '💬 *How to order:*\n';
  message += 'Reply with item numbers and quantities\n';
  message += 'Example: 1x2, 3x1 (means 2 of item 1, 1 of item 3)\n\n';
  message += '✅ Type *DONE* when finished\n';
  message += '🗑️ Type *CLEAR* to empty cart';

  return message;
}

// Parse order input
function parseOrderInput(input, menuItems) {
  const items = [];
  const parts = input.split(',').map(p => p.trim());

  for (const part of parts) {
    const match = part.match(/^(\d+)x(\d+)$/i) || part.match(/^(\d+)\s*x\s*(\d+)$/i);
    if (match) {
      const itemIndex = parseInt(match[1]) - 1;
      const quantity = parseInt(match[2]);

      if (itemIndex >= 0 && itemIndex < menuItems.length && quantity > 0) {
        items.push({
          menuItem: menuItems[itemIndex],
          quantity: quantity
        });
      }
    }
  }

  return items;
}

// Format cart for display
function formatCart(cart) {
  if (!cart || cart.length === 0) {
    return '🛒 Your cart is empty';
  }

  let message = '🛒 *YOUR CART*\n\n';
  let subtotal = 0;

  cart.forEach((item, index) => {
    const itemTotal = item.menuItem.price * item.quantity;
    subtotal += itemTotal;
    message += `${index + 1}. ${item.menuItem.name}\n`;
    message += `   ${item.quantity} x ₹${item.menuItem.price} = ₹${itemTotal}\n\n`;
  });

  message += `*Subtotal:* ₹${subtotal}`;
  return message;
}

// Calculate order total
function calculateTotal(cart, deliveryFee = 0) {
  const subtotal = cart.reduce((sum, item) => {
    return sum + (item.menuItem.price * item.quantity);
  }, 0);
  return subtotal + deliveryFee;
}

// Create temporary order before payment
async function createTemporaryOrder(session) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create order
    const orderResult = await client.query(
      `INSERT INTO orders (restaurant_id, customer_phone, customer_name, delivery_address, 
       total_amount, status, payment_status, created_at) 
       VALUES ($1, $2, $3, $4, $5, 'PENDING_PAYMENT', 'PENDING', NOW()) 
       RETURNING id`,
      [
        session.restaurantId,
        session.phone,
        session.customerName || 'Guest',
        session.deliveryAddress || '',
        session.total
      ]
    );

    const orderId = orderResult.rows[0].id;

    // Insert order items
    for (const item of session.cart) {
      await client.query(
        'INSERT INTO order_items (order_id, menu_item_id, quantity, price) VALUES ($1, $2, $3, $4)',
        [orderId, item.menuItem.id, item.quantity, item.menuItem.price]
      );
    }

    await client.query('COMMIT');
    console.log(`✅ Temporary order created: ${orderId}`);
    return orderId;

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error creating temporary order:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Update order status after payment
async function updateOrderAfterPayment(orderId, paymentId, status) {
  try {
    await pool.query(
      `UPDATE orders SET payment_status = $1, payment_id = $2, status = $3, confirmed_at = NOW() 
       WHERE id = $4`,
      [status, paymentId, status === 'PAID' ? 'CONFIRMED' : 'CANCELLED', orderId]
    );
    console.log(`✅ Order ${orderId} updated: ${status}`);
  } catch (error) {
    console.error(`❌ Error updating order ${orderId}:`, error);
  }
}

// Save confirmed order
async function saveOrder(session) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create order
    const orderResult = await client.query(
      `INSERT INTO orders (restaurant_id, customer_phone, customer_name, delivery_address, 
       total_amount, status, payment_status, created_at, confirmed_at) 
       VALUES ($1, $2, $3, $4, $5, 'CONFIRMED', $6, NOW(), NOW()) 
       RETURNING id`,
      [
        session.restaurantId,
        session.phone,
        session.customerName || 'Guest',
        session.deliveryAddress || '',
        session.total,
        session.paymentMethod === 'online' ? 'PAID' : 'COD'
      ]
    );

    const orderId = orderResult.rows[0].id;

    // Insert order items
    for (const item of session.cart) {
      await client.query(
        'INSERT INTO order_items (order_id, menu_item_id, quantity, price) VALUES ($1, $2, $3, $4)',
        [orderId, item.menuItem.id, item.quantity, item.menuItem.price]
      );
    }

    await client.query('COMMIT');
    console.log(`✅ Order saved successfully: ${orderId}`);

    // Send to Google Sheets if enabled
    if (FEATURES.GOOGLE_SHEETS) {
      try {
        await sendToGoogleSheets({
          orderId,
          restaurantName: session.restaurantName,
          customerPhone: session.phone,
          customerName: session.customerName,
          items: session.cart,
          total: session.total,
          paymentMethod: session.paymentMethod || 'COD',
          address: session.deliveryAddress
        });
      } catch (sheetError) {
        console.error('⚠️ Google Sheets logging failed:', sheetError.message);
      }
    }

    return orderId;

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error saving order:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Save table booking
async function saveBooking(session) {
  try {
    const result = await pool.query(
      `INSERT INTO bookings (restaurant_id, customer_phone, customer_name, booking_date, 
       booking_time, guests, status, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW()) 
       RETURNING id`,
      [
        session.restaurantId,
        session.phone,
        session.customerName || 'Guest',
        session.bookingDate,
        session.bookingTime,
        session.guests
      ]
    );

    const bookingId = result.rows[0].id;
    console.log(`✅ Booking saved: ${bookingId}`);
    return bookingId;

  } catch (error) {
    console.error('❌ Error saving booking:', error);
    throw error;
  }
}

// Customer reliability tracking
function getCustomerReliability(phone) {
  if (!customerReliability.has(phone)) {
    customerReliability.set(phone, {
      totalOrders: 0,
      confirmed: 0,
      cancelled: 0,
      noResponse: 0,
      trustScore: 100,
      lastOrderDate: null,
      blocked: false
    });
  }
  return customerReliability.get(phone);
}

function updateReliability(phone, outcome) {
  const reliability = getCustomerReliability(phone);
  reliability.totalOrders++;
  reliability.lastOrderDate = new Date();

  if (outcome === 'confirmed') {
    reliability.confirmed++;
    reliability.trustScore = Math.min(100, reliability.trustScore + 5);
  } else if (outcome === 'cancelled') {
    reliability.cancelled++;
    reliability.trustScore = Math.max(0, reliability.trustScore - 10);
  } else if (outcome === 'no_response') {
    reliability.noResponse++;
    reliability.trustScore = Math.max(0, reliability.trustScore - 15);
  }

  // Auto-block if trust score too low
  if (reliability.trustScore < 30) {
    reliability.blocked = true;
    FRAUD_LOG.push({
      phone,
      reason: 'Low trust score',
      trustScore: reliability.trustScore,
      timestamp: new Date()
    });
    console.log(`🚫 Customer ${phone} auto-blocked (trust score: ${reliability.trustScore})`);
  }

  customerReliability.set(phone, reliability);
  console.log(`📊 Reliability updated for ${phone}: Score ${reliability.trustScore}`);
}

// Notify restaurant owner (scalable - uses database)
async function notifyOwner(session, orderId, type = 'order') {
  try {
    // Fetch owner phone from database (scalable for 100+ restaurants)
    const result = await pool.query(
      'SELECT phone, owner_name FROM restaurants WHERE id = $1',
      [session.restaurantId]
    );

    if (!result.rows.length || !result.rows[0].phone) {
      console.log(`⚠️ No owner phone in database for restaurant ID ${session.restaurantId}`);
      return;
    }

    const ownerPhone = result.rows[0].phone;
    const ownerName = result.rows[0].owner_name || 'Owner';

    let message = '';

    if (type === 'order') {
      const paymentStatus = session.paymentMethod === 'online' ? '💳 PAID' : '💵 COD';
      message = `🔔 *NEW ORDER #${orderId}*\n\n`;
      message += `🍽️ Restaurant: ${session.restaurantName}\n`;
      message += `📱 Customer: ${session.phone}\n`;
      message += `👤 Name: ${session.customerName || 'Not provided'}\n`;
      message += `📍 Address: ${session.deliveryAddress || 'Not provided'}\n\n`;
      message += `*Items:*\n`;
      session.cart.forEach(item => {
        message += `• ${item.quantity}x ${item.menuItem.name} (₹${item.menuItem.price})\n`;
      });
      message += `\n💰 *Total: ₹${session.total}*\n`;
      message += `${paymentStatus}\n\n`;
      message += `⏰ ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
    } else if (type === 'booking') {
      message = `🔔 *NEW TABLE BOOKING #${orderId}*\n\n`;
      message += `🍽️ Restaurant: ${session.restaurantName}\n`;
      message += `📱 Customer: ${session.phone}\n`;
      message += `👤 Name: ${session.customerName || 'Not provided'}\n`;
      message += `📅 Date: ${session.bookingDate}\n`;
      message += `🕐 Time: ${session.bookingTime}\n`;
      message += `👥 Guests: ${session.guests}\n\n`;
      message += `⏰ ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
    }

    await sendMessage(ownerPhone, message);
    console.log(`✅ Owner notification sent to ${ownerPhone} (${ownerName})`);

  } catch (error) {
    console.error('❌ Error notifying owner:', error.message);
  }
}

// Parse flexible date input
function parseDate(input) {
  const today = new Date();
  const inputLower = input.toLowerCase().trim();

  // Handle "today", "tomorrow"
  if (inputLower === 'today') {
    return today.toISOString().split('T')[0];
  }
  if (inputLower === 'tomorrow') {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }

  // Try parsing DD/MM/YYYY or DD-MM-YYYY
  const match = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];
    return `${year}-${month}-${day}`;
  }

  return null;
}

// ============================================
// MAIN WEBHOOK HANDLER
// ============================================

app.post('/webhook', async (req, res) => {
  try {
    const { From, Body } = req.body;

    if (!From || !Body) {
      return res.status(400).send('Missing From or Body');
    }

    const customerPhone = From.replace('whatsapp:', '');
    const messageText = Body.trim();
    const messageUpper = messageText.toUpperCase();

    console.log(`📱 Message from ${customerPhone}: ${messageText}`);

    // Load restaurants
    await loadRestaurants();

    // ============================================
    // ✅ FIX: ALWAYS CHECK RESTAURANT TRIGGERS FIRST
    // This allows users to start fresh anytime
    // ============================================
    const restaurantTrigger = Object.entries(RESTAURANT_TRIGGERS).find(
      ([name, triggers]) => triggers.some(t => messageUpper.includes(t))
    );

    if (restaurantTrigger) {
      const [restaurantName] = restaurantTrigger;
      const restaurant = restaurantCache.find(r => 
        r.name.toUpperCase() === restaurantName.toUpperCase()
      );

      if (restaurant) {
        // Clear any existing session
        let session = sessions.get(customerPhone);
        if (session) {
          if (session.otpTimeout) clearTimeout(session.otpTimeout);
          if (session.confirmationTimeout) clearTimeout(session.confirmationTimeout);
          console.log(`🔄 Resetting session for ${customerPhone}`);
        }

        // Start fresh session
        session = {
          phone: customerPhone,
          state: STATES.SELECT_SERVICE,
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          deliveryFee: restaurant.delivery_fee,
          minOrder: restaurant.min_order,
          createdAt: Date.now()
        };

        sessions.set(customerPhone, session);

        await sendMessage(
          customerPhone,
          `🍽️ Welcome to *${restaurant.name}*!\n\n` +
          `Please select a service:\n\n` +
          `1️⃣ Order Delivery\n` +
          `2️⃣ Book a Table\n\n` +
          `Reply with *1* or *2*`
        );
        return res.status(200).send('OK');
      }
    }

    // ============================================
    // Get or create session
    // ============================================
    let session = sessions.get(customerPhone);

    // ============================================
    // ✅ FIX: HANDLE GREETINGS
    // ============================================
    const greetings = ['hi', 'hello', 'hey', 'start', 'menu', 'reset', 'help'];
    if (!session || session.state === STATES.INITIAL) {
      if (greetings.some(g => messageText.toLowerCase().includes(g))) {
        await sendMessage(
          customerPhone,
          `👋 *Welcome to our Restaurant Network!*\n\n` +
          `📍 *Available Restaurants:*\n\n` +
          `🍗 *ZAM ZAM*\n   Type: *ZAMZAM*\n\n` +
          `🌶️ *SPICE GARDEN*\n   Type: *SPICEGARDEN*\n\n` +
          `🍛 *CURRY HOUSE*\n   Type: *CURRYHOUSE*\n\n` +
          `🍚 *BIRYANI EXPRESS*\n   Type: *BIRYANIEXPRESS*\n\n` +
          `Type any restaurant name to begin! 🎉`
        );
        return res.status(200).send('OK');
      }
    }

    // No session - guide user
    if (!session) {
      await sendMessage(
        customerPhone,
        `👋 Hello! To start ordering, please type a restaurant name:\n\n` +
        `*ZAMZAM* | *SPICEGARDEN* | *CURRYHOUSE* | *BIRYANIEXPRESS*\n\n` +
        `Or type *HI* to see all restaurants.`
      );
      return res.status(200).send('OK');
    }

    // Check for blocked customers (COD only)
    const reliability = getCustomerReliability(customerPhone);
    if (reliability.blocked && session.state === STATES.PAYMENT_METHOD) {
      await sendMessage(
        customerPhone,
        `⚠️ Due to previous order cancellations, COD is not available.\n\n` +
        `Please use online payment or contact us to restore access.`
      );
      return res.status(200).send('OK');
    }

    // ============================================
    // STATE MACHINE
    // ============================================

    // SELECT_SERVICE State
    if (session.state === STATES.SELECT_SERVICE) {
      if (messageText === '1') {
        session.state = STATES.ENTER_PHONE;
        session.serviceType = 'delivery';
        sessions.set(customerPhone, session);

        await sendMessage(
          customerPhone,
          `📱 Please enter your phone number for order confirmation:\n\n` +
          `Example: +919876543210 or 9876543210`
        );
        return res.status(200).send('OK');
      }

      if (messageText === '2') {
        session.state = STATES.ENTER_PHONE;
        session.serviceType = 'booking';
        sessions.set(customerPhone, session);

        await sendMessage(
          customerPhone,
          `📱 Please enter your phone number for booking confirmation:\n\n` +
          `Example: +919876543210 or 9876543210`
        );
        return res.status(200).send('OK');
      }

      await sendMessage(
        customerPhone,
        `❌ Invalid choice.\n\n` +
        `Please reply with:\n` +
        `1️⃣ for Order Delivery\n` +
        `2️⃣ for Book a Table`
      );
      return res.status(200).send('OK');
    }

    // ENTER_PHONE State
    if (session.state === STATES.ENTER_PHONE) {
      const phone = messageText.replace(/\D/g, '');

      if (phone.length === 10) {
        session.verifiedPhone = `+91${phone}`;
      } else if (phone.length === 12 && phone.startsWith('91')) {
        session.verifiedPhone = `+${phone}`;
      } else {
        await sendMessage(
          customerPhone,
          `❌ Invalid phone number format.\n\n` +
          `Please enter a 10-digit number:\n` +
          `Example: 9876543210`
        );
        return res.status(200).send('OK');
      }

      // Generate OTP
      session.otp = generateOTP();
      session.state = STATES.VERIFY_OTP;
      session.otpAttempts = 0;

      // Set OTP timeout (configurable)
      session.otpTimeout = setTimeout(() => {
        sessions.delete(customerPhone);
        sendMessage(customerPhone, '⏱️ OTP expired. Please start over by typing the restaurant name.');
      }, OTP_TIMEOUT);

      sessions.set(customerPhone, session);

      await sendMessage(
        customerPhone,
        `🔐 Your OTP is: *${session.otp}*\n\n` +
        `Please reply with this code to verify.\n` +
        `(Valid for 5 minutes)`
      );
      return res.status(200).send('OK');
    }

    // VERIFY_OTP State
    if (session.state === STATES.VERIFY_OTP) {
      if (messageText === session.otp) {
        clearTimeout(session.otpTimeout);
        session.otpAttempts = 0;

        if (session.serviceType === 'delivery') {
          session.state = STATES.BROWSE_MENU;
          session.cart = [];
          sessions.set(customerPhone, session);

          const menuItems = await getMenuItems(session.restaurantId);
          session.menuItems = menuItems;
          sessions.set(customerPhone, session);

          await sendMessage(customerPhone, formatMenu(menuItems));
          return res.status(200).send('OK');
        }

        if (session.serviceType === 'booking') {
          session.state = STATES.BOOKING_DATE;
          sessions.set(customerPhone, session);

          await sendMessage(
            customerPhone,
            `📅 When would you like to book?\n\n` +
            `Type:\n` +
            `• *TODAY* or *TOMORROW*\n` +
            `• Or enter date: DD/MM/YYYY\n` +
            `Example: 15/02/2024`
          );
          return res.status(200).send('OK');
        }
      } else {
        session.otpAttempts++;
        if (session.otpAttempts >= 3) {
          clearTimeout(session.otpTimeout);
          sessions.delete(customerPhone);
          await sendMessage(
            customerPhone,
            `❌ Too many failed attempts. Please start over by typing the restaurant name.`
          );
          return res.status(200).send('OK');
        }

        await sendMessage(
          customerPhone,
          `❌ Incorrect OTP. Please try again.\n` +
          `(${3 - session.otpAttempts} attempts remaining)`
        );
        return res.status(200).send('OK');
      }
    }

    // BROWSE_MENU State
    if (session.state === STATES.BROWSE_MENU) {
      if (messageUpper === 'DONE') {
        if (!session.cart || session.cart.length === 0) {
          await sendMessage(customerPhone, `🛒 Your cart is empty. Please add items first.`);
          return res.status(200).send('OK');
        }

        const subtotal = session.cart.reduce((sum, item) => {
          return sum + (item.menuItem.price * item.quantity);
        }, 0);

        // Check minimum order
        if (subtotal < session.minOrder) {
          await sendMessage(
            customerPhone,
            `⚠️ Minimum order amount is ₹${session.minOrder}\n` +
            `Your current cart: ₹${subtotal}\n\n` +
            `Please add ₹${session.minOrder - subtotal} more to proceed.`
          );
          return res.status(200).send('OK');
        }

        session.state = STATES.CONFIRM_ORDER;
        session.total = calculateTotal(session.cart, session.deliveryFee);
        sessions.set(customerPhone, session);

        let message = formatCart(session.cart);
        message += `\n\n📍 *Delivery Details:*\n`;
        message += `Delivery Fee: ₹${session.deliveryFee}\n`;
        message += `*Grand Total: ₹${session.total}*\n\n`;
        message += `Please provide:\n`;
        message += `1️⃣ Your name\n`;
        message += `2️⃣ Delivery address\n\n`;
        message += `Example:\n`;
        message += `John Doe\n`;
        message += `123 Park Street, Kolkata`;

        await sendMessage(customerPhone, message);
        return res.status(200).send('OK');
      }

      if (messageUpper === 'CLEAR') {
        session.cart = [];
        sessions.set(customerPhone, session);
        await sendMessage(customerPhone, `🗑️ Cart cleared!\n\n` + formatMenu(session.menuItems));
        return res.status(200).send('OK');
      }

      // Parse order
      const newItems = parseOrderInput(messageText, session.menuItems);
      if (newItems.length > 0) {
        session.cart.push(...newItems);
        sessions.set(customerPhone, session);

        let message = `✅ Added to cart!\n\n`;
        message += formatCart(session.cart);
        message += `\n\n💬 Add more items or type *DONE* to checkout`;

        await sendMessage(customerPhone, message);
        return res.status(200).send('OK');
      }

      await sendMessage(
        customerPhone,
        `❌ Invalid format.\n\n` +
        `Example: 1x2, 3x1\n` +
        `Or type *DONE* to checkout`
      );
      return res.status(200).send('OK');
    }

    // CONFIRM_ORDER State
    if (session.state === STATES.CONFIRM_ORDER) {
      const lines = messageText.split('\n').map(l => l.trim()).filter(l => l);

      if (lines.length >= 2) {
        session.customerName = lines[0];
        session.deliveryAddress = lines.slice(1).join(', ');

        // Payment selection
        session.state = STATES.PAYMENT_METHOD;
        sessions.set(customerPhone, session);

        let message = `✅ Details confirmed!\n\n`;
        message += `👤 Name: ${session.customerName}\n`;
        message += `📍 Address: ${session.deliveryAddress}\n`;
        message += `💰 Total: ₹${session.total}\n\n`;
        message += `*Select Payment Method:*\n\n`;
        message += `1️⃣ Online Payment (Razorpay)\n`;
        message += `2️⃣ Cash on Delivery\n\n`;
        message += `Reply with *1* or *2*`;

        await sendMessage(customerPhone, message);
        return res.status(200).send('OK');
      }

      await sendMessage(
        customerPhone,
        `❌ Please provide:\n` +
        `Line 1: Your name\n` +
        `Line 2+: Delivery address\n\n` +
        `Example:\n` +
        `John Doe\n` +
        `123 Park Street, Kolkata`
      );
      return res.status(200).send('OK');
    }

    // PAYMENT_METHOD State
    if (session.state === STATES.PAYMENT_METHOD) {
      // Online Payment
      if (messageText === '1' && FEATURES.PAYMENT) {
        try {
          // Create temporary order
          const tempOrderId = await createTemporaryOrder(session);
          session.tempOrderId = tempOrderId;

          // Generate payment link
          const paymentData = await createPaymentLink({
            amount: session.total,
            customerPhone: session.verifiedPhone,
            customerName: session.customerName,
            orderId: tempOrderId,
            description: `Order from ${session.restaurantName}`
          });

          if (paymentData && paymentData.short_url) {
            session.state = STATES.AWAITING_PAYMENT;
            session.paymentId = paymentData.id;
            session.paymentLink = paymentData.short_url;
            sessions.set(customerPhone, session);

            // Set payment timeout (configurable)
            const paymentTimeout = setTimeout(async () => {
              const currentSession = sessions.get(customerPhone);
              if (currentSession && currentSession.state === STATES.AWAITING_PAYMENT) {
                await updateOrderAfterPayment(tempOrderId, null, 'CANCELLED');
                sessions.delete(customerPhone);
                await sendMessage(
                  customerPhone,
                  `⏱️ Payment time expired. Order cancelled.\n\n` +
                  `Type restaurant name to start over.`
                );
              }
              pendingPayments.delete(customerPhone);
            }, PAYMENT_TIMEOUT);

            pendingPayments.set(customerPhone, paymentTimeout);

            await sendMessage(
              customerPhone,
              `💳 *Payment Required*\n\n` +
              `Amount: ₹${session.total}\n\n` +
              `Click here to pay:\n${paymentData.short_url}\n\n` +
              `⏱️ Link expires in 15 minutes\n\n` +
              `After payment:\n` +
              `• Type *CHECK* to verify\n` +
              `• Type *CANCEL* to cancel order`
            );
            return res.status(200).send('OK');
          } else {
            throw new Error('Failed to create payment link');
          }
        } catch (error) {
          console.error('❌ Payment creation error:', error);
          await sendMessage(
            customerPhone,
            `❌ Payment system error. Please try:\n\n` +
            `1️⃣ Online Payment (retry)\n` +
            `2️⃣ Cash on Delivery`
          );
          return res.status(200).send('OK');
        }
      }

      // Cash on Delivery
      if (messageText === '2') {
        session.state = STATES.AWAITING_CONFIRMATION;
        session.paymentMethod = 'cod';
        sessions.set(customerPhone, session);

        // Set confirmation timeout (configurable)
        session.confirmationTimeout = setTimeout(async () => {
          const currentSession = sessions.get(customerPhone);
          if (currentSession && currentSession.state === STATES.AWAITING_CONFIRMATION) {
            updateReliability(customerPhone, 'no_response');
            sessions.delete(customerPhone);
            await sendMessage(
              customerPhone,
              `⏱️ No response received. Order cancelled.\n\n` +
              `Type restaurant name to start over.`
            );
          }
        }, COD_CONFIRMATION_TIMEOUT);

        await sendMessage(
          customerPhone,
          `📋 *ORDER SUMMARY*\n\n` +
          `${formatCart(session.cart)}\n\n` +
          `📍 *Delivery:*\n${session.deliveryAddress}\n\n` +
          `💰 *Grand Total:* ₹${session.total}\n` +
          `💵 Payment: Cash on Delivery\n\n` +
          `⏰ *Please confirm within 10 minutes*\n\n` +
          `Reply:\n` +
          `✅ *YES* to confirm\n` +
          `❌ *NO* to cancel`
        );
        return res.status(200).send('OK');
      }

      await sendMessage(
        customerPhone,
        `❌ Invalid choice.\n\n` +
        `Please reply with:\n` +
        `1️⃣ for Online Payment\n` +
        `2️⃣ for Cash on Delivery`
      );
      return res.status(200).send('OK');
    }

    // AWAITING_PAYMENT State
    if (session.state === STATES.AWAITING_PAYMENT) {
      if (messageUpper === 'CHECK') {
        try {
          const paymentStatus = await verifyPayment(session.paymentId);

          if (paymentStatus === 'paid') {
            // Clear timeout
            const timeout = pendingPayments.get(customerPhone);
            if (timeout) clearTimeout(timeout);
            pendingPayments.delete(customerPhone);

            // Update order
            await updateOrderAfterPayment(session.tempOrderId, session.paymentId, 'PAID');

            // Update session
            session.paymentMethod = 'online';
            const orderId = session.tempOrderId;

            // Update reliability
            updateReliability(customerPhone, 'confirmed');

            // Notify owner
            await notifyOwner(session, orderId, 'order');

            // Clear session
            sessions.delete(customerPhone);

            await sendMessage(
              customerPhone,
              `✅ *Payment Successful!*\n\n` +
              `🎉 Order #${orderId} confirmed!\n\n` +
              `${formatCart(session.cart)}\n\n` +
              `💰 Paid: ₹${session.total}\n` +
              `📍 Delivery to: ${session.deliveryAddress}\n\n` +
              `🍽️ Your order will be delivered soon!\n` +
              `Thank you for ordering from ${session.restaurantName}! 🙏`
            );
            return res.status(200).send('OK');
          } else {
            await sendMessage(
              customerPhone,
              `⏳ Payment not yet received.\n\n` +
              `Please complete payment and type *CHECK* again.\n` +
              `Or type *CANCEL* to cancel order.`
            );
            return res.status(200).send('OK');
          }
        } catch (error) {
          console.error('❌ Payment verification error:', error);
          await sendMessage(
            customerPhone,
            `❌ Unable to verify payment. Please try again or contact support.`
          );
          return res.status(200).send('OK');
        }
      }

      if (messageUpper === 'CANCEL') {
        const timeout = pendingPayments.get(customerPhone);
        if (timeout) clearTimeout(timeout);
        pendingPayments.delete(customerPhone);

        await updateOrderAfterPayment(session.tempOrderId, null, 'CANCELLED');
        updateReliability(customerPhone, 'cancelled');
        sessions.delete(customerPhone);

        await sendMessage(
          customerPhone,
          `❌ Order cancelled.\n\n` +
          `Type restaurant name to start a new order.`
        );
        return res.status(200).send('OK');
      }

      await sendMessage(
        customerPhone,
        `Please:\n` +
        `✅ Type *CHECK* to verify payment\n` +
        `❌ Type *CANCEL* to cancel order`
      );
      return res.status(200).send('OK');
    }

    // AWAITING_CONFIRMATION State (COD)
    if (session.state === STATES.AWAITING_CONFIRMATION) {
      if (messageUpper === 'YES') {
        clearTimeout(session.confirmationTimeout);

        try {
          const orderId = await saveOrder(session);
          updateReliability(customerPhone, 'confirmed');

          // Notify owner
          await notifyOwner(session, orderId, 'order');

          sessions.delete(customerPhone);

          await sendMessage(
            customerPhone,
            `✅ *Order Confirmed!*\n\n` +
            `🎉 Order #${orderId}\n\n` +
            `${formatCart(session.cart)}\n\n` +
            `💰 Total: ₹${session.total} (COD)\n` +
            `📍 Delivery to: ${session.deliveryAddress}\n\n` +
            `🍽️ Your order will be delivered soon!\n` +
            `Thank you for ordering from ${session.restaurantName}! 🙏`
          );
          return res.status(200).send('OK');

        } catch (error) {
          console.error('❌ Order save error:', error);
          await sendMessage(
            customerPhone,
            `❌ Error saving order. Please contact support.`
          );
          return res.status(200).send('OK');
        }
      }

      if (messageUpper === 'NO') {
        clearTimeout(session.confirmationTimeout);
        updateReliability(customerPhone, 'cancelled');
        sessions.delete(customerPhone);

        await sendMessage(
          customerPhone,
          `❌ Order cancelled.\n\n` +
          `Type restaurant name to start a new order.`
        );
        return res.status(200).send('OK');
      }

      await sendMessage(
        customerPhone,
        `Please confirm:\n` +
        `✅ Reply *YES* to confirm order\n` +
        `❌ Reply *NO* to cancel`
      );
      return res.status(200).send('OK');
    }

    // BOOKING_DATE State
    if (session.state === STATES.BOOKING_DATE) {
      const date = parseDate(messageText);
      if (!date) {
        await sendMessage(
          customerPhone,
          `❌ Invalid date format.\n\n` +
          `Please type:\n` +
          `• TODAY or TOMORROW\n` +
          `• Or: DD/MM/YYYY (e.g., 15/02/2024)`
        );
        return res.status(200).send('OK');
      }

      session.bookingDate = date;
      session.state = STATES.BOOKING_TIME;
      sessions.set(customerPhone, session);

      await sendMessage(
        customerPhone,
        `🕐 What time would you like to book?\n\n` +
        `Format: HH:MM\n` +
        `Example: 19:30 or 7:30 PM`
      );
      return res.status(200).send('OK');
    }

    // BOOKING_TIME State
    if (session.state === STATES.BOOKING_TIME) {
      const timeMatch = messageText.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
      if (!timeMatch) {
        await sendMessage(
          customerPhone,
          `❌ Invalid time format.\n\n` +
          `Please enter time:\n` +
          `Example: 19:30 or 7:30 PM`
        );
        return res.status(200).send('OK');
      }

      let hours = parseInt(timeMatch[1]);
      const minutes = timeMatch[2];
      const ampm = timeMatch[3];

      if (ampm) {
        if (ampm.toUpperCase() === 'PM' && hours < 12) hours += 12;
        if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
      }

      session.bookingTime = `${hours.toString().padStart(2, '0')}:${minutes}:00`;
      session.state = STATES.BOOKING_GUESTS;
      sessions.set(customerPhone, session);

      await sendMessage(
        customerPhone,
        `👥 How many guests?\n\n` +
        `Enter number of people (1-20)`
      );
      return res.status(200).send('OK');
    }

    // BOOKING_GUESTS State
    if (session.state === STATES.BOOKING_GUESTS) {
      const guests = parseInt(messageText);
      if (isNaN(guests) || guests < 1 || guests > 20) {
        await sendMessage(
          customerPhone,
          `❌ Please enter a valid number (1-20)`
        );
        return res.status(200).send('OK');
      }

      session.guests = guests;
      session.state = STATES.BOOKING_CONFIRM;
      sessions.set(customerPhone, session);

      await sendMessage(
        customerPhone,
        `📋 *BOOKING SUMMARY*\n\n` +
        `🍽️ Restaurant: ${session.restaurantName}\n` +
        `📅 Date: ${session.bookingDate}\n` +
        `🕐 Time: ${session.bookingTime}\n` +
        `👥 Guests: ${session.guests}\n` +
        `📱 Phone: ${session.verifiedPhone}\n\n` +
        `Please provide your name:\n` +
        `Example: John Doe`
      );
      return res.status(200).send('OK');
    }

    // BOOKING_CONFIRM State
    if (session.state === STATES.BOOKING_CONFIRM) {
      session.customerName = messageText.trim();

      try {
        const bookingId = await saveBooking(session);

        // Notify owner
        await notifyOwner(session, bookingId, 'booking');

        sessions.delete(customerPhone);

        await sendMessage(
          customerPhone,
          `✅ *Booking Confirmed!*\n\n` +
          `🎉 Booking #${bookingId}\n\n` +
          `🍽️ ${session.restaurantName}\n` +
          `👤 ${session.customerName}\n` +
          `📅 ${session.bookingDate}\n` +
          `🕐 ${session.bookingTime}\n` +
          `👥 ${session.guests} guests\n\n` +
          `We look forward to serving you! 🙏`
        );
        return res.status(200).send('OK');

      } catch (error) {
        console.error('❌ Booking save error:', error);
        await sendMessage(
          customerPhone,
          `❌ Error saving booking. Please contact support.`
        );
        return res.status(200).send('OK');
      }
    }

    // Unknown state
    await sendMessage(
      customerPhone,
      `❌ Something went wrong. Please type the restaurant name to start over.`
    );
    return res.status(200).send('OK');

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).send('Error processing message');
  }
});

// ============================================
// PAYMENT WEBHOOK HANDLER
// ============================================
app.post('/payment/webhook', async (req, res) => {
  try {
    const webhookBody = req.body;
    const signature = req.headers['x-razorpay-signature'];

    console.log('📨 Payment webhook received:', webhookBody.event);

    // Verify webhook signature
    const isValid = await handlePaymentWebhook(webhookBody, signature);

    if (!isValid) {
      console.error('❌ Invalid webhook signature');
      return res.status(400).send('Invalid signature');
    }

    const event = webhookBody.event;
    const paymentEntity = webhookBody.payload.payment_link?.entity || webhookBody.payload.payment?.entity;

    if (!paymentEntity) {
      console.error('❌ No payment entity in webhook');
      return res.status(400).send('No payment entity');
    }

    // Find session by payment ID
    let sessionPhone = null;
    for (const [phone, session] of sessions.entries()) {
      if (session.paymentId === paymentEntity.id) {
        sessionPhone = phone;
        break;
      }
    }

    if (!sessionPhone) {
      console.log('⚠️ No active session found for payment:', paymentEntity.id);
      return res.status(200).send('OK');
    }

    const session = sessions.get(sessionPhone);

    // Handle payment success
    if (event === 'payment.captured' || event === 'payment_link.paid') {
      // Clear timeout
      const timeout = pendingPayments.get(sessionPhone);
      if (timeout) clearTimeout(timeout);
      pendingPayments.delete(sessionPhone);

      // Update order
      await updateOrderAfterPayment(session.tempOrderId, paymentEntity.id, 'PAID');

      // Update session
      session.paymentMethod = 'online';
      const orderId = session.tempOrderId;

      // Update reliability
      updateReliability(sessionPhone, 'confirmed');

      // Notify owner
      await notifyOwner(session, orderId, 'order');

      // Notify customer
      await sendMessage(
        sessionPhone,
        `✅ *Payment Successful!*\n\n` +
        `🎉 Order #${orderId} confirmed!\n\n` +
        `${formatCart(session.cart)}\n\n` +
        `💰 Paid: ₹${session.total}\n` +
        `📍 Delivery to: ${session.deliveryAddress}\n\n` +
        `🍽️ Your order will be delivered soon!\n` +
        `Thank you for ordering from ${session.restaurantName}! 🙏`
      );

      // Clear session
      sessions.delete(sessionPhone);
    }

    // Handle payment failure
    if (event === 'payment.failed') {
      await sendMessage(
        sessionPhone,
        `❌ Payment failed.\n\n` +
        `Please try again:\n` +
        `${session.paymentLink}\n\n` +
        `Or type *CANCEL* to cancel order.`
      );
    }

    res.status(200).send('OK');

  } catch (error) {
    console.error('❌ Payment webhook error:', error);
    res.status(500).send('Error');
  }
});

// Payment callback page
app.get('/payment/callback', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Payment Status</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body {
          font-family: Arial, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          margin: 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .container {
          background: white;
          padding: 40px;
          border-radius: 10px;
          box-shadow: 0 10px 40px rgba(0,0,0,0.2);
          text-align: center;
          max-width: 400px;
        }
        .success { color: #28a745; font-size: 60px; }
        h1 { margin: 20px 0; color: #333; }
        p { color: #666; line-height: 1.6; }
        .button {
          display: inline-block;
          margin-top: 20px;
          padding: 12px 30px;
          background: #667eea;
          color: white;
          text-decoration: none;
          border-radius: 5px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="success">✅</div>
        <h1>Payment Successful!</h1>
        <p>Your order has been confirmed. Please check WhatsApp for order details.</p>
        <p>Thank you for your order! 🎉</p>
      </div>
    </body>
    </html>
  `);
});

// ============================================
// ADMIN & UTILITY ENDPOINTS
// ============================================

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      database: 'Connected',
      paymentEnabled: FEATURES.PAYMENT,
      razorpayConfigured: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      database: 'Disconnected',
      error: error.message
    });
  }
});

// List all restaurants
app.get('/restaurants', async (req, res) => {
  try {
    await loadRestaurants();
    res.json({
      count: restaurantCache.length,
      restaurants: restaurantCache
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reload cache
app.post('/reload-cache', async (req, res) => {
  try {
    lastCacheUpdate = 0;
    await loadRestaurants();
    res.json({
      message: 'Cache reloaded',
      count: restaurantCache.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check sheets status
app.get('/sheets-status', (req, res) => {
  res.json(getSheetsStatus());
});

// Check customer reliability
app.get('/customer-reliability/:phone', (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const reliability = getCustomerReliability(`+91${phone}`);
  res.json(reliability);
});

// Test session
app.get('/test-session/:phone', (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const fullPhone = phone.startsWith('91') ? `+${phone}` : `+91${phone}`;
  const session = sessions.get(fullPhone);

  res.json({
    phone: fullPhone,
    hasSession: !!session,
    session: session || null,
    activeSessions: sessions.size
  });
});

// Test owner notification
app.post('/test-owner-notify', async (req, res) => {
  try {
    const testSession = {
      restaurantName: 'ZAM ZAM',
      phone: '+919876543210',
      customerName: 'Test Customer',
      deliveryAddress: '123 Test Street, Kolkata',
      cart: [
        {
          menuItem: { name: 'Chicken Biryani', price: 200 },
          quantity: 2
        }
      ],
      total: 450,
      paymentMethod: 'online'
    };

    await notifyOwner(testSession, 999, 'order');
    res.json({ message: 'Test notification sent' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear all sessions (admin only)
app.post('/admin/clear-sessions', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const count = sessions.size;
  sessions.clear();
  pendingPayments.clear();
  res.json({ message: `Cleared ${count} sessions` });
});

// ============================================
// ERROR HANDLERS
// ============================================
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('👋 SIGTERM received, closing gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('👋 SIGINT received, closing gracefully...');
  await pool.end();
  process.exit(0);
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🍽️  RESTAURANT BOT SERVER STARTED   ║
╠════════════════════════════════════════╣
║  Port: ${PORT}                         
║  Environment: ${process.env.NODE_ENV || 'development'}
║  Database: ${dbConnected ? '✅ Connected' : '❌ Disconnected'}
║  Payment: ${FEATURES.PAYMENT ? '✅ Enabled' : '❌ Disabled'}
║  Sheets: ${FEATURES.GOOGLE_SHEETS ? '✅ Enabled' : '❌ Disabled'}
╚════════════════════════════════════════╝
  `);
});
