// ============================================
// RESTAURANT WHATSAPP BOT - PRODUCTION v4.0
// Enterprise-Grade Multi-Restaurant System
// ============================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { Pool } = require('pg');
const crypto = require('crypto');

// ============================================
// APPLICATION CONFIGURATION
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';

// ============================================
// MIDDLEWARE
// ============================================
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.set('trust proxy', true);

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ============================================
// FEATURE FLAGS
// ============================================
const FEATURES = {
  PAYMENT: process.env.PAYMENT_ENABLED === 'true',
  GOOGLE_SHEETS: !!(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY)
};

// ============================================
// TWILIO CONFIGURATION
// ============================================
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const wabaNumber = process.env.WABA_NUMBER;

if (!accountSid || !authToken || !wabaNumber) {
  console.error('❌ FATAL: Missing Twilio credentials in .env file');
  console.error('   Required: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, WABA_NUMBER');
  process.exit(1);
}

const twilioClient = twilio(accountSid, authToken);

// ============================================
// DATABASE CONNECTION WITH ADVANCED POOLING
// ============================================
const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: { 
    rejectUnauthorized: false,
    require: true
  },
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000'),
  max: parseInt(process.env.DB_POOL_MAX || '50'),
  min: parseInt(process.env.DB_POOL_MIN || '10'),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
  allowExitOnIdle: false,
  application_name: 'restaurant_bot',
  statement_timeout: 30000
};

console.log('🔧 Database Configuration:');
console.log(`   Connection Timeout: ${poolConfig.connectionTimeoutMillis}ms`);
console.log(`   Pool Size: ${poolConfig.min}-${poolConfig.max}`);
console.log(`   Idle Timeout: ${poolConfig.idleTimeoutMillis}ms`);

const pool = new Pool(poolConfig);

// Database connection state
let dbConnected = false;
let dbConnectionAttempts = 0;
const MAX_DB_RETRIES = 5;

// Database event handlers
pool.on('connect', (client) => {
  console.log('✅ New database client connected');
  dbConnected = true;
});

pool.on('error', (err, client) => {
  console.error('❌ Unexpected database error:', err);
  dbConnected = false;
});

pool.on('remove', (client) => {
  console.log('⚠️  Database client removed from pool');
});

// Advanced database connection with retry logic
async function connectDatabase(retries = MAX_DB_RETRIES) {
  console.log('\n🔌 Initiating database connection...');
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      dbConnectionAttempts++;
      console.log(`📡 Connection attempt ${attempt}/${retries}...`);
      
      const client = await pool.connect();
      
      // Test query
      const result = await client.query('SELECT NOW() as time, version() as version');
      console.log(`✅ Database connected successfully!`);
      console.log(`   Server time: ${result.rows[0].time}`);
      console.log(`   Version: ${result.rows[0].version.split(',')[0]}`);
      
      // Check required tables
      const tables = ['restaurants', 'menu_items', 'orders', 'bookings'];
      for (const table of tables) {
        const check = await client.query(
          `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
          [table]
        );
        if (!check.rows[0].exists) {
          console.warn(`⚠️  Table '${table}' does not exist`);
        } else {
          console.log(`   ✓ Table '${table}' verified`);
        }
      }
      
      client.release();
      dbConnected = true;
      return true;
      
    } catch (error) {
      console.error(`❌ Connection attempt ${attempt} failed:`, error.message);
      
      if (error.code) {
        console.error(`   Error code: ${error.code}`);
      }
      
      if (attempt < retries) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`⏳ Retrying in ${waitTime/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  console.error('❌ FATAL: Could not connect to database after multiple attempts');
  console.error('   Please check your DATABASE_URL in .env file');
  process.exit(1);
}

// Database health check function
async function checkDatabaseHealth() {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    if (!dbConnected) {
      console.log('✅ Database connection restored');
      dbConnected = true;
    }
    return true;
  } catch (error) {
    if (dbConnected) {
      console.error('❌ Database connection lost:', error.message);
      dbConnected = false;
    }
    return false;
  }
}

// Periodic health check
setInterval(checkDatabaseHealth, 30000); // Every 30 seconds

// ============================================
// MEMORY MANAGEMENT & CACHING
// ============================================
let restaurantCache = [];
let lastCacheUpdate = 0;
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '300000'); // 5 minutes

// Session management with automatic cleanup
const sessions = new Map();
const pendingPayments = new Map();
const customerReliability = new Map();

// Session cleanup - runs every 5 minutes
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [phone, session] of sessions.entries()) {
    if (now - session.createdAt > 1800000) { // 30 minutes
      if (session.otpTimeout) clearTimeout(session.otpTimeout);
      if (session.confirmationTimeout) clearTimeout(session.confirmationTimeout);
      sessions.delete(phone);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} expired sessions (Total: ${sessions.size})`);
  }
}, 300000); // Every 5 minutes

// ============================================
// CONSTANTS & CONFIGURATION
// ============================================
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT || '1800000');
const OTP_TIMEOUT = parseInt(process.env.OTP_TIMEOUT || '300000');
const PAYMENT_TIMEOUT = parseInt(process.env.PAYMENT_TIMEOUT || '900000');
const COD_CONFIRMATION_TIMEOUT = parseInt(process.env.COD_CONFIRMATION_TIMEOUT || '600000');

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

const RESTAURANT_TRIGGERS = {
  'ZAM ZAM': ['ZAMZAM', 'ZAM ZAM', 'ZAM-ZAM'],
  'SPICE GARDEN': ['SPICEGARDEN', 'SPICE GARDEN', 'SPICE-GARDEN'],
  'CURRY HOUSE': ['CURRYHOUSE', 'CURRY HOUSE', 'CURRY-HOUSE'],
  'BIRYANI EXPRESS': ['BIRYANIEXPRESS', 'BIRYANI EXPRESS', 'BIRYANI-EXPRESS']
};

// ============================================
// DATABASE FUNCTIONS WITH ERROR HANDLING
// ============================================

// Load restaurants with caching
async function loadRestaurants(forceReload = false) {
  const now = Date.now();
  
  if (!forceReload && restaurantCache.length > 0 && (now - lastCacheUpdate) < CACHE_TTL) {
    return restaurantCache;
  }

  try {
    const result = await pool.query(
      `SELECT id, name, phone, address, delivery_fee, min_order, active 
       FROM restaurants 
       WHERE active = true 
       ORDER BY name`
    );
    
    restaurantCache = result.rows;
    lastCacheUpdate = now;
    console.log(`📋 Loaded ${restaurantCache.length} active restaurants into cache`);
    return restaurantCache;
    
  } catch (error) {
    console.error('❌ Error loading restaurants:', error.message);
    
    if (restaurantCache.length > 0) {
      console.log('⚠️  Using cached restaurant data');
      return restaurantCache;
    }
    
    throw error;
  }
}

// Get menu items with error handling
async function getMenuItems(restaurantId) {
  try {
    const result = await pool.query(
      `SELECT id, name, description, price, category, available 
       FROM menu_items 
       WHERE restaurant_id = $1 AND available = true 
       ORDER BY category, name`,
      [restaurantId]
    );
    
    console.log(`📋 Loaded ${result.rows.length} menu items for restaurant ${restaurantId}`);
    return result.rows;
    
  } catch (error) {
    console.error(`❌ Error fetching menu for restaurant ${restaurantId}:`, error.message);
    return [];
  }
}

// Save order with transaction
async function saveOrder(session) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const orderResult = await client.query(
      `INSERT INTO orders (
        restaurant_id, customer_phone, customer_name, delivery_address,
        total_amount, status, payment_status, created_at, confirmed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) 
      RETURNING id`,
      [
        session.restaurantId,
        session.phone,
        session.customerName || 'Guest',
        session.deliveryAddress || '',
        session.total,
        'CONFIRMED',
        session.paymentMethod === 'online' ? 'PAID' : 'COD'
      ]
    );
    
    const orderId = orderResult.rows[0].id;
    
    for (const item of session.cart) {
      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, quantity, price) 
         VALUES ($1, $2, $3, $4)`,
        [orderId, item.menuItem.id, item.quantity, item.menuItem.price]
      );
    }
    
    await client.query('COMMIT');
    console.log(`✅ Order ${orderId} saved successfully`);
    
    return orderId;
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error saving order:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Save booking with transaction
async function saveBooking(session) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const result = await client.query(
      `INSERT INTO bookings (
        restaurant_id, customer_phone, customer_name, booking_date,
        booking_time, guests, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) 
      RETURNING id`,
      [
        session.restaurantId,
        session.phone,
        session.customerName || 'Guest',
        session.bookingDate,
        session.bookingTime,
        session.guests,
        'PENDING'
      ]
    );
    
    const bookingId = result.rows[0].id;
    
    await client.query('COMMIT');
    console.log(`✅ Booking ${bookingId} saved successfully`);
    
    return bookingId;
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error saving booking:', error);
    throw error;
  } finally {
    client.release();
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

async function sendMessage(to, body) {
  try {
    const message = await twilioClient.messages.create({
      from: wabaNumber,
      to: `whatsapp:${to}`,
      body: body
    });
    console.log(`✅ Message sent to ${to}: ${message.sid.substring(0, 20)}...`);
    return message;
  } catch (error) {
    console.error(`❌ Error sending message to ${to}:`, error.message);
    throw error;
  }
}

function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function formatMenu(menuItems) {
  const grouped = {};
  menuItems.forEach(item => {
    if (!grouped[item.category]) {
      grouped[item.category] = [];
    }
    grouped[item.category].push(item);
  });

  let message = '📋 *MENU*\n\n';
  let itemNumber = 1;
  
  Object.keys(grouped).forEach(category => {
    message += `*${category.toUpperCase()}*\n`;
    grouped[category].forEach(item => {
      message += `${itemNumber}. ${item.name} - ₹${item.price}\n`;
      if (item.description) {
        message += `   _${item.description}_\n`;
      }
      itemNumber++;
    });
    message += '\n';
  });

  message += '💬 *How to order:*\n';
  message += 'Reply with item numbers and quantities\n';
  message += 'Example: 1x2, 3x1\n\n';
  message += '✅ Type *DONE* when finished\n';
  message += '🗑️ Type *CLEAR* to empty cart';

  return message;
}

function parseOrderInput(input, menuItems) {
  const items = [];
  const parts = input.split(',').map(p => p.trim());

  for (const part of parts) {
    const match = part.match(/^(\d+)x(\d+)$/i) || part.match(/^(\d+)\s*x\s*(\d+)$/i);
    if (match) {
      const itemIndex = parseInt(match[1]) - 1;
      const quantity = parseInt(match[2]);

      if (itemIndex >= 0 && itemIndex < menuItems.length && quantity > 0 && quantity <= 99) {
        items.push({
          menuItem: menuItems[itemIndex],
          quantity: quantity
        });
      }
    }
  }

  return items;
}

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

function calculateTotal(cart, deliveryFee = 0) {
  const subtotal = cart.reduce((sum, item) => {
    return sum + (item.menuItem.price * item.quantity);
  }, 0);
  return subtotal + deliveryFee;
}

function parseDate(input) {
  const today = new Date();
  const inputLower = input.toLowerCase().trim();

  if (inputLower === 'today') {
    return today.toISOString().split('T')[0];
  }
  if (inputLower === 'tomorrow') {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }

  const match = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];
    return `${year}-${month}-${day}`;
  }

  return null;
}

async function notifyOwner(session, orderId, type = 'order') {
  try {
    const result = await pool.query(
      'SELECT phone, owner_name FROM restaurants WHERE id = $1',
      [session.restaurantId]
    );

    if (!result.rows.length || !result.rows[0].phone) {
      console.log(`⚠️  No owner phone for restaurant ${session.restaurantId}`);
      return;
    }

    const ownerPhone = result.rows[0].phone;
    let message = '';

    if (type === 'order') {
      const paymentStatus = session.paymentMethod === 'online' ? '💳 PAID' : '💵 COD';
      message = `🔔 *NEW ORDER #${orderId}*\n\n`;
      message += `🍽️ ${session.restaurantName}\n`;
      message += `📱 ${session.phone}\n`;
      message += `👤 ${session.customerName || 'Guest'}\n`;
      message += `📍 ${session.deliveryAddress || 'N/A'}\n\n`;
      message += `*Items:*\n`;
      session.cart.forEach(item => {
        message += `• ${item.quantity}x ${item.menuItem.name}\n`;
      });
      message += `\n💰 Total: ₹${session.total}\n${paymentStatus}`;
    } else {
      message = `🔔 *NEW BOOKING #${orderId}*\n\n`;
      message += `🍽️ ${session.restaurantName}\n`;
      message += `📱 ${session.phone}\n`;
      message += `👤 ${session.customerName}\n`;
      message += `📅 ${session.bookingDate}\n`;
      message += `🕐 ${session.bookingTime}\n`;
      message += `👥 ${session.guests} guests`;
    }

    await sendMessage(ownerPhone, message);
    console.log(`✅ Owner notified: ${ownerPhone}`);

  } catch (error) {
    console.error('❌ Error notifying owner:', error.message);
  }
}

// ============================================
// MAIN WEBHOOK HANDLER
// ============================================

app.post('/webhook', async (req, res) => {
  try {
    const { From, Body } = req.body;

    if (!From || !Body) {
      return res.status(400).send('Missing parameters');
    }

    const customerPhone = From.replace('whatsapp:', '');
    const messageText = Body.trim();
    const messageUpper = messageText.toUpperCase();

    console.log(`📱 ${customerPhone}: ${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}`);

    // Check database connection
    if (!dbConnected) {
      await sendMessage(
        customerPhone,
        '⚠️ System temporarily unavailable. Please try again in a moment.'
      );
      return res.status(503).send('Database unavailable');
    }

    await loadRestaurants();

    // Check restaurant triggers FIRST
    const restaurantTrigger = Object.entries(RESTAURANT_TRIGGERS).find(
      ([name, triggers]) => triggers.some(t => messageUpper.includes(t))
    );

    if (restaurantTrigger) {
      const [restaurantName] = restaurantTrigger;
      const restaurant = restaurantCache.find(r => 
        r.name.toUpperCase() === restaurantName.toUpperCase()
      );

      if (restaurant) {
        let session = sessions.get(customerPhone);
        if (session) {
          if (session.otpTimeout) clearTimeout(session.otpTimeout);
          if (session.confirmationTimeout) clearTimeout(session.confirmationTimeout);
        }

        session = {
          phone: customerPhone,
          state: STATES.SELECT_SERVICE,
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          deliveryFee: restaurant.delivery_fee || 0,
          minOrder: restaurant.min_order || 0,
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

    let session = sessions.get(customerPhone);

    // Handle greetings
    const greetings = ['hi', 'hello', 'hey', 'start', 'menu', 'help'];
    if (!session || session.state === STATES.INITIAL) {
      if (greetings.some(g => messageText.toLowerCase().includes(g))) {
        await sendMessage(
          customerPhone,
          `👋 *Welcome!*\n\n` +
          `📍 *Available Restaurants:*\n\n` +
          `🍗 *ZAM ZAM* - Type: ZAMZAM\n` +
          `🌶️ *SPICE GARDEN* - Type: SPICEGARDEN\n` +
          `🍛 *CURRY HOUSE* - Type: CURRYHOUSE\n` +
          `🍚 *BIRYANI EXPRESS* - Type: BIRYANIEXPRESS\n\n` +
          `Type any restaurant name to begin! 🎉`
        );
        return res.status(200).send('OK');
      }
    }

    if (!session) {
      await sendMessage(
        customerPhone,
        `👋 Hello! Type a restaurant name to start:\n\n` +
        `*ZAMZAM* | *SPICEGARDEN* | *CURRYHOUSE* | *BIRYANIEXPRESS*`
      );
      return res.status(200).send('OK');
    }

    // STATE MACHINE PROCESSING
    // [Rest of your state machine logic goes here - I'll include key states]

    // SELECT_SERVICE
    if (session.state === STATES.SELECT_SERVICE) {
      if (messageText === '1') {
        session.state = STATES.ENTER_PHONE;
        session.serviceType = 'delivery';
        sessions.set(customerPhone, session);

        await sendMessage(
          customerPhone,
          `📱 Enter your phone number:\nExample: 9876543210`
        );
        return res.status(200).send('OK');
      }

      if (messageText === '2') {
        session.state = STATES.ENTER_PHONE;
        session.serviceType = 'booking';
        sessions.set(customerPhone, session);

        await sendMessage(
          customerPhone,
          `📱 Enter your phone number:\nExample: 9876543210`
        );
        return res.status(200).send('OK');
      }

      await sendMessage(customerPhone, `❌ Invalid. Reply 1 or 2`);
      return res.status(200).send('OK');
    }

    // ENTER_PHONE
    if (session.state === STATES.ENTER_PHONE) {
      const phone = messageText.replace(/\D/g, '');

      if (phone.length === 10) {
        session.verifiedPhone = `+91${phone}`;
      } else if (phone.length === 12 && phone.startsWith('91')) {
        session.verifiedPhone = `+${phone}`;
      } else {
        await sendMessage(customerPhone, `❌ Invalid. Enter 10-digit number`);
        return res.status(200).send('OK');
      }

      session.otp = generateOTP();
      session.state = STATES.VERIFY_OTP;
      session.otpAttempts = 0;

      session.otpTimeout = setTimeout(() => {
        sessions.delete(customerPhone);
        sendMessage(customerPhone, '⏱️ OTP expired. Start over.');
      }, OTP_TIMEOUT);

      sessions.set(customerPhone, session);

      await sendMessage(
        customerPhone,
        `🔐 Your OTP: *${session.otp}*\n\nReply with this code (valid 5 min)`
      );
      return res.status(200).send('OK');
    }

    // VERIFY_OTP
    if (session.state === STATES.VERIFY_OTP) {
      if (messageText === session.otp) {
        clearTimeout(session.otpTimeout);

        if (session.serviceType === 'delivery') {
          session.state = STATES.BROWSE_MENU;
          session.cart = [];
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
            `📅 When to book?\n\nType:\n• TODAY or TOMORROW\n• DD/MM/YYYY\nExample: 15/02/2024`
          );
          return res.status(200).send('OK');
        }
      }

      session.otpAttempts++;
      if (session.otpAttempts >= 3) {
        clearTimeout(session.otpTimeout);
        sessions.delete(customerPhone);
        await sendMessage(customerPhone, `❌ Too many attempts. Start over.`);
        return res.status(200).send('OK');
      }

      await sendMessage(
        customerPhone,
        `❌ Wrong OTP. ${3 - session.otpAttempts} attempts left`
      );
      return res.status(200).send('OK');
    }

    // BROWSE_MENU
    if (session.state === STATES.BROWSE_MENU) {
      if (messageUpper === 'DONE') {
        if (!session.cart || session.cart.length === 0) {
          await sendMessage(customerPhone, `🛒 Cart empty. Add items first.`);
          return res.status(200).send('OK');
        }

        const subtotal = session.cart.reduce((sum, item) => 
          sum + (item.menuItem.price * item.quantity), 0
        );

        if (subtotal < session.minOrder) {
          await sendMessage(
            customerPhone,
            `⚠️ Minimum ₹${session.minOrder}\nCurrent: ₹${subtotal}\n\nAdd ₹${session.minOrder - subtotal} more`
          );
          return res.status(200).send('OK');
        }

        session.state = STATES.CONFIRM_ORDER;
        session.total = calculateTotal(session.cart, session.deliveryFee);
        sessions.set(customerPhone, session);

        await sendMessage(
          customerPhone,
          `${formatCart(session.cart)}\n\n` +
          `Delivery: ₹${session.deliveryFee}\n` +
          `*Total: ₹${session.total}*\n\n` +
          `Provide:\nName\nAddress\n\nExample:\nJohn Doe\n123 Park St`
        );
        return res.status(200).send('OK');
      }

      if (messageUpper === 'CLEAR') {
        session.cart = [];
        sessions.set(customerPhone, session);
        await sendMessage(customerPhone, `🗑️ Cart cleared!\n\n${formatMenu(session.menuItems)}`);
        return res.status(200).send('OK');
      }

      const newItems = parseOrderInput(messageText, session.menuItems);
      if (newItems.length > 0) {
        session.cart.push(...newItems);
        sessions.set(customerPhone, session);

        await sendMessage(
          customerPhone,
          `✅ Added!\n\n${formatCart(session.cart)}\n\nAdd more or type *DONE*`
        );
        return res.status(200).send('OK');
      }

      await sendMessage(customerPhone, `❌ Invalid format. Example: 1x2, 3x1`);
      return res.status(200).send('OK');
    }

    // CONFIRM_ORDER
    if (session.state === STATES.CONFIRM_ORDER) {
      const lines = messageText.split('\n').map(l => l.trim()).filter(l => l);

      if (lines.length >= 2) {
        session.customerName = lines[0];
        session.deliveryAddress = lines.slice(1).join(', ');
        session.state = STATES.PAYMENT_METHOD;
        sessions.set(customerPhone, session);

        await sendMessage(
          customerPhone,
          `✅ Confirmed!\n\n` +
          `👤 ${session.customerName}\n` +
          `📍 ${session.deliveryAddress}\n` +
          `💰 ₹${session.total}\n\n` +
          `*Payment:*\n1️⃣ Online\n2️⃣ COD\n\nReply 1 or 2`
        );
        return res.status(200).send('OK');
      }

      await sendMessage(
        customerPhone,
        `❌ Format:\nLine 1: Name\nLine 2+: Address`
      );
      return res.status(200).send('OK');
    }

    // PAYMENT_METHOD
    if (session.state === STATES.PAYMENT_METHOD) {
      if (messageText === '2') {
        session.state = STATES.AWAITING_CONFIRMATION;
        session.paymentMethod = 'cod';
        sessions.set(customerPhone, session);

        session.confirmationTimeout = setTimeout(async () => {
          sessions.delete(customerPhone);
          await sendMessage(customerPhone, `⏱️ Timeout. Order cancelled.`);
        }, COD_CONFIRMATION_TIMEOUT);

        await sendMessage(
          customerPhone,
          `📋 *ORDER SUMMARY*\n\n` +
          `${formatCart(session.cart)}\n\n` +
          `📍 ${session.deliveryAddress}\n` +
          `💰 ₹${session.total} (COD)\n\n` +
          `Confirm within 10 min:\n✅ YES\n❌ NO`
        );
        return res.status(200).send('OK');
      }

      await sendMessage(customerPhone, `❌ Reply 1 for Online or 2 for COD`);
      return res.status(200).send('OK');
    }

    // AWAITING_CONFIRMATION
    if (session.state === STATES.AWAITING_CONFIRMATION) {
      if (messageUpper === 'YES') {
        clearTimeout(session.confirmationTimeout);

        try {
          const orderId = await saveOrder(session);
          await notifyOwner(session, orderId, 'order');
          sessions.delete(customerPhone);

          await sendMessage(
            customerPhone,
            `✅ *Order Confirmed!*\n\n` +
            `🎉 Order #${orderId}\n\n` +
            `${formatCart(session.cart)}\n\n` +
            `💰 ₹${session.total} (COD)\n` +
            `📍 ${session.deliveryAddress}\n\n` +
            `Delivery soon! Thank you! 🙏`
          );
          return res.status(200).send('OK');

        } catch (error) {
          console.error('❌ Order save error:', error);
          await sendMessage(customerPhone, `❌ Error. Contact support.`);
          return res.status(200).send('OK');
        }
      }

      if (messageUpper === 'NO') {
        clearTimeout(session.confirmationTimeout);
        sessions.delete(customerPhone);
        await sendMessage(customerPhone, `❌ Order cancelled.`);
        return res.status(200).send('OK');
      }

      await sendMessage(customerPhone, `Reply YES or NO`);
      return res.status(200).send('OK');
    }

    // [Add remaining states as needed: BOOKING_DATE, BOOKING_TIME, etc.]

    await sendMessage(customerPhone, `❌ Error. Type restaurant name to restart.`);
    return res.status(200).send('OK');

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).send('Error');
  }
});

// ============================================
// HEALTH & MONITORING ENDPOINTS
// ============================================

app.get('/health', async (req, res) => {
  const health = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: dbConnected ? 'Connected' : 'Disconnected',
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    },
    sessions: sessions.size,
    restaurants: restaurantCache.length,
    features: FEATURES
  };

  try {
    await pool.query('SELECT 1');
    res.json(health);
  } catch (error) {
    health.status = 'ERROR';
    health.database = 'Disconnected';
    health.error = error.message;
    res.status(503).json(health);
  }
});

app.get('/restaurants', async (req, res) => {
  try {
    await loadRestaurants(true);
    res.json({
      count: restaurantCache.length,
      restaurants: restaurantCache
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ERROR HANDLERS & GRACEFUL SHUTDOWN
// ============================================

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});

process.on('SIGTERM', async () => {
  console.log('👋 SIGTERM - Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('👋 SIGINT - Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

// ============================================
// SERVER STARTUP
// ============================================

async function startServer() {
  try {
    await connectDatabase();
    await loadRestaurants();

    app.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════════╗
║   🍽️  RESTAURANT BOT v4.0 STARTED    ║
╠════════════════════════════════════════╣
║  Port: ${PORT}
║  Environment: ${NODE_ENV}
║  Database: ${dbConnected ? '✅ Connected' : '❌ Disconnected'}
║  Restaurants: ${restaurantCache.length}
║  Payment: ${FEATURES.PAYMENT ? '✅' : '❌'}
║  Sheets: ${FEATURES.GOOGLE_SHEETS ? '✅' : '❌'}
║  Sessions: ${sessions.size}
║  Memory: ${Math.round(process.memoryUsage().heapUsed/1024/1024)}MB
╚════════════════════════════════════════╝
      `);
    });

  } catch (error) {
    console.error('❌ FATAL: Server startup failed:', error);
    process.exit(1);
  }
}

startServer();
