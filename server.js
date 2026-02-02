// ============================================
// RESTAURANT WHATSAPP BOT v5.2 - FIXED
// Multi-Restaurant | Payment Options | Fixed Re-trigger
// ============================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const TEST_MODE = process.env.TEST_MODE === 'true';

// ─── Middleware ──────────────────────────────
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.set('trust proxy', true);

// ─── Twilio Setup ────────────────────────────
const accountSid  = process.env.TWILIO_ACCOUNT_SID;
const authToken   = process.env.TWILIO_AUTH_TOKEN;
const wabaNumber  = process.env.WABA_NUMBER;

let twilioClient = null;
if (!TEST_MODE) {
  if (!accountSid || !authToken || !wabaNumber) {
    console.error('❌ FATAL: Missing Twilio credentials in .env');
    process.exit(1);
  }
  twilioClient = twilio(accountSid, authToken);
} else {
  console.log('🧪 TEST MODE ON — Twilio calls mocked');
}

// ─── Database Pool ───────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:              { rejectUnauthorized: false, require: true },
  connectionTimeoutMillis: 10000,
  max: 10,
  min: 0,
  idleTimeoutMillis: 5000,
  statement_timeout: 30000
});

let dbConnected = false;
pool.on('connect', () => { dbConnected = true; });
pool.on('error', (e) => {
  console.warn('⚠️  Pool idle connection terminated (expected with Neon):', e.message);
});

async function connectDatabase(retries = 5) {
  console.log('\n🔌 Connecting to database...');
  for (let i = 1; i <= retries; i++) {
    try {
      const c = await pool.connect();
      await c.query('SELECT NOW()');
      c.release();
      dbConnected = true;
      console.log(`✅ Database connected (attempt ${i})`);
      return;
    } catch (e) {
      console.error(`❌ Attempt ${i}/${retries}:`, e.message);
      if (i < retries) await new Promise(r => setTimeout(r, Math.min(1000 * (2 ** i), 10000)));
    }
  }
  console.error('❌ FATAL: DB connection failed'); process.exit(1);
}

// ─── In-Memory Stores ────────────────────────
const sessions        = new Map();
const pendingPayments = new Map();
const testMessages    = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [phone, s] of sessions) {
    if (now - s.createdAt > 1800000) {
      if (s.confirmTimeout) clearTimeout(s.confirmTimeout);
      sessions.delete(phone);
    }
  }
}, 300000);

// ─── Restaurant Cache ────────────────────────
let restaurantCache = [], lastCacheUpdate = 0;
const CACHE_TTL = 300000;

// ─── States ──────────────────────────────────
const S = {
  SELECT_SERVICE:   'SELECT_SERVICE',
  BROWSE_MENU:      'BROWSE_MENU',
  ADD_ADDRESS:      'ADD_ADDRESS',
  ADD_INSTRUCTIONS: 'ADD_INSTRUCTIONS',
  CHOOSE_PAYMENT:   'CHOOSE_PAYMENT',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  CONFIRM_ORDER:    'CONFIRM_ORDER',
  BOOKING_DATE:     'BOOKING_DATE',
  BOOKING_TIME:     'BOOKING_TIME',
  BOOKING_GUESTS:   'BOOKING_GUESTS',
  BOOKING_CONFIRM:  'BOOKING_CONFIRM'
};

// ════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════

async function sendMessage(to, body) {
  if (!testMessages.has(to)) testMessages.set(to, []);
  testMessages.get(to).push({ body, timestamp: Date.now() });

  if (TEST_MODE) {
    console.log(`📤 [TEST] → ${to}`);
    return { sid: 'test_' + Date.now() };
  }
  try {
    const msg = await twilioClient.messages.create({ from: wabaNumber, to: `whatsapp:${to}`, body });
    console.log(`✅ Sent → ${to}: ${msg.sid}`);
    return msg;
  } catch (e) {
    console.error(`❌ Send failed → ${to}:`, e.message);
    throw e;
  }
}

async function loadRestaurants(force = false) {
  if (!force && restaurantCache.length && (Date.now() - lastCacheUpdate) < CACHE_TTL)
    return restaurantCache;
  try {
    const { rows } = await pool.query(`SELECT * FROM restaurants ORDER BY name`);
    const hasActive = rows.length > 0 && 'active' in rows[0];
    restaurantCache = hasActive ? rows.filter(r => r.active) : rows;
    lastCacheUpdate = Date.now();
    if (rows.length > 0) {
      console.log(`📋 Cached ${restaurantCache.length} restaurants | columns: ${Object.keys(rows[0]).join(', ')}`);
    } else {
      console.log('⚠️  restaurants table is empty');
    }
    return restaurantCache;
  } catch (e) {
    console.error('❌ loadRestaurants:', e.message);
    return restaurantCache;
  }
}

async function getMenuItems(restaurantId) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM menu_items WHERE restaurant_id = $1 ORDER BY category, name`,
      [restaurantId]
    );
    const hasAvailable = rows.length > 0 && 'available' in rows[0];
    const filtered = hasAvailable ? rows.filter(r => r.available) : rows;
    if (filtered.length > 0) {
      console.log(`📋 Loaded ${filtered.length} menu items for restaurant ${restaurantId}`);
    }
    return filtered;
  } catch (e) {
    console.error('❌ getMenuItems:', e.message);
    return [];
  }
}

function formatMenu(items, restaurantName) {
  const grouped = {};
  items.forEach(i => { (grouped[i.category] = grouped[i.category] || []).push(i); });

  let m = `📋 *${restaurantName}* - Menu\n\n`;
  Object.keys(grouped).sort().forEach(cat => {
    m += `*${cat.toUpperCase()}*\n`;
    grouped[cat].forEach(i => {
      m += `${i.is_vegetarian ? '🟢' : '🔴'} ${i.id}. ${i.name} - ₹${i.price}\n`;
      if (i.description) m += `   ${i.description}\n`;
    });
    m += '\n';
  });
  m += `📝 *To order:*\nType item ID and quantity (e.g., "15 2")\nType "done" when finished\nType "cart" to view cart`;
  return m;
}

function formatCart(cart, deliveryFee = 0) {
  if (!cart || !cart.length) return '🛒 Your cart is empty';
  let m = '🛒 *Your Cart:*\n\n', sub = 0;
  cart.forEach((item, i) => {
    const t = item.price * item.quantity; sub += t;
    m += `${i + 1}. ${item.name}\n   Qty: ${item.quantity} × ₹${item.price} = ₹${t}\n\n`;
  });
  m += `Subtotal: ₹${sub}\nDelivery Fee: ₹${deliveryFee}\n*Total: ₹${Number(sub) + Number(deliveryFee)}*`;
  return m;
}

async function saveOrder(session) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO orders (
         restaurant_id, customer_phone, delivery_address, special_instructions,
         total_amount, status, payment_status, payment_method, created_at, confirmed_at
       ) VALUES ($1,$2,$3,$4,$5,'CONFIRMED',$6,$7,NOW(),NOW()) RETURNING id`,
      [
        session.restaurantId, session.phone, session.deliveryAddress,
        session.specialInstructions || '', session.total,
        session.paymentMethod === 'online' ? 'PAID' : 'COD',
        session.paymentMethod
      ]
    );
    const orderId = rows[0].id;
    for (const item of session.cart) {
      await client.query(
        'INSERT INTO order_items (order_id, menu_item_id, quantity, price, subtotal) VALUES ($1,$2,$3,$4,$5)',
        [orderId, item.id, item.quantity, item.price, item.price * item.quantity]
      );
    }
    await client.query('COMMIT');
    console.log(`✅ Order #${orderId} saved`);
    return orderId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function notifyOwner(session, orderId) {
  try {
    const { rows } = await pool.query(
      'SELECT whatsapp_number, notify_on_order FROM restaurants WHERE id=$1',
      [session.restaurantId]
    );
    if (!rows[0]) return;
    if (rows[0].notify_on_order === false) {
      console.log(`⏭️  Owner notification skipped — notify_on_order is off for restaurant ${session.restaurantId}`);
      return;
    }
    const ownerWA = rows[0].whatsapp_number;
    if (!ownerWA) {
      console.log(`⚠️  No whatsapp_number for restaurant ${session.restaurantId}`);
      return;
    }
    const payLabel = session.paymentMethod === 'online' ? '💳 ONLINE PAID' : '💵 CASH ON DELIVERY';
    let m = `🔔 *NEW ORDER #${orderId}*\n\n🏪 ${session.restaurantName}\n📱 Customer: ${session.phone}\n📍 Address: ${session.deliveryAddress}\n\n🛒 *Items:*\n`;
    session.cart.forEach(i => { m += `• ${i.quantity}× ${i.name} — ₹${i.price * i.quantity}\n`; });
    m += `\n💰 *Total: ₹${session.total}*\n${payLabel}`;
    if (session.specialInstructions && session.specialInstructions.toLowerCase() !== 'no')
      m += `\n📝 Instructions: ${session.specialInstructions}`;
    m += `\n⏰ ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
    await sendMessage(ownerWA, m);
    console.log(`✅ Owner notified at ${ownerWA}`);
  } catch (e) { console.error('❌ notifyOwner:', e.message); }
}

async function createPaymentLink(session) {
  if (TEST_MODE) {
    const id = 'plink_test_' + Date.now();
    return { id, short_url: `https://pay.razorpay.com/i/${id}` };
  }
  try {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      console.error('❌ Razorpay credentials missing in environment');
      return null;
    }
    const Razorpay = require('razorpay');
    const rp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    const link = await rp.paymentLink.create({
      amount: Number(session.total) * 100, currency: 'INR',
      description: `Order from ${session.restaurantName}`,
      customer: { contact: session.phone },
      notify: { sms: true, whatsapp: true },
      callback_url: `${process.env.BASE_URL || 'https://restaurant.legacylens.co.in'}/payment/callback`,
      callback_method: 'get'
    });
    console.log(`✅ Payment link created: ${link.short_url}`);
    return link;
  } catch (e) { 
    console.error('❌ createPaymentLink error:', e.message); 
    return null; 
  }
}

async function verifyPayment(paymentId, phone) {
  if (TEST_MODE) {
    const s = sessions.get(phone);
    return s && s.testPaymentPaid === true;
  }
  try {
    const Razorpay = require('razorpay');
    const rp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    const link = await rp.paymentLink.fetch(paymentId);
    return link.status === 'paid';
  } catch (e) { console.error('❌ verifyPayment:', e.message); return false; }
}

function buildOrderConfirmation(session, orderId) {
  const cart = session.cart.map((item, i) =>
    `${i+1}. ${item.name}\n   Qty: ${item.quantity} × ₹${item.price} = ₹${item.price * item.quantity}`
  ).join('\n\n');
  const pay = session.paymentMethod === 'online'
    ? '💳 Payment: Online (PAID)'
    : '💵 Payment: Cash on Delivery';
  return (
    `🎉 *Order Confirmed!*\n\n` +
    `Order ID: #${orderId}\n` +
    `Restaurant: ${session.restaurantName}\n\n` +
    `🛒 Your Cart:\n${cart}\n\n` +
    `Subtotal: ₹${session.subtotal}\n` +
    `Delivery Fee: ₹${session.deliveryFee}\n` +
    `Total: ₹${session.total}\n\n` +
    `📍 Delivery Address:\n${session.deliveryAddress}\n\n` +
    `${pay}\n` +
    `💰 Total: ₹${session.total}\n\n` +
    `⏱️ Estimated Delivery: 45 minutes\n\n` +
    `The restaurant has been notified and is preparing your food.\n\n` +
    `Thank you for your order! 🍽️\n\n` +
    `Scan QR code to place another order.`
  );
}

// ════════════════════════════════════════════
// MAIN WEBHOOK
// ════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  try {
    const { From, Body } = req.body;
    if (!From || !Body) return res.status(400).send('Missing params');

    const phone = From.replace('whatsapp:', '');
    const text  = Body.trim();
    const upper = text.toUpperCase();

    console.log(`\n📱 [${phone}] → "${text}"`);

    // Quick liveness check
    try {
      await pool.query('SELECT 1');
      dbConnected = true;
    } catch (e) {
      console.error('❌ DB ping failed:', e.message);
      await sendMessage(phone, '⚠️ System temporarily unavailable. Try again shortly.');
      return res.status(503).send('DB down');
    }

    await loadRestaurants();

    // ═══════════════════════════════════════════════════════════
    // PRIORITY: Check for restaurant keyword FIRST (allows restart)
    // ═══════════════════════════════════════════════════════════
    const restaurant = restaurantCache.find(r =>
      r.qr_keyword && upper.includes(r.qr_keyword.toUpperCase())
    );
    
    if (restaurant) {
      // ✅ FIX: Clear ALL existing timeouts and sessions for this user
      const old = sessions.get(phone);
      if (old?.confirmTimeout) clearTimeout(old.confirmTimeout);
      const paymentTimeout = pendingPayments.get(phone);
      if (paymentTimeout) {
        clearTimeout(paymentTimeout);
        pendingPayments.delete(phone);
      }

      const canDeliver = restaurant.delivery_available !== false;
      const canBook    = restaurant.table_booking_available !== false;

      // Create FRESH session
      sessions.set(phone, {
        phone, state: S.SELECT_SERVICE,
        restaurantId: restaurant.id, 
        restaurantName: restaurant.name,
        deliveryFee:  restaurant.delivery_fee || 30,
        minOrder:     restaurant.min_delivery_amount || 0,
        canDeliver, canBook,
        createdAt: Date.now()
      });

      // Build options dynamically
      let options = '', idx = 0;
      if (canDeliver) { idx++; options += `${idx}️⃣ Order Delivery\n`; }
      if (canBook)    { idx++; options += `${idx}️⃣ Book a Table\n`; }

      await sendMessage(phone,
        `🎉 Welcome to *${restaurant.name}*!\n\n` +
        `What would you like to do?\n\n` +
        options + `\nReply with ${idx === 1 ? '1' : '1 or 2'}`
      );
      
      console.log(`✅ Session reset for ${phone} - Restaurant: ${restaurant.name}`);
      return res.status(200).send('OK');
    }

    // ─── Get existing session ──────────────────────────
    let session = sessions.get(phone);
    
    if (!session) {
      const isGreeting = ['hi','hello','hey','start','menu','help'].some(w => text.toLowerCase().includes(w));
      await sendMessage(phone, isGreeting
        ? `👋 *Welcome!*\n\nScan the QR code to start ordering!`
        : `👋 Scan the QR code to start ordering!`
      );
      return res.status(200).send('OK');
    }

    // ═══════════════════════════════════════════
    // STATE MACHINE
    // ═══════════════════════════════════════════

    if (session.state === S.SELECT_SERVICE) {
      let action = null;
      if (session.canDeliver && session.canBook) {
        if (text === '1') action = 'delivery';
        if (text === '2') action = 'booking';
      } else if (session.canDeliver) {
        if (text === '1') action = 'delivery';
      } else if (session.canBook) {
        if (text === '1') action = 'booking';
      }

      if (action === 'delivery') {
        session.state = S.BROWSE_MENU; 
        session.serviceType = 'delivery'; 
        session.cart = [];
        session.menuItems = await getMenuItems(session.restaurantId);
        sessions.set(phone, session);
        await sendMessage(phone, formatMenu(session.menuItems, session.restaurantName));
        return res.status(200).send('OK');
      }
      
      if (action === 'booking') {
        session.state = S.BOOKING_DATE; 
        session.serviceType = 'booking';
        sessions.set(phone, session);
        await sendMessage(phone, `📅 When would you like to book?\n\nType:\n• TODAY or TOMORROW\n• DD/MM/YYYY`);
        return res.status(200).send('OK');
      }
      
      const max = (session.canDeliver && session.canBook) ? '1 or 2' : '1';
      await sendMessage(phone, `❌ Invalid choice.\n\nPlease reply with:\n${session.canDeliver ? '1️⃣ for Order Delivery\n' : ''}${session.canBook ? '2️⃣ for Book a Table' : ''}`);
      return res.status(200).send('OK');
    }

    if (session.state === S.BROWSE_MENU) {
      if (upper === 'CART') {
        await sendMessage(phone, session.cart.length ? formatCart(session.cart, session.deliveryFee) : '🛒 Cart is empty.\n\nAdd items: item_id quantity');
        return res.status(200).send('OK');
      }
      
      if (upper === 'DONE') {
        if (!session.cart.length) { 
          await sendMessage(phone, '🛒 Cart is empty. Add items first!'); 
          return res.status(200).send('OK'); 
        }
        const sub = session.cart.reduce((s,i) => s + i.price * i.quantity, 0);
        if (sub < session.minOrder) { 
          await sendMessage(phone, `⚠️ Minimum order: ₹${session.minOrder}\nCurrent: ₹${sub}`); 
          return res.status(200).send('OK'); 
        }
        session.subtotal = sub; 
        session.total = Number(sub) + Number(session.deliveryFee); 
        session.state = S.ADD_ADDRESS;
        sessions.set(phone, session);
        await sendMessage(phone, `${formatCart(session.cart, session.deliveryFee)}\n\n📍 Please enter your delivery address:`);
        return res.status(200).send('OK');
      }
      
      const match = text.match(/^(\d+)\s+(\d+)$/);
      if (match) {
        const id = parseInt(match[1]), qty = parseInt(match[2]);
        const item = session.menuItems.find(m => m.id === id);
        if (!item) { 
          await sendMessage(phone, `❌ Item #${id} not found.`); 
          return res.status(200).send('OK'); 
        }
        if (qty < 1 || qty > 99) { 
          await sendMessage(phone, '❌ Qty must be 1–99'); 
          return res.status(200).send('OK'); 
        }
        const ex = session.cart.find(c => c.id === id);
        if (ex) ex.quantity += qty;
        else session.cart.push({ id: item.id, name: item.name, price: item.price, quantity: qty });
        sessions.set(phone, session);
        await sendMessage(phone, `✅ Added to cart!\n\n${formatCart(session.cart, session.deliveryFee)}\n\nAdd more items or type "done" to proceed.`);
        return res.status(200).send('OK');
      }
      
      await sendMessage(phone, '❌ Use: item_id quantity (e.g., "15 2")');
      return res.status(200).send('OK');
    }

    if (session.state === S.ADD_ADDRESS) {
      session.deliveryAddress = text; 
      session.state = S.ADD_INSTRUCTIONS;
      sessions.set(phone, session);
      await sendMessage(phone, `✅ Address saved!\n\nAny special instructions? (Type "no" if none)`);
      return res.status(200).send('OK');
    }

    // ═══════════════════════════════════════════════════════════
    // ✅ FIX: ADD_INSTRUCTIONS → CHOOSE_PAYMENT (Show payment options)
    // ═══════════════════════════════════════════════════════════
    if (session.state === S.ADD_INSTRUCTIONS) {
      session.specialInstructions = text;
      session.state = S.CHOOSE_PAYMENT;  // ← Set to CHOOSE_PAYMENT
      sessions.set(phone, session);

      const lines = session.cart.map(i => `  ${i.quantity}× ${i.name} — ₹${i.price * i.quantity}`).join('\n');

      // ✅ Show payment choice menu
      await sendMessage(phone,
        `💳 *Choose Payment Method*\n\n` +
        `🛒 *Your Order:*\n${lines}\n\n` +
        `Subtotal: ₹${session.subtotal}\n` +
        `Delivery Fee: ₹${session.deliveryFee}\n` +
        `💰 *Total: ₹${session.total}*\n\n` +
        `📍 Delivery: ${session.deliveryAddress}\n\n` +
        `Select payment method:\n\n` +
        `1️⃣ Online Payment (Razorpay)\n` +
        `    💳 Secure & instant confirmation\n` +
        `    ✅ Pay now with credit/debit card or UPI\n\n` +
        `2️⃣ Cash on Delivery (COD)\n` +
        `    💵 Pay when food arrives\n` +
        `    ⚠️ Have exact change ready\n\n` +
        `Reply with *1* or *2*`
      );
      return res.status(200).send('OK');
    }

    // ═══════════════════════════════════════════════════════════
    // ✅ CHOOSE_PAYMENT State Handler
    // ═══════════════════════════════════════════════════════════
    if (session.state === S.CHOOSE_PAYMENT) {
      // ─── Option 1: Online Payment ──────────────────────
      if (text === '1') {
        session.paymentMethod = 'online'; 
        session.state = S.AWAITING_PAYMENT;
        sessions.set(phone, session);
        
        const link = await createPaymentLink(session);
        if (!link?.short_url) {
          session.state = S.CHOOSE_PAYMENT; 
          sessions.set(phone, session);
          await sendMessage(phone, '❌ Online payment is temporarily unavailable.\n\nReply *2* for Cash on Delivery');
          return res.status(200).send('OK');
        }
        
        session.paymentId = link.id; 
        session.paymentLink = link.short_url;
        sessions.set(phone, session);
        
        pendingPayments.set(phone, setTimeout(async () => {
          if (sessions.get(phone)?.state === S.AWAITING_PAYMENT) {
            sessions.delete(phone);
            await sendMessage(phone, '⏱️ Payment timeout. Type restaurant name to start over.');
          }
        }, 900000));
        
        await sendMessage(phone,
          `💳 *Complete Payment*\n\n` +
          `Amount: ₹${session.total}\n\n` +
          `Click the link below to pay securely:\n${link.short_url}\n\n` +
          `After completing payment:\n` +
          `• Type *CHECK* to verify your payment\n` +
          `• Type *CANCEL* to cancel the order\n\n` +
          `⏱️ Payment link expires in 15 minutes`
        );
        return res.status(200).send('OK');
      }
      
      // ─── Option 2: Cash on Delivery ────────────────────
      if (text === '2') {
        session.paymentMethod = 'cod'; 
        session.state = S.CONFIRM_ORDER;
        session.confirmTimeout = setTimeout(async () => {
          if (sessions.get(phone)?.state === S.CONFIRM_ORDER) {
            sessions.delete(phone);
            await sendMessage(phone, '⏱️ Confirmation timeout. Start over.');
          }
        }, 600000);
        sessions.set(phone, session);
        
        const lines = session.cart.map(i => `${i.quantity}× ${i.name} — ₹${i.price * i.quantity}`).join('\n');
        
        await sendMessage(phone,
          `📋 *CONFIRM YOUR ORDER*\n\n` +
          `🏪 ${session.restaurantName}\n\n` +
          `*Your Order:*\n${lines}\n\n` +
          `💰 Total: ₹${session.total}\n` +
          `📍 Delivery: ${session.deliveryAddress}\n\n` +
          `💵 *PAYMENT: CASH ON DELIVERY*\n\n` +
          `⚠️ *IMPORTANT - Please Read:*\n\n` +
          `By confirming, you agree to:\n` +
          `✅ Pay ₹${session.total} in CASH when food arrives\n` +
          `✅ Have EXACT change ready (helps delivery person)\n` +
          `✅ Be available at the delivery address\n` +
          `✅ Accept the order within 30-45 minutes\n\n` +
          `⚠️ Fake orders or no-shows may result in being blocked from the system.\n\n` +
          `---\n\n` +
          `Type *CONFIRM* to place your order\n` +
          `Type *CANCEL* to cancel\n\n` +
          `⏱️ You have 10 minutes to respond.`
        );
        return res.status(200).send('OK');
      }
      
      // Invalid choice
      await sendMessage(phone, `❌ Invalid choice.\n\nReply *1* for Online Payment or *2* for Cash on Delivery`);
      return res.status(200).send('OK');
    }

    // ─── AWAITING_PAYMENT ────────────────────
    if (session.state === S.AWAITING_PAYMENT) {
      if (upper === 'CHECK') {
        const paid = await verifyPayment(session.paymentId, phone);
        if (paid) {
          const t = pendingPayments.get(phone); 
          if (t) clearTimeout(t);
          pendingPayments.delete(phone);
          const orderId = await saveOrder(session);
          await notifyOwner(session, orderId);
          sessions.delete(phone);
          await sendMessage(phone, buildOrderConfirmation(session, orderId));
          return res.status(200).send('OK');
        }
        await sendMessage(phone, `⏳ Payment not received yet.\n\nComplete payment via the link, then type *CHECK* again.\nOr type *CANCEL* to cancel.`);
        return res.status(200).send('OK');
      }
      
      if (upper === 'CANCEL') {
        const t = pendingPayments.get(phone); 
        if (t) clearTimeout(t);
        pendingPayments.delete(phone); 
        sessions.delete(phone);
        await sendMessage(phone, '❌ Order cancelled. Type restaurant name to start over.');
        return res.status(200).send('OK');
      }
      
      await sendMessage(phone, 'Type *CHECK* to verify payment or *CANCEL* to cancel.');
      return res.status(200).send('OK');
    }

    // ─── CONFIRM_ORDER (COD) ─────────────────
    if (session.state === S.CONFIRM_ORDER) {
      if (upper === 'CONFIRM') {
        if (session.confirmTimeout) clearTimeout(session.confirmTimeout);
        const orderId = await saveOrder(session);
        await notifyOwner(session, orderId);
        sessions.delete(phone);
        await sendMessage(phone, buildOrderConfirmation(session, orderId));
        return res.status(200).send('OK');
      }
      
      if (upper === 'CANCEL') {
        if (session.confirmTimeout) clearTimeout(session.confirmTimeout);
        sessions.delete(phone);
        await sendMessage(phone, '❌ Order cancelled.');
        return res.status(200).send('OK');
      }
      
      await sendMessage(phone, 'Type *CONFIRM* or *CANCEL*');
      return res.status(200).send('OK');
    }

    await sendMessage(phone, '❌ Something went wrong. Type restaurant name to restart.');
    return res.status(200).send('OK');

  } catch (e) { 
    console.error('❌ Webhook:', e); 
    res.status(500).send('Error'); 
  }
});

// ─── Razorpay Payment Webhook ────────────────
app.post('/payment/webhook', async (req, res) => {
  try {
    const event  = req.body.event;
    const entity = req.body.payload?.payment_link?.entity || req.body.payload?.payment?.entity;
    if (!entity) return res.status(400).send('No entity');
    
    let phone = null;
    for (const [p, s] of sessions) { 
      if (s.paymentId === entity.id) { 
        phone = p; 
        break; 
      } 
    }
    if (!phone) return res.status(200).send('OK');
    
    if (event === 'payment.captured' || event === 'payment_link.paid') {
      const session = sessions.get(phone);
      const t = pendingPayments.get(phone); 
      if (t) clearTimeout(t);
      pendingPayments.delete(phone);
      session.paymentMethod = 'online';
      const orderId = await saveOrder(session);
      await notifyOwner(session, orderId);
      await sendMessage(phone, buildOrderConfirmation(session, orderId));
      sessions.delete(phone);
    }
    res.status(200).send('OK');
  } catch (e) { 
    console.error('❌ Pay webhook:', e.message); 
    res.status(500).send('Error'); 
  }
});

app.get('/payment/callback', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Payment Success</title>
<style>body{font-family:Arial;text-align:center;padding:60px;background:#f0faf0}.ck{font-size:80px}h1{color:#2e7d32}p{color:#555;font-size:18px}</style></head>
<body><div class="ck">✅</div><h1>Payment Successful!</h1>
<p>Return to WhatsApp and type <b>CHECK</b> to confirm your order.</p></body></html>`);
});

// ─── API Endpoints ───────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status:'OK', 
      database:'Connected', 
      sessions: sessions.size, 
      restaurants: restaurantCache.length, 
      testMode: TEST_MODE,
      version: '5.2-FIXED'
    });
  } catch { 
    res.status(503).json({ status:'ERROR', database:'Disconnected' }); 
  }
});

app.get('/restaurants', async (req, res) => {
  await loadRestaurants(true);
  res.json({ count: restaurantCache.length, restaurants: restaurantCache });
});

app.get('/menu/:restaurantId', async (req, res) => {
  const items = await getMenuItems(parseInt(req.params.restaurantId));
  res.json({ restaurantId: req.params.restaurantId, items });
});

app.get('/test-session/:phone', (req, res) => {
  const s = sessions.get(req.params.phone);
  res.json(s ? { 
    found:true, 
    state:s.state, 
    restaurantName:s.restaurantName, 
    cartSize: s.cart?.length||0 
  } : { found:false });
});

app.post('/admin/clear-sessions', (req, res) => {
  if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) 
    return res.status(401).json({ error:'Unauthorized' });
  sessions.forEach(s => { if (s.confirmTimeout) clearTimeout(s.confirmTimeout); });
  sessions.clear(); 
  res.json({ cleared: true });
});

app.post('/reload-cache', (req, res) => {
  loadRestaurants(true).then(() => res.json({ 
    reloaded:true, 
    count: restaurantCache.length 
  }));
});

// ─── Test Endpoints ──────────────────────────
app.get('/test/messages/:phone', (req, res) => {
  const msgs = testMessages.get(req.params.phone) || [];
  testMessages.delete(req.params.phone);
  res.json({ messages: msgs });
});

app.post('/test/simulate-payment/:phone', (req, res) => {
  const s = sessions.get(req.params.phone);
  if (s && s.state === S.AWAITING_PAYMENT) {
    s.testPaymentPaid = true;
    sessions.set(req.params.phone, s);
    res.json({ success: true, paymentId: s.paymentId });
  } else {
    res.json({ success: false, reason: 'No pending payment session' });
  }
});

// ─── Handlers ────────────────────────────────
process.on('uncaughtException', e  => console.error('❌ Uncaught:', e));
process.on('unhandledRejection', e => console.error('❌ Unhandled:', e));
process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
process.on('SIGINT',  async () => { await pool.end(); process.exit(0); });

// ─── Startup ─────────────────────────────────
async function startServer() {
  try {
    await connectDatabase();
    await loadRestaurants();
    app.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════════╗
║   🍽️  RESTAURANT WHATSAPP BOT v5.2           ║
║   ✅ FIXED: Re-trigger + Payment Options     ║
╠═══════════════════════════════════════════════╣
║  Port:           ${String(PORT).padEnd(28)}║
║  Test Mode:      ${String(TEST_MODE ? '🧪 ON' : '🚀 OFF').padEnd(28)}║
║  Database:       ${String(dbConnected ? '✅ Connected' : '❌ Disconnected').padEnd(28)}║
║  Restaurants:    ${String(restaurantCache.length).padEnd(28)}║
║  Razorpay:       ${String(process.env.RAZORPAY_KEY_ID ? '✅ Configured' : '⚠️  Not set').padEnd(28)}║
╠═══════════════════════════════════════════════╣
║  ✅ FIX 1: Restaurant keyword restarts bot   ║
║  ✅ FIX 2: Payment options now display       ║
╠═══════════════════════════════════════════════╣
║  Flow: Trigger → Service → Menu → Address   ║
║        → Instructions → PAYMENT CHOICE       ║
║        → [1: Online] or [2: COD Confirm]    ║
╚═══════════════════════════════════════════════╝
      `);
    });
  } catch (e) { 
    console.error('❌ Startup failed:', e); 
    process.exit(1); 
  }
}

startServer();
