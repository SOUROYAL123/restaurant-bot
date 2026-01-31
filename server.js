// ============================================
// RESTAURANT WHATSAPP BOT - ULTIMATE v5.0
// Complete Production System - Exact Flow Match
// Features: COD + Razorpay, Owner Notifications
// ============================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';

// ============================================
// MIDDLEWARE
// ============================================
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.set('trust proxy', true);

// ============================================
// TWILIO SETUP
// ============================================
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const wabaNumber = process.env.WABA_NUMBER;

if (!accountSid || !authToken || !wabaNumber) {
  console.error('❌ FATAL: Missing Twilio credentials');
  process.exit(1);
}

const twilioClient = twilio(accountSid, authToken);

// ============================================
// DATABASE CONNECTION POOL
// ============================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false, require: true },
  connectionTimeoutMillis: 10000,
  max: 50,
  min: 10,
  idleTimeoutMillis: 30000,
  allowExitOnIdle: false,
  statement_timeout: 30000
});

let dbConnected = false;

pool.on('connect', () => {
  console.log('✅ Database client connected');
  dbConnected = true;
});

pool.on('error', (err) => {
  console.error('❌ Database error:', err.message);
  dbConnected = false;
});

// Database connection with retry
async function connectDatabase(retries = 5) {
  console.log('\n🔌 Connecting to database...');
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`📡 Attempt ${attempt}/${retries}...`);
      const client = await pool.connect();
      const result = await client.query('SELECT NOW() as time');
      console.log(`✅ Database connected! Time: ${result.rows[0].time}`);
      client.release();
      dbConnected = true;
      return true;
    } catch (error) {
      console.error(`❌ Attempt ${attempt} failed:`, error.message);
      if (attempt < retries) {
        const wait = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`⏳ Retrying in ${wait/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  }
  
  console.error('❌ FATAL: Database connection failed');
  process.exit(1);
}

// ============================================
// SESSION MANAGEMENT
// ============================================
const sessions = new Map();
const pendingPayments = new Map();

// Auto-cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [phone, session] of sessions.entries()) {
    if (now - session.createdAt > 1800000) {
      if (session.timeout) clearTimeout(session.timeout);
      sessions.delete(phone);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} expired sessions`);
  }
}, 300000);

// ============================================
// CACHE
// ============================================
let restaurantCache = [];
let lastCacheUpdate = 0;
const CACHE_TTL = 300000; // 5 minutes

// ============================================
// STATE CONSTANTS
// ============================================
const STATES = {
  INITIAL: 'INITIAL',
  SELECT_SERVICE: 'SELECT_SERVICE',
  BROWSE_MENU: 'BROWSE_MENU',
  ADD_ADDRESS: 'ADD_ADDRESS',
  ADD_INSTRUCTIONS: 'ADD_INSTRUCTIONS',
  CHOOSE_PAYMENT: 'CHOOSE_PAYMENT',
  CONFIRM_ORDER: 'CONFIRM_ORDER',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  BOOKING_DATE: 'BOOKING_DATE',
  BOOKING_TIME: 'BOOKING_TIME',
  BOOKING_GUESTS: 'BOOKING_GUESTS',
  BOOKING_CONFIRM: 'BOOKING_CONFIRM'
};

const RESTAURANT_TRIGGERS = {
  'Zam Zam Restaurant': ['ZAMZAM', 'ZAM ZAM', 'ZAM-ZAM'],
  'Spice Garden': ['SPICEGARDEN', 'SPICE GARDEN', 'SPICE-GARDEN'],
  'Curry House': ['CURRYHOUSE', 'CURRY HOUSE', 'CURRY-HOUSE'],
  'Biryani Express': ['BIRYANIEXPRESS', 'BIRYANI EXPRESS', 'BIRYANI-EXPRESS']
};

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
    console.error(`❌ Error sending to ${to}:`, error.message);
    throw error;
  }
}

async function loadRestaurants(forceReload = false) {
  const now = Date.now();
  if (!forceReload && restaurantCache.length > 0 && (now - lastCacheUpdate) < CACHE_TTL) {
    return restaurantCache;
  }

  try {
    const result = await pool.query(
      `SELECT id, name, phone, address, delivery_fee, min_order, active 
       FROM restaurants WHERE active = true ORDER BY name`
    );
    restaurantCache = result.rows;
    lastCacheUpdate = now;
    console.log(`📋 Loaded ${restaurantCache.length} restaurants`);
    return restaurantCache;
  } catch (error) {
    console.error('❌ Error loading restaurants:', error);
    return restaurantCache;
  }
}

async function getMenuItems(restaurantId) {
  try {
    const result = await pool.query(
      `SELECT id, name, description, price, category, available, is_vegetarian 
       FROM menu_items 
       WHERE restaurant_id = $1 AND available = true 
       ORDER BY category, name`,
      [restaurantId]
    );
    console.log(`📋 Loaded ${result.rows.length} menu items for restaurant ${restaurantId}`);
    return result.rows;
  } catch (error) {
    console.error('❌ Error fetching menu:', error);
    return [];
  }
}

function formatMenu(menuItems) {
  const grouped = {};
  menuItems.forEach(item => {
    if (!grouped[item.category]) {
      grouped[item.category] = [];
    }
    grouped[item.category].push(item);
  });

  let message = '📋 Zam Zam Restaurant - Menu\n\n';
  
  Object.keys(grouped).sort().forEach(category => {
    message += `${category.toUpperCase()}\n`;
    grouped[category].forEach(item => {
      const vegIcon = item.is_vegetarian ? '🟢' : '🔴';
      message += `${vegIcon} ${item.id}. ${item.name} - ₹${item.price}\n`;
      if (item.description) {
        message += `   ${item.description}\n`;
      }
    });
    message += '\n';
  });

  message += `💬 Add items using: item_id quantity\n`;
  message += `Example: "15 2" (2× Mango Lassi)\n\n`;
  message += `Type "done" when finished.`;

  return message;
}

function formatCart(cart, deliveryFee = 0) {
  if (!cart || cart.length === 0) {
    return '🛒 Your cart is empty';
  }

  let message = '🛒 Your Cart:\n\n';
  let subtotal = 0;

  cart.forEach((item, index) => {
    const itemTotal = item.price * item.quantity;
    subtotal += itemTotal;
    message += `${index + 1}. ${item.name}\n`;
    message += `   Qty: ${item.quantity} × ₹${item.price} = ₹${itemTotal}\n\n`;
  });

  message += `Subtotal: ₹${subtotal}\n`;
  message += `Delivery Fee: ₹${deliveryFee}\n`;
  message += `Total: ₹${subtotal + deliveryFee}`;

  return message;
}

async function saveOrder(session) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const orderResult = await client.query(
      `INSERT INTO orders (
        restaurant_id, customer_phone, delivery_address, special_instructions,
        total_amount, status, payment_status, payment_method, created_at, confirmed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW()) 
      RETURNING id`,
      [
        session.restaurantId,
        session.phone,
        session.deliveryAddress,
        session.specialInstructions || 'No special instructions',
        session.total,
        'CONFIRMED',
        session.paymentMethod === 'online' ? 'PAID' : 'COD',
        session.paymentMethod || 'cod'
      ]
    );
    
    const orderId = orderResult.rows[0].id;
    
    for (const item of session.cart) {
      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, quantity, price) 
         VALUES ($1, $2, $3, $4)`,
        [orderId, item.id, item.quantity, item.price]
      );
    }
    
    await client.query('COMMIT');
    console.log(`✅ Order ${orderId} saved`);
    return orderId;
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error saving order:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function notifyOwner(session, orderId) {
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
    const paymentMethod = session.paymentMethod === 'online' ? '💳 ONLINE PAID' : '💵 CASH ON DELIVERY';
    
    let message = `🔔 *NEW ORDER #${orderId}*\n\n`;
    message += `🏪 ${session.restaurantName}\n`;
    message += `📱 Customer: ${session.phone}\n`;
    message += `📍 Address: ${session.deliveryAddress}\n\n`;
    message += `🛒 *Items:*\n`;
    
    session.cart.forEach(item => {
      message += `• ${item.quantity}× ${item.name} - ₹${item.price * item.quantity}\n`;
    });
    
    message += `\n💰 *Total: ₹${session.total}*\n`;
    message += `${paymentMethod}\n\n`;
    
    if (session.specialInstructions && session.specialInstructions !== 'no') {
      message += `📝 Special: ${session.specialInstructions}\n\n`;
    }
    
    message += `⏰ ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;

    await sendMessage(ownerPhone, message);
    console.log(`✅ Owner notified at ${ownerPhone}`);

  } catch (error) {
    console.error('❌ Error notifying owner:', error.message);
  }
}

// Razorpay payment link creation
async function createPaymentLink(session) {
  try {
    const Razorpay = require('razorpay');
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });

    const paymentLink = await razorpay.paymentLink.create({
      amount: session.total * 100,
      currency: 'INR',
      description: `Order from ${session.restaurantName}`,
      customer: {
        contact: session.phone
      },
      notify: {
        sms: true,
        whatsapp: true
      },
      callback_url: `${process.env.BASE_URL || 'https://restaurant.legacylens.co.in'}/payment/callback`,
      callback_method: 'get'
    });

    console.log('✅ Payment link created:', paymentLink.id);
    return paymentLink;
  } catch (error) {
    console.error('❌ Payment link error:', error);
    return null;
  }
}

async function verifyPayment(paymentId) {
  try {
    const Razorpay = require('razorpay');
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });

    const payment = await razorpay.paymentLink.fetch(paymentId);
    return payment.status === 'paid';
  } catch (error) {
    console.error('❌ Payment verification error:', error);
    return false;
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

    console.log(`📱 ${customerPhone}: ${messageText}`);

    if (!dbConnected) {
      await sendMessage(customerPhone, '⚠️ System temporarily unavailable. Try again in a moment.');
      return res.status(503).send('DB unavailable');
    }

    await loadRestaurants();

    // ============================================
    // RESTAURANT TRIGGER DETECTION
    // ============================================
    const restaurantTrigger = Object.entries(RESTAURANT_TRIGGERS).find(
      ([name, triggers]) => triggers.some(t => messageUpper.includes(t))
    );

    if (restaurantTrigger) {
      const [restaurantName] = restaurantTrigger;
      const restaurant = restaurantCache.find(r => r.name === restaurantName);

      if (restaurant) {
        let session = sessions.get(customerPhone);
        if (session && session.timeout) clearTimeout(session.timeout);

        session = {
          phone: customerPhone,
          state: STATES.SELECT_SERVICE,
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          deliveryFee: restaurant.delivery_fee || 30,
          minOrder: restaurant.min_order || 0,
          createdAt: Date.now()
        };

        sessions.set(customerPhone, session);

        await sendMessage(
          customerPhone,
          `🎉 Welcome to ${restaurant.name}!\n\n` +
          `What would you like to do?\n\n` +
          `1️⃣ Order Delivery\n` +
          `2️⃣ Book a Table\n\n` +
          `Reply with 1 or 2`
        );
        return res.status(200).send('OK');
      }
    }

    let session = sessions.get(customerPhone);

    // Handle greetings
    const greetings = ['hi', 'hello', 'hey', 'start', 'menu', 'help'];
    if (!session) {
      if (greetings.some(g => messageText.toLowerCase().includes(g))) {
        await sendMessage(
          customerPhone,
          `👋 *Welcome!*\n\n` +
          `Type restaurant name:\n\n` +
          `🍗 ZAMZAM\n` +
          `🌶️ SPICEGARDEN\n` +
          `🍛 CURRYHOUSE\n` +
          `🍚 BIRYANIEXPRESS`
        );
        return res.status(200).send('OK');
      }
      
      await sendMessage(customerPhone, `👋 Type a restaurant name to start ordering!`);
      return res.status(200).send('OK');
    }

    // ============================================
    // STATE MACHINE
    // ============================================

    // SELECT_SERVICE State
    if (session.state === STATES.SELECT_SERVICE) {
      if (messageText === '1') {
        session.state = STATES.BROWSE_MENU;
        session.serviceType = 'delivery';
        session.cart = [];
        
        const menuItems = await getMenuItems(session.restaurantId);
        session.menuItems = menuItems;
        sessions.set(customerPhone, session);

        await sendMessage(customerPhone, formatMenu(menuItems));
        return res.status(200).send('OK');
      }

      if (messageText === '2') {
        session.state = STATES.BOOKING_DATE;
        session.serviceType = 'booking';
        sessions.set(customerPhone, session);

        await sendMessage(
          customerPhone,
          `📅 When would you like to book?\n\n` +
          `Type:\n• TODAY or TOMORROW\n• DD/MM/YYYY\nExample: 15/02/2024`
        );
        return res.status(200).send('OK');
      }

      await sendMessage(customerPhone, `❌ Invalid. Reply 1 or 2`);
      return res.status(200).send('OK');
    }

    // BROWSE_MENU State
    if (session.state === STATES.BROWSE_MENU) {
      if (messageUpper === 'DONE') {
        if (!session.cart || session.cart.length === 0) {
          await sendMessage(customerPhone, `🛒 Cart is empty. Add items first!`);
          return res.status(200).send('OK');
        }

        const subtotal = session.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        
        if (subtotal < session.minOrder) {
          await sendMessage(
            customerPhone,
            `⚠️ Minimum order: ₹${session.minOrder}\n` +
            `Current: ₹${subtotal}\n\n` +
            `Add ₹${session.minOrder - subtotal} more`
          );
          return res.status(200).send('OK');
        }

        session.state = STATES.ADD_ADDRESS;
        session.subtotal = subtotal;
        session.total = subtotal + session.deliveryFee;
        sessions.set(customerPhone, session);

        await sendMessage(
          customerPhone,
          `${formatCart(session.cart, session.deliveryFee)}\n\n` +
          `📍 Please enter your delivery address:`
        );
        return res.status(200).send('OK');
      }

      // Parse item_id quantity format (e.g., "8 3" or "15 2")
      const match = messageText.match(/^(\d+)\s+(\d+)$/);
      if (match) {
        const itemId = parseInt(match[1]);
        const quantity = parseInt(match[2]);

        const menuItem = session.menuItems.find(item => item.id === itemId);
        
        if (!menuItem) {
          await sendMessage(customerPhone, `❌ Item #${itemId} not found. Check menu.`);
          return res.status(200).send('OK');
        }

        if (quantity < 1 || quantity > 99) {
          await sendMessage(customerPhone, `❌ Quantity must be between 1 and 99`);
          return res.status(200).send('OK');
        }

        // Check if item already in cart
        const existingItem = session.cart.find(item => item.id === itemId);
        if (existingItem) {
          existingItem.quantity += quantity;
        } else {
          session.cart.push({
            id: menuItem.id,
            name: menuItem.name,
            price: menuItem.price,
            quantity: quantity
          });
        }

        sessions.set(customerPhone, session);

        const subtotal = session.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const total = subtotal + session.deliveryFee;

        await sendMessage(
          customerPhone,
          `✅ Added to cart!\n\n` +
          `${formatCart(session.cart, session.deliveryFee)}\n\n` +
          `Add more items or type "done" to proceed.`
        );
        return res.status(200).send('OK');
      }

      await sendMessage(
        customerPhone,
        `❌ Invalid format. Use: item_id quantity (e.g., "15 2")`
      );
      return res.status(200).send('OK');
    }

    // ADD_ADDRESS State
    if (session.state === STATES.ADD_ADDRESS) {
      session.deliveryAddress = messageText.trim();
      session.state = STATES.ADD_INSTRUCTIONS;
      sessions.set(customerPhone, session);

      await sendMessage(
        customerPhone,
        `✅ Address saved!\n\n` +
        `Any special instructions? (Type "no" if none)`
      );
      return res.status(200).send('OK');
    }

    // ADD_INSTRUCTIONS State
    if (session.state === STATES.ADD_INSTRUCTIONS) {
      session.specialInstructions = messageText.trim();
      session.state = STATES.CHOOSE_PAYMENT;
      sessions.set(customerPhone, session);

      await sendMessage(
        customerPhone,
        `💳 *PAYMENT METHOD*\n\n` +
        `${formatCart(session.cart, session.deliveryFee)}\n\n` +
        `📍 Delivery: ${session.deliveryAddress}\n\n` +
        `Choose payment:\n\n` +
        `1️⃣ Online Payment (Razorpay)\n` +
        `2️⃣ Cash on Delivery (COD)\n\n` +
        `Reply with 1 or 2`
      );
      return res.status(200).send('OK');
    }

    // CHOOSE_PAYMENT State
    if (session.state === STATES.CHOOSE_PAYMENT) {
      // Option 1: Online Payment
      if (messageText === '1') {
        if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
          await sendMessage(
            customerPhone,
            `❌ Online payment temporarily unavailable.\n\n` +
            `Please choose:\n2️⃣ Cash on Delivery`
          );
          return res.status(200).send('OK');
        }

        session.paymentMethod = 'online';
        session.state = STATES.AWAITING_PAYMENT;
        sessions.set(customerPhone, session);

        const paymentLink = await createPaymentLink(session);
        
        if (paymentLink && paymentLink.short_url) {
          session.paymentId = paymentLink.id;
          session.paymentLink = paymentLink.short_url;
          sessions.set(customerPhone, session);

          // Set payment timeout
          const paymentTimeout = setTimeout(async () => {
            const s = sessions.get(customerPhone);
            if (s && s.state === STATES.AWAITING_PAYMENT) {
              sessions.delete(customerPhone);
              await sendMessage(customerPhone, `⏱️ Payment timeout. Start over by typing restaurant name.`);
            }
          }, 900000); // 15 minutes

          pendingPayments.set(customerPhone, paymentTimeout);

          await sendMessage(
            customerPhone,
            `💳 *Online Payment*\n\n` +
            `Amount: ₹${session.total}\n\n` +
            `Click to pay securely:\n${paymentLink.short_url}\n\n` +
            `After payment:\n` +
            `• Type CHECK to verify\n` +
            `• Type CANCEL to cancel\n\n` +
            `⏱️ Link expires in 15 minutes`
          );
          return res.status(200).send('OK');
        } else {
          await sendMessage(
            customerPhone,
            `❌ Payment link failed. Try:\n2️⃣ Cash on Delivery`
          );
          return res.status(200).send('OK');
        }
      }

      // Option 2: Cash on Delivery
      if (messageText === '2') {
        session.paymentMethod = 'cod';
        session.state = STATES.CONFIRM_ORDER;
        sessions.set(customerPhone, session);

        // Set confirmation timeout
        session.confirmTimeout = setTimeout(async () => {
          const s = sessions.get(customerPhone);
          if (s && s.state === STATES.CONFIRM_ORDER) {
            sessions.delete(customerPhone);
            await sendMessage(customerPhone, `⏱️ Confirmation timeout. Start over.`);
          }
        }, 600000); // 10 minutes

        const cartItems = session.cart.map(item => 
          `${item.quantity}× ${item.name} - ₹${item.price * item.quantity}`
        ).join('\n');

        await sendMessage(
          customerPhone,
          `📋 CONFIRM YOUR ORDER\n\n` +
          `🏪 ${session.restaurantName}\n\n` +
          `Your Order:\n${cartItems}\n\n` +
          `💰 Total: ₹${session.total}\n` +
          `📍 Delivery: ${session.deliveryAddress}\n\n` +
          `💵 PAYMENT: CASH ON DELIVERY\n\n` +
          `⚠️ IMPORTANT - Please Read:\n\n` +
          `By confirming, you agree to:\n` +
          `✅ Pay ₹${session.total} in CASH when food arrives\n` +
          `✅ Have EXACT change ready (helps delivery person)\n` +
          `✅ Be available at the delivery address\n` +
          `✅ Accept the order within 30-45 minutes\n\n` +
          `⚠️ Fake orders or no-shows may result in being blocked from the system.\n\n` +
          `---\n\n` +
          `Type CONFIRM to place your order\n` +
          `Type CANCEL to cancel\n\n` +
          `⏱️ You have 10 minutes to respond.`
        );
        return res.status(200).send('OK');
      }

      await sendMessage(customerPhone, `❌ Invalid. Reply 1 for Online or 2 for COD`);
      return res.status(200).send('OK');
    }

    // AWAITING_PAYMENT State (Online Payment)
    if (session.state === STATES.AWAITING_PAYMENT) {
      if (messageUpper === 'CHECK') {
        const isPaid = await verifyPayment(session.paymentId);
        
        if (isPaid) {
          const timeout = pendingPayments.get(customerPhone);
          if (timeout) clearTimeout(timeout);
          pendingPayments.delete(customerPhone);

          const orderId = await saveOrder(session);
          await notifyOwner(session, orderId);
          
          const cartSummary = session.cart.map((item, idx) => 
            `${idx + 1}. ${item.name}\n   Qty: ${item.quantity} × ₹${item.price} = ₹${item.price * item.quantity}`
          ).join('\n\n');

          sessions.delete(customerPhone);

          await sendMessage(
            customerPhone,
            `🎉 Order Confirmed!\n\n` +
            `Order ID: #${orderId}\n` +
            `Restaurant: ${session.restaurantName}\n\n` +
            `🛒 Your Cart:\n\n${cartSummary}\n\n` +
            `Subtotal: ₹${session.subtotal}\n` +
            `Delivery Fee: ₹${session.deliveryFee}\n` +
            `Total: ₹${session.total}\n\n` +
            `📍 Delivery Address:\n${session.deliveryAddress}\n\n` +
            `💳 Payment: Online (PAID)\n` +
            `💰 Total: ₹${session.total}\n\n` +
            `⏱️ Estimated Delivery: 45 minutes\n\n` +
            `The restaurant has been notified and is preparing your food.\n\n` +
            `Thank you for your order! 🍽️\n\n` +
            `Scan QR code to place another order.`
          );
          return res.status(200).send('OK');
        } else {
          await sendMessage(
            customerPhone,
            `⏳ Payment not received yet.\n\n` +
            `Complete payment and type CHECK again.\n` +
            `Or type CANCEL to cancel order.`
          );
          return res.status(200).send('OK');
        }
      }

      if (messageUpper === 'CANCEL') {
        const timeout = pendingPayments.get(customerPhone);
        if (timeout) clearTimeout(timeout);
        pendingPayments.delete(customerPhone);
        sessions.delete(customerPhone);

        await sendMessage(customerPhone, `❌ Order cancelled. Type restaurant name to start over.`);
        return res.status(200).send('OK');
      }

      await sendMessage(customerPhone, `Type CHECK to verify payment or CANCEL to cancel.`);
      return res.status(200).send('OK');
    }

    // CONFIRM_ORDER State (COD)
    if (session.state === STATES.CONFIRM_ORDER) {
      if (messageUpper === 'CONFIRM') {
        if (session.confirmTimeout) clearTimeout(session.confirmTimeout);

        const orderId = await saveOrder(session);
        await notifyOwner(session, orderId);

        const cartSummary = session.cart.map((item, idx) => 
          `${idx + 1}. ${item.name}\n   Qty: ${item.quantity} × ₹${item.price} = ₹${item.price * item.quantity}`
        ).join('\n\n');

        sessions.delete(customerPhone);

        await sendMessage(
          customerPhone,
          `🎉 Order Confirmed!\n\n` +
          `Order ID: #${orderId}\n` +
          `Restaurant: ${session.restaurantName}\n\n` +
          `🛒 Your Cart:\n\n${cartSummary}\n\n` +
          `Subtotal: ₹${session.subtotal}\n` +
          `Delivery Fee: ₹${session.deliveryFee}\n` +
          `Total: ₹${session.total}\n\n` +
          `📍 Delivery Address:\n${session.deliveryAddress}\n\n` +
          `💵 Payment: Cash on Delivery\n` +
          `💰 Total: ₹${session.total}\n\n` +
          `⏱️ Estimated Delivery: 45 minutes\n\n` +
          `The restaurant has been notified and is preparing your food.\n\n` +
          `Thank you for your order! 🍽️\n\n` +
          `Scan QR code to place another order.`
        );
        return res.status(200).send('OK');
      }

      if (messageUpper === 'CANCEL') {
        if (session.confirmTimeout) clearTimeout(session.confirmTimeout);
        sessions.delete(customerPhone);
        await sendMessage(customerPhone, `❌ Order cancelled.`);
        return res.status(200).send('OK');
      }

      await sendMessage(customerPhone, `Type CONFIRM or CANCEL`);
      return res.status(200).send('OK');
    }

    // Default fallback
    await sendMessage(customerPhone, `❌ Something went wrong. Type restaurant name to restart.`);
    return res.status(200).send('OK');

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).send('Error');
  }
});

// ============================================
// PAYMENT WEBHOOK (Razorpay)
// ============================================

app.post('/payment/webhook', async (req, res) => {
  try {
    const event = req.body.event;
    const paymentEntity = req.body.payload?.payment_link?.entity || req.body.payload?.payment?.entity;

    if (!paymentEntity) {
      return res.status(400).send('No payment entity');
    }

    let sessionPhone = null;
    for (const [phone, session] of sessions.entries()) {
      if (session.paymentId === paymentEntity.id) {
        sessionPhone = phone;
        break;
      }
    }

    if (!sessionPhone) {
      console.log('⚠️  No session for payment:', paymentEntity.id);
      return res.status(200).send('OK');
    }

    const session = sessions.get(sessionPhone);

    if (event === 'payment.captured' || event === 'payment_link.paid') {
      const timeout = pendingPayments.get(sessionPhone);
      if (timeout) clearTimeout(timeout);
      pendingPayments.delete(sessionPhone);

      const orderId = await saveOrder(session);
      await notifyOwner(session, orderId);

      await sendMessage(
        sessionPhone,
        `✅ Payment Successful!\n\n` +
        `Order #${orderId} confirmed!\n\n` +
        `Your food will be delivered in 45 minutes.\n\n` +
        `Thank you! 🎉`
      );

      sessions.delete(sessionPhone);
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
      <title>Payment Success</title>
      <style>
        body { font-family: Arial; text-align: center; padding: 50px; }
        .success { color: green; font-size: 60px; }
      </style>
    </head>
    <body>
      <div class="success">✅</div>
      <h1>Payment Successful!</h1>
      <p>Check WhatsApp for order confirmation.</p>
    </body>
    </html>
  `);
});

// ============================================
// HEALTH ENDPOINTS
// ============================================

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'OK',
      database: 'Connected',
      sessions: sessions.size,
      restaurants: restaurantCache.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      status: 'ERROR',
      database: 'Disconnected',
      error: error.message
    });
  }
});

app.get('/restaurants', async (req, res) => {
  await loadRestaurants(true);
  res.json({
    count: restaurantCache.length,
    restaurants: restaurantCache
  });
});

// ============================================
// ERROR HANDLERS
// ============================================

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});

process.on('SIGTERM', async () => {
  console.log('👋 Shutting down...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('👋 Shutting down...');
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
║   🍽️  RESTAURANT BOT v5.0 ULTIMATE   ║
╠════════════════════════════════════════╣
║  Port: ${PORT}
║  Environment: ${NODE_ENV}
║  Database: ${dbConnected ? '✅' : '❌'}
║  Restaurants: ${restaurantCache.length}
║  Sessions: ${sessions.size}
╚════════════════════════════════════════╝
      `);
    });

  } catch (error) {
    console.error('❌ Startup failed:', error);
    process.exit(1);
  }
}

startServer();
