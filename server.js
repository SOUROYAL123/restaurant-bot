// ============================================
// RESTAURANT WHATSAPP BOT v7.0 - META CLOUD API
// ✅ FEATURE: 100% Twilio-Free (Zero Middleware Cost)
// ✅ FEATURE: Native Meta Interactive Buttons (Accept/Reject)
// ✅ FEATURE: PhonePe Payment & Auto-Refund Integration
// ✅ FEATURE: Conditional Takeaway Toggle (< Rs.500 = Takeaway)
// ============================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const crypto = require('crypto');
const axios = require('axios');

// Import the multi-payment gateway methods
const { createPayment, refundPhonePePayment } = require('./features/payment-multi');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const TEST_MODE = process.env.TEST_MODE === 'true';

// ─── STARTUP STATS ────────────────────────────────
const startTime = Date.now();
const serverStats = {
  totalOrdersToday: 0,
  lastOrderTime: null,
  lastResetDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
};

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.set('trust proxy', true);

// Meta Credentials
const metaPhoneId = process.env.META_PHONE_NUMBER_ID;
const metaToken = process.env.META_ACCESS_TOKEN;

if (!TEST_MODE && (!metaPhoneId || !metaToken)) {
  console.error('FATAL: Missing META_PHONE_NUMBER_ID or META_ACCESS_TOKEN in .env');
  process.exit(1);
}

// ─── DATABASE CONNECTION ──────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false, require: true },
  connectionTimeoutMillis: 10000,
  max: 20, min: 0, idleTimeoutMillis: 5000, statement_timeout: 30000
});

let dbConnected = false;
pool.on('connect', () => { dbConnected = true; });
pool.on('error', (e) => { console.warn('Pool idle connection terminated:', e.message); });

async function connectDatabase(retries = 5) {
  console.log('\nConnecting to database...');
  for (let i = 1; i <= retries; i++) {
    try {
      const c = await pool.connect();
      await c.query('SELECT NOW()');
      c.release();
      dbConnected = true;
      console.log('Database connected successfully.');
      return;
    } catch (e) {
      console.error(`Attempt ${i}/${retries}:`, e.message);
      if (i < retries) await new Promise(r => setTimeout(r, Math.min(1000 * (2 ** i), 10000)));
    }
  }
  console.error('FATAL: DB connection failed');
  process.exit(1);
}

const sessions        = new Map();
const pendingPayments = new Map();

// Session Cleanup (Every 5 mins)
setInterval(() => {
  const now = Date.now();
  for (const [phone, s] of sessions) {
    if (now - s.createdAt > 1800000) { // 30 mins expiry
      if (s.confirmTimeout) clearTimeout(s.confirmTimeout);
      sessions.delete(phone);
    }
  }
}, 300000);

let restaurantCache = [], lastCacheUpdate = 0;
const CACHE_TTL = 300000;

const S = {
  SELECT_SERVICE: 'SELECT_SERVICE', BROWSE_MENU: 'BROWSE_MENU', CHOOSE_ORDER_TYPE: 'CHOOSE_ORDER_TYPE',
  ADD_ADDRESS: 'ADD_ADDRESS', ADD_INSTRUCTIONS: 'ADD_INSTRUCTIONS', CHOOSE_PAYMENT: 'CHOOSE_PAYMENT',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT', CONFIRM_ORDER: 'CONFIRM_ORDER',
  BOOKING_NAME: 'BOOKING_NAME', BOOKING_DATE: 'BOOKING_DATE', BOOKING_TIME: 'BOOKING_TIME',
  BOOKING_GUESTS: 'BOOKING_GUESTS', BOOKING_SELECT_PAYMENT_METHOD: 'BOOKING_SELECT_PAYMENT_METHOD',
  BOOKING_PAYMENT: 'BOOKING_PAYMENT', BOOKING_VERIFY_PAYMENT: 'BOOKING_VERIFY_PAYMENT', BOOKING_CONFIRM: 'BOOKING_CONFIRM'
};

async function loadRestaurants(force = false) {
  if (!force && restaurantCache.length && (Date.now() - lastCacheUpdate) < CACHE_TTL) return restaurantCache;
  try {
    const { rows } = await pool.query('SELECT * FROM restaurants ORDER BY name');
    const hasActive = rows.length > 0 && 'active' in rows[0];
    restaurantCache = hasActive ? rows.filter(r => r.active) : rows;
    lastCacheUpdate = Date.now();
    return restaurantCache;
  } catch (e) { console.error('loadRestaurants:', e.message); return restaurantCache; }
}

async function getRestaurantUPIIds(restaurantId) {
  const DEFAULT_UPI_IDS = { phonepe: '7980407413@ibl', gpay: '7980407413@ibl', paytm: '7980407413@paytm', generic: '7980407413@ibl' };
  try {
    const { rows } = await pool.query('SELECT phonepe_upi_id, gpay_upi_id, paytm_upi_id, generic_upi_id FROM restaurants WHERE id = $1', [restaurantId]);
    if (rows.length === 0) return DEFAULT_UPI_IDS;
    const r = rows[0];
    return { phonepe: r.phonepe_upi_id || DEFAULT_UPI_IDS.phonepe, gpay: r.gpay_upi_id || DEFAULT_UPI_IDS.gpay, paytm: r.paytm_upi_id || DEFAULT_UPI_IDS.paytm, generic: r.generic_upi_id || DEFAULT_UPI_IDS.generic };
  } catch (error) { return DEFAULT_UPI_IDS; }
}

// ─── META MESSAGING APIS ────────────────────────

async function sendMessage(toPhone, textBody) {
  if (TEST_MODE) return console.log(`[TEST] -> ${toPhone}: ${textBody}`);
  
  const cleanPhone = toPhone.replace(/\D/g, ''); // Ensure pure numeric string for Meta
  const MAX_LENGTH = 4000; // Meta allows 4096, keeping a safe margin
  const chunks = textBody.match(new RegExp('.{1,' + MAX_LENGTH + '}', 'gs')) || [];

  for (const chunk of chunks) {
    try {
      await axios.post(
        `https://graph.facebook.com/v20.0/${metaPhoneId}/messages`,
        { messaging_product: 'whatsapp', recipient_type: 'individual', to: cleanPhone, type: 'text', text: { body: chunk } },
        { headers: { 'Authorization': `Bearer ${metaToken}`, 'Content-Type': 'application/json' } }
      );
    } catch (e) { console.error(`Meta Send Error -> ${cleanPhone}:`, e.response?.data || e.message); }
  }
}

async function sendKitchenAlert(orderId, orderText, amount, kitchenPhone) {
  if (TEST_MODE) return;
  const cleanPhone = kitchenPhone.replace(/\D/g, '');
  
  // Meta Interactive Button payload
  const payload = {
    messaging_product: "whatsapp",
    to: cleanPhone,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: `🚨 *ACTION REQUIRED*\n\n${orderText.slice(0, 950)}` }, // Body limit is 1024 chars
      action: {
        buttons: [
          { type: "reply", reply: { id: `ACCEPT_${orderId}`, title: "✅ Accept" } },
          { type: "reply", reply: { id: `REJECT_${orderId}`, title: "❌ Reject" } }
        ]
      }
    }
  };

  try {
    await axios.post(`https://graph.facebook.com/v20.0/${metaPhoneId}/messages`, payload, {
      headers: { 'Authorization': `Bearer ${metaToken}`, 'Content-Type': 'application/json' }
    });
  } catch (e) { console.error('Kitchen Alert Error:', e.response?.data || e.message); }
}

// ─── CORE MENU FORMATTERS ───────────────────────

async function getMenuItems(restaurantId) {
  try {
    const { rows } = await pool.query('SELECT * FROM menu_items WHERE restaurant_id = $1 ORDER BY category, name', [restaurantId]);
    return rows.length > 0 && 'available' in rows[0] ? rows.filter(r => r.available) : rows;
  } catch (e) { return []; }
}

function formatMenu(items, restaurantName) {
  const grouped = {}; items.forEach(i => { (grouped[i.category] = grouped[i.category] || []).push(i); });
  let m = `*${restaurantName}* - Menu\n\n`;
  Object.keys(grouped).sort().forEach(cat => {
    m += `*${cat.toUpperCase()}*\n`;
    grouped[cat].forEach(i => { m += `${i.is_vegetarian ? '🟢' : '🔴'} ${i.id}. ${i.name} - Rs.${i.price}\n`; });
    m += '\n';
  });
  m += '*To order:*\nType item ID and quantity (e.g., "15 2")\nType "done" when finished\nType "cart" to view cart';
  return m;
}

function formatCart(cart, deliveryFee = 0) {
  if (!cart || !cart.length) return 'Your cart is empty';
  let m = '*Your Cart:*\n\n', sub = 0;
  cart.forEach((item, i) => { const t = item.price * item.quantity; sub += t; m += `${i+1}. ${item.name}\n  Qty: ${item.quantity} x Rs.${item.price} = Rs.${t}\n\n`; });
  return deliveryFee > 0 ? `${m}Subtotal: Rs.${sub}\nDelivery Fee: Rs.${deliveryFee}\n*Total: Rs.${sub + deliveryFee}*` : `${m}Subtotal: Rs.${sub}\n*Total: Rs.${sub}*`;
}

async function saveOrder(session) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      "INSERT INTO orders (restaurant_id, customer_phone, delivery_address, special_instructions, total_amount, status, payment_status, payment_method, payment_gateway, gateway_transaction_id, gateway_order_id, created_at, confirmed_at) VALUES ($1,$2,$3,$4,$5,'CONFIRMED',$6,$7,$8,$9,$10,NOW(),NOW()) RETURNING id",
      [session.restaurantId, session.phone, session.deliveryAddress, session.specialInstructions || '', session.total, session.paymentMethod === 'online' || session.paymentMethod === 'upi_direct' ? 'PAID' : 'COD', session.paymentMethod, session.paymentGateway || 'cod', session.paymentTransactionId || null, session.gatewayOrderId || null]
    );
    const orderId = rows[0].id;
    for (const item of session.cart) {
      await client.query('INSERT INTO order_items (order_id, menu_item_id, quantity, price, subtotal) VALUES ($1,$2,$3,$4,$5)', [orderId, item.id, item.quantity, item.price, item.price * item.quantity]);
    }
    await client.query('COMMIT');
    
    // Stats Update
    const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    if (serverStats.lastResetDate !== today) { serverStats.totalOrdersToday = 1; serverStats.lastResetDate = today; } else { serverStats.totalOrdersToday++; }
    serverStats.lastOrderTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    return orderId;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function notifyOwner(session, orderId) {
  try {
    const { rows } = await pool.query('SELECT whatsapp_number, notify_on_order FROM restaurants WHERE id=$1', [session.restaurantId]);
    if (!rows[0] || rows[0].notify_on_order === false || !rows[0].whatsapp_number) return;
    
    const ownerWA = rows[0].whatsapp_number;
    const payLabel = session.paymentMethod === 'online' || session.paymentMethod === 'upi_direct' ? `ONLINE PAID (${session.paymentGateway.toUpperCase()})` : 'CASH ON DELIVERY';
    const typeStr = session.orderType === 'takeaway' ? 'TAKEAWAY (Self Pickup)' : `DELIVERY\nAddress: ${session.deliveryAddress}`;
    
    let m = `NEW ORDER #${orderId}\n\n${session.restaurantName}\nCustomer: ${session.phone}\n${typeStr}\n\nItems:\n`;
    session.cart.forEach(i => { m += `${i.quantity}x ${i.name} - Rs.${i.price * i.quantity}\n`; });
    m += `\nTotal: Rs.${session.total}\n${payLabel}`;
    if (session.specialInstructions && session.specialInstructions.toLowerCase() !== 'no') m += `\nNote: ${session.specialInstructions}`;
    
    await sendKitchenAlert(orderId, m, session.total, ownerWA);
  } catch (e) { console.error('notifyOwner:', e.message); }
}

function buildOrderConfirmation(session, orderId) {
  const cart = session.cart.map((item, i) => `${i+1}. ${item.name} x${item.quantity} = Rs.${item.price * item.quantity}`).join('\n');
  const pay = session.paymentMethod === 'online' || session.paymentMethod === 'upi_direct' ? `Online Paid (${session.paymentGateway})` : 'Cash on Delivery';
  const typeStr = session.orderType === 'takeaway' ? 'Type: Takeaway (Self Pickup)\n\n' : `Address: ${session.deliveryAddress}\n\n`;
  const expectedStr = session.orderType === 'takeaway' ? '~20 min for pickup. Thank you!' : '~45 min delivery. Thank you!';
  let feeStr = session.orderType === 'takeaway' ? '' : ` | Delivery: Rs.${session.deliveryFee}`;

  return `*Order Confirmed! #${orderId}*\n\n${session.restaurantName}\n\n*Items:*\n${cart}\n\nSubtotal: Rs.${session.subtotal}${feeStr}\n*Total: Rs.${session.total}*\n\n${typeStr}${pay}\n\n${expectedStr}`;
}

// ─── META WEBHOOK HANDLERS ────────────────────────

// 1. Meta Webhook Verification Handshake
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('✅ Meta Webhook Verified!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2. Incoming Messages Webhook (Meta Cloud API)
app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED'); // Always acknowledge Meta instantly

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];

    if (!message) return; // Ignore status receipts

    const phone = message.from; 
    let text = '';

    // Handle Plain Text
    if (message.type === 'text') {
      text = message.text.body.trim();
    } 
    // Handle Interactive Button Click (from Kitchen)
    else if (message.type === 'interactive') {
      const btnId = message.interactive.button_reply?.id;
      
      // ADMIN INTERCEPT: If kitchen clicked Accept/Reject
      if (btnId && (btnId.startsWith('ACCEPT_') || btnId.startsWith('REJECT_'))) {
        const [action, orderId] = btnId.split('_');
        const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
        
        if (rows.length > 0) {
            const order = rows[0];
            if (action === 'ACCEPT') {
                await pool.query("UPDATE orders SET status = 'PREPARING' WHERE id = $1", [orderId]);
                await sendMessage(order.customer_phone, `✅ Your order #${orderId} has been accepted by the kitchen and is being prepared!`);
            } else if (action === 'REJECT') {
                await pool.query("UPDATE orders SET status = 'CANCELLED' WHERE id = $1", [orderId]);
                // Trigger Auto-Refund if Paid
                if (order.payment_status === 'PAID' && order.gateway_transaction_id) {
                    await refundPhonePePayment(order.gateway_transaction_id, order.total_amount);
                    await sendMessage(order.customer_phone, `❌ Sorry, the kitchen is out of stock. Your order #${orderId} was cancelled. A refund of ₹${order.total_amount} has been initiated to your UPI account.`);
                } else {
                    await sendMessage(order.customer_phone, `❌ Sorry, the kitchen is out of stock. Your order #${orderId} was cancelled.`);
                }
            }
        }
        return; // Stop processing further state machine logic
      }
      text = btnId; // Normal list/button flow fallthrough
    }

    if (!text) return;
    const upper = text.toUpperCase();
    console.log(`\n[${phone}] -> "${text}"`);
    
    await loadRestaurants();

    const restaurant = restaurantCache.find(r => r.qr_keyword && upper.includes(r.qr_keyword.toUpperCase()));
    if (restaurant) {
      if (sessions.get(phone)?.confirmTimeout) clearTimeout(sessions.get(phone).confirmTimeout);
      if (pendingPayments.has(phone)) { clearTimeout(pendingPayments.get(phone)); pendingPayments.delete(phone); }
      
      sessions.set(phone, { 
        phone, state: S.SELECT_SERVICE, restaurantId: restaurant.id, restaurantName: restaurant.name, 
        deliveryFee: restaurant.delivery_fee || 30, minOrder: restaurant.min_delivery_amount || 0, 
        canDeliver: restaurant.delivery_available !== false, canBook: restaurant.table_booking_available !== false, 
        takeawayConditional: restaurant.takeaway_conditional === true, createdAt: Date.now() 
      });
      
      let options = '', idx = 0;
      if (restaurant.delivery_available !== false) { idx++; options += `${idx}. Order Food\n`; }
      if (restaurant.table_booking_available !== false) { idx++; options += `${idx}. Book a Table\n`; }
      await sendMessage(phone, `Welcome to *${restaurant.name}*!\n\nWhat would you like to do?\n\n${options}\nReply with ${idx === 1 ? '1' : '1 or 2'}`);
      return;
    }

    let session = sessions.get(phone);
    if (!session) {
      const isGreeting = ['hi','hello','hey','start','menu','help'].some(w => text.toLowerCase().includes(w));
      await sendMessage(phone, isGreeting ? '*Welcome!*\n\nScan the QR code to start ordering!' : 'Scan the QR code to start ordering!');
      return;
    }

    if (session.state === S.SELECT_SERVICE) {
      let action = null;
      if (session.canDeliver && session.canBook) { if (text === '1') action = 'delivery'; if (text === '2') action = 'booking'; }
      else if (session.canDeliver) { if (text === '1') action = 'delivery'; }
      else if (session.canBook) { if (text === '1') action = 'booking'; }
      
      if (action === 'delivery') {
        session.state = S.BROWSE_MENU; session.serviceType = 'delivery'; session.cart = [];
        session.menuItems = await getMenuItems(session.restaurantId);
        sessions.set(phone, session);
        await sendMessage(phone, formatMenu(session.menuItems, session.restaurantName));
        return;
      }
      if (action === 'booking') {
        session.state = S.BOOKING_NAME; session.serviceType = 'booking';
        sessions.set(phone, session);
        await sendMessage(phone, "What's your name?\n\nPlease enter your full name for the booking.");
        return;
      }
      await sendMessage(phone, 'Invalid choice.\nPlease reply with a valid number.');
      return;
    }

    if (session.state === S.BROWSE_MENU) {
      if (upper === 'CART') { await sendMessage(phone, session.cart.length ? formatCart(session.cart, session.deliveryFee) : 'Cart is empty.\n\nAdd items: item_id quantity'); return; }
      if (upper === 'DONE') {
        if (!session.cart.length) { await sendMessage(phone, 'Cart is empty. Add items first!'); return; }
        const sub = session.cart.reduce((s,i) => s + i.price * i.quantity, 0);
        session.subtotal = sub;
        
        // CONDITIONAL TAKEAWAY LOGIC
        if (session.takeawayConditional) {
            if (sub > 500) {
                session.state = S.CHOOSE_ORDER_TYPE; sessions.set(phone, session);
                await sendMessage(phone, formatCart(session.cart, session.deliveryFee) + '\n\n*Great! Your order qualifies for Delivery!*\n\nHow would you like to receive your food?\n1. Delivery\n2. Takeaway (Self Pickup)\n\nReply with 1 or 2');
                return;
            } else {
                session.orderType = 'takeaway'; session.deliveryFee = 0; session.total = sub; session.deliveryAddress = 'Self Pickup'; session.state = S.ADD_INSTRUCTIONS; sessions.set(phone, session);
                await sendMessage(phone, formatCart(session.cart, 0) + '\n\n*Note:* Orders below Rs.500 are Takeaway only. Proceeding with Self Pickup.\n\nAny special instructions for the chef? (Type "no" if none)');
                return;
            }
        } else {
            if (sub < session.minOrder) { await sendMessage(phone, `Minimum order: Rs.${session.minOrder}\nCurrent: Rs.${sub}`); return; }
            session.total = Number(sub) + Number(session.deliveryFee); session.orderType = 'delivery'; session.state = S.ADD_ADDRESS; sessions.set(phone, session);
            await sendMessage(phone, formatCart(session.cart, session.deliveryFee) + '\n\nPlease enter your delivery address:');
            return;
        }
      }
      
      const match = text.match(/^(\d+)\s+(\d+)$/);
      if (match) {
        const id = parseInt(match[1]), qty = parseInt(match[2]);
        const item = session.menuItems.find(m => m.id === id);
        if (!item) { await sendMessage(phone, `Item #${id} not found.`); return; }
        if (qty < 1 || qty > 99) { await sendMessage(phone, 'Qty must be 1-99'); return; }
        const ex = session.cart.find(c => c.id === id);
        if (ex) ex.quantity += qty; else session.cart.push({ id: item.id, name: item.name, price: item.price, quantity: qty });
        sessions.set(phone, session);
        await sendMessage(phone, `Added to cart!\n\n${formatCart(session.cart, session.deliveryFee)}\n\nAdd more items or type "done" to proceed.`);
        return;
      }
      await sendMessage(phone, 'Use: item_id quantity (e.g., "15 2")');
      return;
    }

    if (session.state === S.CHOOSE_ORDER_TYPE) {
      if (text === '1') {
          session.orderType = 'delivery'; session.total = Number(session.subtotal) + Number(session.deliveryFee); session.state = S.ADD_ADDRESS; sessions.set(phone, session);
          await sendMessage(phone, 'Delivery Selected.\n\nPlease enter your full delivery address:');
          return;
      } else if (text === '2') {
          session.orderType = 'takeaway'; session.deliveryFee = 0; session.total = session.subtotal; session.deliveryAddress = 'Self Pickup'; session.state = S.ADD_INSTRUCTIONS; sessions.set(phone, session);
          await sendMessage(phone, 'Takeaway Selected.\n\nAny special instructions for the chef? (Type "no" if none)');
          return;
      }
      await sendMessage(phone, 'Invalid choice.\n\nReply *1* for Delivery or *2* for Takeaway.');
      return;
    }

    if (session.state === S.ADD_ADDRESS) {
      session.deliveryAddress = text; session.state = S.ADD_INSTRUCTIONS; sessions.set(phone, session);
      await sendMessage(phone, 'Address saved!\n\nAny special instructions? (Type "no" if none)');
      return;
    }

    if (session.state === S.ADD_INSTRUCTIONS) {
      session.specialInstructions = text; session.state = S.CHOOSE_PAYMENT; sessions.set(phone, session);
      const lines = session.cart.map(i => `  ${i.quantity}x ${i.name} - Rs.${i.price * i.quantity}`).join('\n');
      const typeStr = session.orderType === 'takeaway' ? 'Self Pickup (Takeaway)' : `Delivery: ${session.deliveryAddress}`;
      let feeStr = session.orderType === 'takeaway' ? '' : `\nDelivery Fee: Rs.${session.deliveryFee}`;

      await sendMessage(phone, `*Choose Payment Method*\n\n*Your Order:*\n${lines}\n\nSubtotal: Rs.${session.subtotal}${feeStr}\n*Total: Rs.${session.total}*\n\n${typeStr}\n\nSelect payment method:\n\n*Pay via UPI (Click & Pay):*\n1. PhonePe\n2. Google Pay\n3. Paytm\n4. Any UPI App\n\n*Cash Payment:*\n5. Cash on Delivery (COD)\n\nReply with *1*, *2*, *3*, *4*, or *5*`);
      return;
    }

    if (session.state === S.CHOOSE_PAYMENT) {
      if (['1', '2', '3', '4'].includes(text)) {
        const upiIds = await getRestaurantUPIIds(session.restaurantId);
        let method = null, upiId = '', methodName = '';
        if (text === '1') { method = 'phonepe'; upiId = upiIds.phonepe; methodName = 'PhonePe'; }
        else if (text === '2') { method = 'gpay'; upiId = upiIds.gpay; methodName = 'Google Pay'; }
        else if (text === '3') { method = 'paytm'; upiId = upiIds.paytm; methodName = 'Paytm'; }
        else if (text === '4') { method = 'upi'; upiId = upiIds.generic; methodName = 'UPI App'; }
        
        session.paymentMethod = 'upi_direct'; session.paymentGateway = method; session.upiIdUsed = upiId;
        session.state = S.AWAITING_PAYMENT;
        sessions.set(phone, session);

        let paymentUrl = '';
        if (method === 'phonepe') {
            const orderData = { amount: session.total, phone: session.phone, restaurantName: session.restaurantName };
            const pgResponse = await createPayment('phonepe', orderData);
            if (pgResponse.success) {
                paymentUrl = pgResponse.paymentUrl;
                session.paymentId = pgResponse.paymentId; 
                sessions.set(phone, session);
            } else {
                await sendMessage(phone, '⚠️ Payment gateway is temporarily down. Please type *5* for Cash on Delivery.');
                session.state = S.CHOOSE_PAYMENT; sessions.set(phone, session); return;
            }
        } else {
            const tempOrderId = 'OD' + Date.now().toString().slice(-8);
            session.paymentId = tempOrderId; sessions.set(phone, session);
            paymentUrl = `${process.env.BASE_URL}/pay/${session.restaurantId}/${tempOrderId}?amount=${session.total}&upiId=${encodeURIComponent(upiId)}&name=${encodeURIComponent(session.restaurantName)}&method=${method}`;
        }
        
        await sendMessage(phone, `*${methodName} Payment*\n\nAmount: Rs.${session.total}\nName: ${session.restaurantName}\n\n*Click to Pay:*\n${paymentUrl}\n\n*Steps:*\n1. Click the link above\n2. Complete payment\n3. Return here and type *PAID*\n\nOr type *CANCEL* to cancel order`);
        
        pendingPayments.set(phone, setTimeout(async () => {
          if (sessions.get(phone)?.state === S.AWAITING_PAYMENT) { sessions.delete(phone); await sendMessage(phone, 'Payment timeout. Type restaurant name to start over.'); }
        }, 900000));
        return;
      }
      if (text === '5') {
        session.paymentMethod = 'cod'; session.paymentGateway = 'cod'; session.state = S.CONFIRM_ORDER;
        session.confirmTimeout = setTimeout(async () => {
          if (sessions.get(phone)?.state === S.CONFIRM_ORDER) { sessions.delete(phone); await sendMessage(phone, 'Confirmation timeout. Start over.'); }
        }, 600000);
        sessions.set(phone, session);
        const lines = session.cart.map(i => `${i.quantity}x ${i.name} - Rs.${i.price * i.quantity}`).join('\n');
        const typeStr = session.orderType === 'takeaway' ? 'Self Pickup (Takeaway)' : `Delivery: ${session.deliveryAddress}`;
        await sendMessage(phone, `*CONFIRM YOUR ORDER*\n\n${session.restaurantName}\n\n*Your Order:*\n${lines}\n\nTotal: Rs.${session.total}\n${typeStr}\n\n*PAYMENT: CASH / PAY AT DESK*\n\nType *CONFIRM* to place order\nType *CANCEL* to cancel`);
        return;
      }
      await sendMessage(phone, 'Invalid choice.\n\nReply *1*, *2*, *3*, *4*, or *5*');
      return;
    }

    if (session.state === S.AWAITING_PAYMENT) {
      if (upper === 'PAID') {
        session.state = S.CONFIRM_ORDER; session.awaitingTransactionId = true; sessions.set(phone, session);
        await sendMessage(phone, 'Great! Please enter your *Transaction ID*\n(Usually 10-12 digit number from payment app)');
        return;
      }
      if (session.awaitingTransactionId) {
        const txnId = text.trim();
        if (txnId.length >= 10 && /^[0-9A-Za-z]+$/.test(txnId)) {
          session.paymentTransactionId = txnId; session.paymentMethod = 'upi_direct'; session.state = S.CONFIRM_ORDER; delete session.awaitingTransactionId;
          const t = pendingPayments.get(phone); if (t) clearTimeout(t); pendingPayments.delete(phone); sessions.set(phone, session);
          const lines = session.cart.map(i => `${i.quantity}x ${i.name} - Rs.${i.price * i.quantity}`).join('\n');
          const typeStr = session.orderType === 'takeaway' ? 'Self Pickup (Takeaway)' : `Delivery: ${session.deliveryAddress}`;
          await sendMessage(phone, `Transaction ID recorded: ${txnId}\n\n*CONFIRM YOUR ORDER*\n\n${session.restaurantName}\n\n*Your Order:*\n${lines}\n\nTotal: Rs.${session.total}\n${typeStr}\n\nType *CONFIRM* to place order\nType *CANCEL* to cancel`);
          return;
        }
        await sendMessage(phone, 'Invalid transaction ID format\n\nPlease enter a valid Transaction ID (10+ characters)');
        return;
      }
      if (upper === 'CANCEL') {
        const t = pendingPayments.get(phone); if (t) clearTimeout(t); pendingPayments.delete(phone); sessions.delete(phone);
        await sendMessage(phone, 'Order cancelled. Type restaurant name to start over.'); return;
      }
      await sendMessage(phone, 'Type *PAID* after making payment or *CANCEL* to cancel.');
      return;
    }

    if (session.state === S.CONFIRM_ORDER) {
      if (upper === 'CONFIRM') {
        if (session.confirmTimeout) clearTimeout(session.confirmTimeout);
        const orderId = await saveOrder(session);
        await notifyOwner(session, orderId);
        sessions.delete(phone);
        await sendMessage(phone, buildOrderConfirmation(session, orderId));
        return;
      }
      if (upper === 'CANCEL') { if (session.confirmTimeout) clearTimeout(session.confirmTimeout); sessions.delete(phone); await sendMessage(phone, 'Order cancelled.'); return; }
      await sendMessage(phone, 'Type *CONFIRM* or *CANCEL*');
      return;
    }

    await sendMessage(phone, 'Something went wrong. Type restaurant name to restart.');
    return;

  } catch (e) { console.error('Webhook Error:', e.message); }
});

// ════════════════════════════════════════════
// SECURE PHONEPE PAYMENT WEBHOOK
// ════════════════════════════════════════════

app.post('/payment/phonepe/webhook', async (req, res) => {
  res.status(200).send('OK'); // Always ACK early

  try {
    const base64Response = req.body.response;
    const checksumHeader = req.headers['x-verify'];
    const saltKey = process.env.PHONEPE_SALT_KEY;
    const saltIndex = process.env.PHONEPE_SALT_INDEX || '1';

    if (!base64Response || !checksumHeader) return;

    const expectedChecksum = crypto.createHash('sha256').update(base64Response + saltKey).digest('hex') + '###' + saltIndex;
    if (checksumHeader !== expectedChecksum) return console.error('PhonePe Webhook: Invalid Signature');

    const decodedResponse = Buffer.from(base64Response, 'base64').toString('utf-8');
    const data = JSON.parse(decodedResponse);

    if (data.success && data.code === 'PAYMENT_SUCCESS') {
      const merchantTransactionId = data.data.merchantTransactionId;
      
      let phone = null;
      for (const [p, s] of sessions) { 
          if (s.paymentId === merchantTransactionId) { phone = p; break; } 
      }

      if (phone) {
        const session = sessions.get(phone);
        session.paymentTransactionId = data.data.transactionId;
        
        const t = pendingPayments.get(phone); 
        if (t) clearTimeout(t); 
        pendingPayments.delete(phone);
        
        const orderId = await saveOrder(session); 
        await notifyOwner(session, orderId); 
        
        await sendMessage(phone, '✅ *Payment Received!*\n\n' + buildOrderConfirmation(session, orderId)); 
        sessions.delete(phone);
      }
    }
  } catch (e) { console.error('PhonePe webhook error:', e.message); }
});

// GET Callbacks for Payment Success Rendering
app.get('/pay/:restaurantId/:bookingId', (req, res) => res.send('Fallback Link Rendering Endpoint'));
app.get('/payment/phonepe/callback', (req, res) => res.send('<!DOCTYPE html><html><head><title>Payment Success</title></head><body style="text-align:center;padding:50px;"><h1>✅ Payment Success</h1><p>Please return to WhatsApp.</p></body></html>'));

// ─── HEALTH ENDPOINT ─────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    res.json({
      status: 'OK', uptime: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`,
      stats: { ordersToday: serverStats.totalOrdersToday, activeSessions: sessions.size },
      system: { version: '7.0.0-META-CLOUD', nodeEnv: NODE_ENV }
    });
  } catch (e) { res.status(503).json({ status: 'ERROR', error: e.message }); }
});

process.on('uncaughtException', e => console.error('Uncaught:', e));
process.on('unhandledRejection', e => console.error('Unhandled:', e));
process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
process.on('SIGINT',  async () => { await pool.end(); process.exit(0); });

async function startServer() {
  try {
    await connectDatabase();
    await loadRestaurants();
    app.listen(PORT, () => {
      console.log('\n╔══════════════════════════════════════════╗');
      console.log('║  RESTAURANT WHATSAPP BOT v7.0            ║');
      console.log('║  ✅ Meta Cloud API Edition               ║');
      console.log('║  ✅ 100% Twilio-Free                     ║');
      console.log('║  ✅ PhonePe Webhook Integration          ║');
      console.log('╚══════════════════════════════════════════╝\n');
    });
  } catch (e) { console.error('Startup failed:', e); process.exit(1); }
}

startServer();
