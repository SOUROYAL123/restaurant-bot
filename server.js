// ============================================
// RESTAURANT WHATSAPP BOT v6.6 - LEGACYLENS EDITION
// ✅ FIX: sendMessage splits messages > 1500 chars
// ✅ FIX: buildOrderConfirmation trimmed
// ✅ FEATURE: /health endpoint now shows Uptime & Memory
// ✅ FEATURE: Daily Order Counter (Resets at Midnight)
// ✅ FEATURE: Conditional Takeaway Toggle (< Rs.500 = Takeaway)
// ============================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { Pool } = require('pg');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const TEST_MODE = process.env.TEST_MODE === 'true';

// ─── STARTUP STATS (For /health) ────────────────
const startTime = Date.now();
const serverStats = {
  totalOrdersToday: 0,
  lastOrderTime: null,
  lastResetDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
};
// ────────────────────────────────────────────────

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.set('trust proxy', true);

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const wabaNumber = process.env.WABA_NUMBER;

let twilioClient = null;
if (!TEST_MODE) {
  if (!accountSid || !authToken || !wabaNumber) {
    console.error('FATAL: Missing Twilio credentials in .env');
    process.exit(1);
  }
  twilioClient = twilio(accountSid, authToken);
} else {
  console.log('TEST MODE ON - Twilio calls mocked');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false, require: true },
  connectionTimeoutMillis: 10000,
  max: 10, min: 0, idleTimeoutMillis: 5000, statement_timeout: 30000
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
      console.log('Database connected (attempt ' + i + ')');
      return;
    } catch (e) {
      console.error('Attempt ' + i + '/' + retries + ':', e.message);
      if (i < retries) await new Promise(r => setTimeout(r, Math.min(1000 * (2 ** i), 10000)));
    }
  }
  console.error('FATAL: DB connection failed');
  process.exit(1);
}

const sessions        = new Map();
const pendingPayments = new Map();
const testMessages    = new Map();

// Session Cleanup (Every 5 mins)
setInterval(() => {
  const now = Date.now();
  for (const [phone, s] of sessions) {
    if (now - s.createdAt > 1800000) { // 30 mins
      if (s.confirmTimeout) clearTimeout(s.confirmTimeout);
      sessions.delete(phone);
    }
  }
}, 300000);

let restaurantCache = [], lastCacheUpdate = 0;
const CACHE_TTL = 300000;

const S = {
  SELECT_SERVICE: 'SELECT_SERVICE',
  BROWSE_MENU: 'BROWSE_MENU',
  CHOOSE_ORDER_TYPE: 'CHOOSE_ORDER_TYPE', // NEW: For Takeaway vs Delivery
  ADD_ADDRESS: 'ADD_ADDRESS',
  ADD_INSTRUCTIONS: 'ADD_INSTRUCTIONS',
  CHOOSE_PAYMENT: 'CHOOSE_PAYMENT',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  CONFIRM_ORDER: 'CONFIRM_ORDER',
  BOOKING_NAME: 'BOOKING_NAME',
  BOOKING_DATE: 'BOOKING_DATE',
  BOOKING_TIME: 'BOOKING_TIME',
  BOOKING_GUESTS: 'BOOKING_GUESTS',
  BOOKING_SELECT_PAYMENT_METHOD: 'BOOKING_SELECT_PAYMENT_METHOD',
  BOOKING_PAYMENT: 'BOOKING_PAYMENT',
  BOOKING_VERIFY_PAYMENT: 'BOOKING_VERIFY_PAYMENT',
  BOOKING_CONFIRM: 'BOOKING_CONFIRM'
};

async function loadRestaurants(force = false) {
  if (!force && restaurantCache.length && (Date.now() - lastCacheUpdate) < CACHE_TTL)
    return restaurantCache;
  try {
    const { rows } = await pool.query('SELECT * FROM restaurants ORDER BY name');
    const hasActive = rows.length > 0 && 'active' in rows[0];
    restaurantCache = hasActive ? rows.filter(r => r.active) : rows;
    lastCacheUpdate = Date.now();
    if (rows.length > 0) console.log('Cached ' + restaurantCache.length + ' restaurants');
    return restaurantCache;
  } catch (e) {
    console.error('loadRestaurants:', e.message);
    return restaurantCache;
  }
}

async function getRestaurantUPIIds(restaurantId) {
  const DEFAULT_UPI_IDS = {
    phonepe: '7980407413@ibl',
    gpay: 'soumation24-1@oksbi',
    paytm: '7980407413@paytm',
    generic: '7980407413@ibl'
  };
  try {
    const { rows } = await pool.query(
      'SELECT phonepe_upi_id, gpay_upi_id, paytm_upi_id, generic_upi_id, name FROM restaurants WHERE id = $1 AND active = true',
      [restaurantId]
    );
    if (rows.length === 0) return DEFAULT_UPI_IDS;
    const r = rows[0];
    return {
      phonepe: r.phonepe_upi_id || DEFAULT_UPI_IDS.phonepe,
      gpay:    r.gpay_upi_id    || DEFAULT_UPI_IDS.gpay,
      paytm:   r.paytm_upi_id   || DEFAULT_UPI_IDS.paytm,
      generic: r.generic_upi_id || DEFAULT_UPI_IDS.generic
    };
  } catch (error) {
    console.error('Error fetching UPI IDs:', error.message);
    return DEFAULT_UPI_IDS;
  }
}

// ─── ENDPOINTS ──────────────────────────────────

app.get('/pay/:restaurantId/:bookingId', (req, res) => {
  const { restaurantId, bookingId } = req.params;
  const { amount, upiId, name, method } = req.query;
  const upiParams = 'pa=' + upiId + '&pn=' + encodeURIComponent(name) + '&am=' + amount + '&cu=INR&tn=Payment-' + bookingId;
  const packages = { phonepe: 'com.phonepe.app', gpay: 'com.google.android.apps.nbu.paisa.user', paytm: 'net.one97.paytm' };
  const packageName = packages[method] || packages.phonepe;
  const androidIntentUrl = 'intent://pay?' + upiParams + '#Intent;scheme=upi;package=' + packageName + ';end';
  const genericUpiUrl = 'upi://pay?' + upiParams;
  const methodName = method === 'phonepe' ? 'PhonePe' : method === 'gpay' ? 'Google Pay' : method === 'paytm' ? 'Paytm' : 'UPI App';

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Payment</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.container{background:white;border-radius:20px;padding:40px 30px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3);text-align:center}.icon{font-size:60px;margin-bottom:20px}h1{color:#333;font-size:24px;margin-bottom:10px}.amount{font-size:42px;font-weight:bold;color:#667eea;margin:20px 0}.details{background:#f5f5f5;padding:15px;border-radius:10px;margin:20px 0;text-align:left}.details p{margin:8px 0;color:#666;font-size:14px}.details strong{color:#333}.btn{display:block;width:100%;padding:15px;background:linear-gradient(135deg,#667eea,#764ba2);color:white;text-decoration:none;border-radius:10px;font-size:18px;font-weight:600;margin:10px 0;border:none;cursor:pointer}.btn.secondary{background:#6c757d;font-size:16px;padding:12px}.manual{margin-top:20px;padding-top:20px;border-top:1px solid #ddd}.upi-id{background:#f9f9f9;padding:12px;border-radius:8px;font-family:monospace;font-size:16px;margin:10px 0;word-break:break-all;color:#333;font-weight:600}.copy-btn{background:#28a745;font-size:14px;padding:10px 20px}.instructions{color:#666;font-size:13px;margin-top:20px;padding:15px;background:#fff3cd;border-radius:8px;text-align:left}.instructions strong{color:#856404}.status{margin:15px 0;padding:10px;border-radius:8px;font-size:14px}.status.success{background:#d4edda;color:#155724}.status.warning{background:#fff3cd;color:#856404}</style></head>
<body><div class="container"><div class="icon">&#x1F4B3;</div><h1>${name}</h1><div class="amount">&#x20B9;${amount}</div>
<div class="details"><p><strong>Order/Booking ID:</strong> ${bookingId}</p><p><strong>UPI ID:</strong> ${upiId}</p><p><strong>Method:</strong> ${methodName}</p></div>
<div id="status"></div>
<button class="btn" onclick="openPaymentApp()">&#x1F680; Pay with ${methodName}</button>
<button class="btn secondary" onclick="openAnyUPI()">&#x1F4F1; Open Any UPI App</button>
<div class="manual"><p style="color:#666;margin-bottom:10px;font-size:14px"><strong>Or copy UPI ID manually:</strong></p>
<div class="upi-id" id="upiId">${upiId}</div>
<button class="btn copy-btn" onclick="copyUPI()">&#x1F4CB; Copy UPI ID</button></div>
<div class="instructions"><p><strong>&#x1F4F1; Steps:</strong></p><p>1. Click Pay button above</p><p>2. Complete payment of &#x20B9;${amount}</p><p>3. Return to WhatsApp</p><p>4. Type <strong>PAID</strong> to enter transaction ID</p></div>
</div>
<script>
const androidIntentUrl='${androidIntentUrl}';const genericUpiUrl='${genericUpiUrl}';const isAndroid=/Android/i.test(navigator.userAgent);
function showStatus(msg,type){const s=document.getElementById('status');s.className='status '+type;s.textContent=msg;s.style.display='block';}
function openPaymentApp(){showStatus('Opening ${methodName}...','success');window.location.href=isAndroid?androidIntentUrl:genericUpiUrl;setTimeout(()=>showStatus("If app didn't open, use 'Open Any UPI App' or copy UPI ID",'warning'),3000);}
function openAnyUPI(){showStatus('Opening UPI apps...','success');window.location.href=genericUpiUrl;setTimeout(()=>showStatus('Copy UPI ID manually and paste in any UPI app','warning'),3000);}
function copyUPI(){const t=document.getElementById('upiId').textContent;navigator.clipboard.writeText(t).then(()=>{event.target.innerHTML='&#x2705; Copied!';setTimeout(()=>event.target.innerHTML='&#x1F4CB; Copy UPI ID',2000);showStatus('UPI ID copied!','success');}).catch(()=>alert('UPI ID: '+t));}
setTimeout(()=>openPaymentApp(),2000);
</script></body></html>`);
});

// ─── CORE FUNCTIONS ─────────────────────────────

async function sendMessage(to, body) {
  const MAX_LENGTH = 1500;
  if (!testMessages.has(to)) testMessages.set(to, []);
  testMessages.get(to).push({ body, timestamp: Date.now() });

  if (TEST_MODE) {
    console.log('[TEST] -> ' + to);
    return { sid: 'test_' + Date.now() };
  }

  const chunks = [];
  if (body.length <= MAX_LENGTH) {
    chunks.push(body);
  } else {
    const lines = body.split('\n');
    let current = '';
    for (const line of lines) {
      const candidate = current ? current + '\n' + line : line;
      if (candidate.length > MAX_LENGTH) {
        if (current) chunks.push(current);
        current = line;
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);
  }

  let lastMsg;
  try {
    for (const chunk of chunks) {
      lastMsg = await twilioClient.messages.create({ from: wabaNumber, to: 'whatsapp:' + to, body: chunk });
      console.log('Sent -> ' + to + ': ' + lastMsg.sid + ' (' + chunk.length + ' chars)');
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
    }
    return lastMsg;
  } catch (e) {
    console.error('Send failed -> ' + to + ':', e.message);
    throw e;
  }
}

async function getMenuItems(restaurantId) {
  try {
    const { rows } = await pool.query('SELECT * FROM menu_items WHERE restaurant_id = $1 ORDER BY category, name', [restaurantId]);
    const hasAvailable = rows.length > 0 && 'available' in rows[0];
    return hasAvailable ? rows.filter(r => r.available) : rows;
  } catch (e) { console.error('getMenuItems:', e.message); return []; }
}

function formatMenu(items, restaurantName) {
  const grouped = {};
  items.forEach(i => { (grouped[i.category] = grouped[i.category] || []).push(i); });
  let m = '*' + restaurantName + '* - Menu\n\n';
  Object.keys(grouped).sort().forEach(cat => {
    m += '*' + cat.toUpperCase() + '*\n';
    grouped[cat].forEach(i => {
      m += (i.is_vegetarian ? '\uD83D\uDFE2' : '\uD83D\uDD34') + ' ' + i.id + '. ' + i.name + ' - Rs.' + i.price + '\n';
      if (i.description) m += '    ' + i.description + '\n';
    });
    m += '\n';
  });
  m += '*To order:*\nType item ID and quantity (e.g., "15 2")\nType "done" when finished\nType "cart" to view cart';
  return m;
}

function formatCart(cart, deliveryFee = 0) {
  if (!cart || !cart.length) return 'Your cart is empty';
  let m = '*Your Cart:*\n\n', sub = 0;
  cart.forEach((item, i) => { const t = item.price * item.quantity; sub += t; m += (i+1) + '. ' + item.name + '\n  Qty: ' + item.quantity + ' x Rs.' + item.price + ' = Rs.' + t + '\n\n'; });
  
  if (deliveryFee > 0) {
    m += 'Subtotal: Rs.' + sub + '\nDelivery Fee: Rs.' + deliveryFee + '\n*Total: Rs.' + (Number(sub) + Number(deliveryFee)) + '*';
  } else {
    m += 'Subtotal: Rs.' + sub + '\n*Total: Rs.' + sub + '*';
  }
  return m;
}

async function saveOrder(session) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      "INSERT INTO orders (restaurant_id, customer_phone, delivery_address, special_instructions, total_amount, status, payment_status, payment_method, payment_gateway, gateway_transaction_id, gateway_order_id, created_at, confirmed_at) VALUES ($1,$2,$3,$4,$5,'CONFIRMED',$6,$7,$8,$9,$10,NOW(),NOW()) RETURNING id",
      [session.restaurantId, session.phone, session.deliveryAddress, session.specialInstructions || '', session.total,
       session.paymentMethod === 'online' || session.paymentMethod === 'upi_direct' ? 'PAID' : 'COD',
       session.paymentMethod, session.paymentGateway || 'cod', session.paymentTransactionId || null, session.gatewayOrderId || null]
    );
    const orderId = rows[0].id;
    if (session.upiIdUsed) console.log('Order #' + orderId + ' - UPI ID used: ' + session.upiIdUsed);
    for (const item of session.cart) {
      await client.query('INSERT INTO order_items (order_id, menu_item_id, quantity, price, subtotal) VALUES ($1,$2,$3,$4,$5)', [orderId, item.id, item.quantity, item.price, item.price * item.quantity]);
    }
    await client.query('COMMIT');
    console.log('Order #' + orderId + ' saved (' + session.paymentGateway + ')');

    // ─── STATS UPDATE ───
    const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    if (serverStats.lastResetDate !== today) {
      serverStats.totalOrdersToday = 1; // New day, reset count
      serverStats.lastResetDate = today;
    } else {
      serverStats.totalOrdersToday++;
    }
    serverStats.lastOrderTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    // ────────────────────

    return orderId;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function notifyOwner(session, orderId) {
  try {
    const { rows } = await pool.query('SELECT whatsapp_number, notify_on_order FROM restaurants WHERE id=$1', [session.restaurantId]);
    if (!rows[0] || rows[0].notify_on_order === false) return;
    const ownerWA = rows[0].whatsapp_number;
    if (!ownerWA) return;
    
    const gatewayName = session.paymentGateway === 'razorpay' ? 'Razorpay' : session.paymentGateway === 'phonepe' ? 'PhonePe' : session.paymentGateway === 'paytm' ? 'Paytm' : 'COD';
    const payLabel = session.paymentMethod === 'online' || session.paymentMethod === 'upi_direct' ? 'ONLINE PAID (' + gatewayName + ')' : 'CASH ON DELIVERY';
    
    const typeStr = session.orderType === 'takeaway' ? 'TAKEAWAY (Self Pickup)' : 'DELIVERY\nAddress: ' + session.deliveryAddress;
    
    let m = 'NEW ORDER #' + orderId + '\n\n' + session.restaurantName + '\nCustomer: ' + session.phone + '\n' + typeStr + '\n\nItems:\n';
    session.cart.forEach(i => { m += i.quantity + 'x ' + i.name + ' - Rs.' + (i.price * i.quantity) + '\n'; });
    m += '\nTotal: Rs.' + session.total + '\n' + payLabel;
    
    if (session.upiIdUsed) m += '\nUPI: ' + session.upiIdUsed;
    if (session.specialInstructions && session.specialInstructions.toLowerCase() !== 'no') m += '\nNote: ' + session.specialInstructions;
    m += '\n' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    
    await sendMessage(ownerWA, m);
    console.log('Owner notified at ' + ownerWA);
  } catch (e) { console.error('notifyOwner:', e.message); }
}

async function logOrderToGoogleSheets(session, orderId) {
  try {
    if (!process.env.GOOGLE_APPS_SCRIPT_URL || !process.env.GOOGLE_APPS_SCRIPT_SECRET) return;
    const orderData = {
      type: 'order', secret: process.env.GOOGLE_APPS_SCRIPT_SECRET, orderId,
      timestamp: new Date().toISOString(), restaurantName: session.restaurantName, customerPhone: session.phone,
      items: session.cart.map(item => ({ name: item.name, quantity: item.quantity, price: item.price })),
      subtotal: session.subtotal, deliveryFee: session.deliveryFee, total: session.total,
      paymentMethod: session.paymentMethod, paymentGateway: session.paymentGateway || 'cod',
      paymentStatus: session.paymentMethod === 'online' || session.paymentMethod === 'upi_direct' ? 'PAID' : 'COD',
      deliveryAddress: session.deliveryAddress, specialInstructions: session.specialInstructions || 'None', upiIdUsed: session.upiIdUsed || null
    };
    const response = await fetch(process.env.GOOGLE_APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderData) });
    const result = await response.json();
    if (result.success) console.log('Order #' + orderId + ' logged to Google Sheets');
  } catch (e) { console.error('logOrderToGoogleSheets:', e.message); }
}

function buildOrderConfirmation(session, orderId) {
  const cart = session.cart.map((item, i) => (i+1) + '. ' + item.name + ' x' + item.quantity + ' = Rs.' + (item.price * item.quantity)).join('\n');
  const gatewayName = session.paymentGateway === 'razorpay' ? 'Razorpay' : session.paymentGateway === 'phonepe' ? 'PhonePe' : session.paymentGateway === 'paytm' ? 'Paytm' : 'Cash';
  const pay = session.paymentMethod === 'online' || session.paymentMethod === 'upi_direct' ? 'Online Paid (' + gatewayName + ')' : 'Cash on Delivery';
  
  const typeStr = session.orderType === 'takeaway' ? 'Type: Takeaway (Self Pickup)\n\n' : 'Address: ' + session.deliveryAddress + '\n\n';
  const expectedStr = session.orderType === 'takeaway' ? '~20 min for pickup. Thank you!' : '~45 min delivery. Thank you!';
  
  let feeStr = session.orderType === 'takeaway' ? '' : ' | Delivery: Rs.' + session.deliveryFee;

  return (
    '*Order Confirmed! #' + orderId + '*\n\n' +
    session.restaurantName + '\n\n' +
    '*Items:*\n' + cart + '\n\n' +
    'Subtotal: Rs.' + session.subtotal + feeStr + '\n' +
    '*Total: Rs.' + session.total + '*\n\n' +
    typeStr + pay + '\n\n' + expectedStr
  );
}

// ─── WEBHOOK HANDLER ────────────────────────────

app.post('/webhook', async (req, res) => {
  try {
    const { From, Body } = req.body;
    if (!From || !Body) return res.status(400).send('Missing params');
    const phone = From.replace('whatsapp:', '');
    const text = Body.trim();
    const upper = text.toUpperCase();
    console.log('\n[' + phone + '] -> "' + text + '"');
    
    // DB Check
    try { await pool.query('SELECT 1'); dbConnected = true; } catch (e) {
      console.error('DB ping failed:', e.message);
      await sendMessage(phone, 'System temporarily unavailable. Try again shortly.');
      return res.status(503).send('DB down');
    }
    await loadRestaurants();

    const restaurant = restaurantCache.find(r => r.qr_keyword && upper.includes(r.qr_keyword.toUpperCase()));
    if (restaurant) {
      const old = sessions.get(phone);
      if (old?.confirmTimeout) clearTimeout(old.confirmTimeout);
      const paymentTimeout = pendingPayments.get(phone);
      if (paymentTimeout) { clearTimeout(paymentTimeout); pendingPayments.delete(phone); }
      
      const canDeliver = restaurant.delivery_available !== false;
      const canBook = restaurant.table_booking_available !== false;
      const takeawayConditional = restaurant.takeaway_conditional === true; // The new dynamic toggle
      
      sessions.set(phone, { 
        phone, state: S.SELECT_SERVICE, restaurantId: restaurant.id, restaurantName: restaurant.name, 
        deliveryFee: restaurant.delivery_fee || 30, minOrder: restaurant.min_delivery_amount || 0, 
        canDeliver, canBook, takeawayConditional, createdAt: Date.now() 
      });
      
      let options = '', idx = 0;
      if (canDeliver) { idx++; options += idx + '. Order Food\n'; }
      if (canBook) { idx++; options += idx + '. Book a Table\n'; }
      await sendMessage(phone, 'Welcome to *' + restaurant.name + '*!\n\nWhat would you like to do?\n\n' + options + '\nReply with ' + (idx === 1 ? '1' : '1 or 2'));
      return res.status(200).send('OK');
    }

    let session = sessions.get(phone);
    if (!session) {
      const isGreeting = ['hi','hello','hey','start','menu','help'].some(w => text.toLowerCase().includes(w));
      await sendMessage(phone, isGreeting ? '*Welcome!*\n\nScan the QR code to start ordering!' : 'Scan the QR code to start ordering!');
      return res.status(200).send('OK');
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
        return res.status(200).send('OK');
      }
      if (action === 'booking') {
        session.state = S.BOOKING_NAME; session.serviceType = 'booking';
        sessions.set(phone, session);
        await sendMessage(phone, "What's your name?\n\nPlease enter your full name for the booking.");
        return res.status(200).send('OK');
      }
      await sendMessage(phone, 'Invalid choice.\n\nPlease reply with:\n' + (session.canDeliver ? '1 for Order Food\n' : '') + (session.canBook ? '2 for Book a Table' : ''));
      return res.status(200).send('OK');
    }

    if (session.state === S.BROWSE_MENU) {
      if (upper === 'CART') { await sendMessage(phone, session.cart.length ? formatCart(session.cart, session.deliveryFee) : 'Cart is empty.\n\nAdd items: item_id quantity'); return res.status(200).send('OK'); }
      if (upper === 'DONE') {
        if (!session.cart.length) { await sendMessage(phone, 'Cart is empty. Add items first!'); return res.status(200).send('OK'); }
        const sub = session.cart.reduce((s,i) => s + i.price * i.quantity, 0);
        session.subtotal = sub;
        
        // CONDITIONAL TAKEAWAY LOGIC
        if (session.takeawayConditional) {
            if (sub > 500) {
                session.state = S.CHOOSE_ORDER_TYPE;
                sessions.set(phone, session);
                await sendMessage(phone, formatCart(session.cart, session.deliveryFee) + '\n\n*Great! Your order qualifies for Delivery!*\n\nHow would you like to receive your food?\n1. Delivery\n2. Takeaway (Self Pickup)\n\nReply with 1 or 2');
                return res.status(200).send('OK');
            } else {
                session.orderType = 'takeaway';
                session.deliveryFee = 0; // No fee for pickup
                session.total = sub;
                session.deliveryAddress = 'Self Pickup (Takeaway)';
                session.state = S.ADD_INSTRUCTIONS;
                sessions.set(phone, session);
                await sendMessage(phone, formatCart(session.cart, 0) + '\n\n*Note:* Orders below Rs.500 are Takeaway only. Proceeding with Self Pickup.\n\nAny special instructions for the chef? (Type "no" if none)');
                return res.status(200).send('OK');
            }
        } else {
            // Standard Delivery Flow
            if (sub < session.minOrder) { await sendMessage(phone, 'Minimum order: Rs.' + session.minOrder + '\nCurrent: Rs.' + sub); return res.status(200).send('OK'); }
            session.total = Number(sub) + Number(session.deliveryFee); 
            session.orderType = 'delivery';
            session.state = S.ADD_ADDRESS;
            sessions.set(phone, session);
            await sendMessage(phone, formatCart(session.cart, session.deliveryFee) + '\n\nPlease enter your delivery address:');
            return res.status(200).send('OK');
        }
      }
      
      const match = text.match(/^(\d+)\s+(\d+)$/);
      if (match) {
        const id = parseInt(match[1]), qty = parseInt(match[2]);
        const item = session.menuItems.find(m => m.id === id);
        if (!item) { await sendMessage(phone, 'Item #' + id + ' not found.'); return res.status(200).send('OK'); }
        if (qty < 1 || qty > 99) { await sendMessage(phone, 'Qty must be 1-99'); return res.status(200).send('OK'); }
        const ex = session.cart.find(c => c.id === id);
        if (ex) ex.quantity += qty;
        else session.cart.push({ id: item.id, name: item.name, price: item.price, quantity: qty });
        sessions.set(phone, session);
        await sendMessage(phone, 'Added to cart!\n\n' + formatCart(session.cart, session.deliveryFee) + '\n\nAdd more items or type "done" to proceed.');
        return res.status(200).send('OK');
      }
      await sendMessage(phone, 'Use: item_id quantity (e.g., "15 2")');
      return res.status(200).send('OK');
    }

    if (session.state === S.CHOOSE_ORDER_TYPE) {
      if (text === '1') {
          session.orderType = 'delivery';
          session.total = Number(session.subtotal) + Number(session.deliveryFee);
          session.state = S.ADD_ADDRESS;
          sessions.set(phone, session);
          await sendMessage(phone, 'Delivery Selected.\n\nPlease enter your full delivery address:');
          return res.status(200).send('OK');
      } else if (text === '2') {
          session.orderType = 'takeaway';
          session.deliveryFee = 0;
          session.total = session.subtotal;
          session.deliveryAddress = 'Self Pickup (Takeaway)';
          session.state = S.ADD_INSTRUCTIONS;
          sessions.set(phone, session);
          await sendMessage(phone, 'Takeaway Selected.\n\nAny special instructions for the chef? (Type "no" if none)');
          return res.status(200).send('OK');
      } else {
          await sendMessage(phone, 'Invalid choice.\n\nReply *1* for Delivery or *2* for Takeaway.');
          return res.status(200).send('OK');
      }
    }

    if (session.state === S.ADD_ADDRESS) {
      session.deliveryAddress = text; session.state = S.ADD_INSTRUCTIONS; sessions.set(phone, session);
      await sendMessage(phone, 'Address saved!\n\nAny special instructions? (Type "no" if none)');
      return res.status(200).send('OK');
    }

    if (session.state === S.ADD_INSTRUCTIONS) {
      session.specialInstructions = text; session.state = S.CHOOSE_PAYMENT; sessions.set(phone, session);
      const lines = session.cart.map(i => '  ' + i.quantity + 'x ' + i.name + ' - Rs.' + (i.price * i.quantity)).join('\n');
      
      const typeStr = session.orderType === 'takeaway' ? 'Self Pickup (Takeaway)' : 'Delivery: ' + session.deliveryAddress;
      let feeStr = session.orderType === 'takeaway' ? '' : '\nDelivery Fee: Rs.' + session.deliveryFee;

      await sendMessage(phone,
        '*Choose Payment Method*\n\n*Your Order:*\n' + lines + '\n\nSubtotal: Rs.' + session.subtotal + feeStr + '\n*Total: Rs.' + session.total + '*\n\n' + typeStr + '\n\nSelect payment method:\n\n*Pay via UPI (Click & Pay):*\n1. PhonePe\n2. Google Pay\n3. Paytm\n4. Any UPI App\n\n*Cash Payment:*\n5. Cash on Delivery (COD)\n\nReply with *1*, *2*, *3*, *4*, or *5*'
      );
      return res.status(200).send('OK');
    }

    if (session.state === S.CHOOSE_PAYMENT) {
      if (text === '1' || text === '2' || text === '3' || text === '4') {
        const upiIds = await getRestaurantUPIIds(session.restaurantId);
        let method = null, upiId = '', methodName = '';
        if (text === '1') { method = 'phonepe'; upiId = upiIds.phonepe; methodName = 'PhonePe'; }
        else if (text === '2') { method = 'gpay'; upiId = upiIds.gpay; methodName = 'Google Pay'; }
        else if (text === '3') { method = 'paytm'; upiId = upiIds.paytm; methodName = 'Paytm'; }
        else if (text === '4') { method = 'upi'; upiId = upiIds.generic; methodName = 'UPI App'; }
        session.paymentMethod = 'upi_direct'; session.paymentGateway = method; session.upiIdUsed = upiId;
        session.state = S.AWAITING_PAYMENT;
        const tempOrderId = 'OD' + Date.now().toString().slice(-8);
        session.tempOrderId = tempOrderId; sessions.set(phone, session);
        const paymentUrl = process.env.BASE_URL + '/pay/' + session.restaurantId + '/' + tempOrderId + '?amount=' + session.total + '&upiId=' + encodeURIComponent(upiId) + '&name=' + encodeURIComponent(session.restaurantName) + '&method=' + method;
        console.log('[Order Payment] ' + session.restaurantName + ' | ' + methodName + ' | UPI: ' + upiId + ' | Rs.' + session.total);
        await sendMessage(phone, '*' + methodName + ' Payment*\n\nAmount: Rs.' + session.total + '\nUPI ID: ' + upiId + '\nName: ' + session.restaurantName + '\n\n*Click to Pay:*\n' + paymentUrl + '\n\n*Steps:*\n1. Click the link above\n2. ' + methodName + ' app will open\n3. Complete payment of Rs.' + session.total + '\n4. Return here and type *PAID*\n\nOr type *CANCEL* to cancel order\n\nLink valid for 15 minutes');
        pendingPayments.set(phone, setTimeout(async () => {
          if (sessions.get(phone)?.state === S.AWAITING_PAYMENT) { sessions.delete(phone); await sendMessage(phone, 'Payment timeout. Type restaurant name to start over.'); }
        }, 900000));
        return res.status(200).send('OK');
      }
      if (text === '5') {
        session.paymentMethod = 'cod'; session.paymentGateway = 'cod'; session.state = S.CONFIRM_ORDER;
        session.confirmTimeout = setTimeout(async () => {
          if (sessions.get(phone)?.state === S.CONFIRM_ORDER) { sessions.delete(phone); await sendMessage(phone, 'Confirmation timeout. Start over.'); }
        }, 600000);
        sessions.set(phone, session);
        const lines = session.cart.map(i => i.quantity + 'x ' + i.name + ' - Rs.' + (i.price * i.quantity)).join('\n');
        console.log('[COD Payment] ' + session.restaurantName + ' | Rs.' + session.total);
        
        const typeStr = session.orderType === 'takeaway' ? 'Self Pickup (Takeaway)' : 'Delivery: ' + session.deliveryAddress;
        
        await sendMessage(phone, '*CONFIRM YOUR ORDER*\n\n' + session.restaurantName + '\n\n*Your Order:*\n' + lines + '\n\nTotal: Rs.' + session.total + '\n' + typeStr + '\n\n*PAYMENT: CASH / PAY AT DESK*\n\nPay Rs.' + session.total + '\n\nType *CONFIRM* to place order\nType *CANCEL* to cancel\n\nYou have 10 minutes');
        return res.status(200).send('OK');
      }
      await sendMessage(phone, 'Invalid choice.\n\nReply *1*, *2*, *3*, *4*, or *5*');
      return res.status(200).send('OK');
    }

    if (session.state === S.AWAITING_PAYMENT) {
      if (upper === 'PAID') {
        session.state = S.CONFIRM_ORDER; session.awaitingTransactionId = true; sessions.set(phone, session);
        await sendMessage(phone, 'Great! Please enter your *Transaction ID*\n\n(Usually 10-12 digit number from payment app)\n\nExample: 435623789012');
        return res.status(200).send('OK');
      }
      if (session.awaitingTransactionId) {
        const txnId = text.trim();
        if (txnId.length >= 10 && /^[0-9A-Za-z]+$/.test(txnId)) {
          session.paymentTransactionId = txnId; session.paymentMethod = 'upi_direct'; session.state = S.CONFIRM_ORDER; delete session.awaitingTransactionId;
          const t = pendingPayments.get(phone); if (t) clearTimeout(t); pendingPayments.delete(phone); sessions.set(phone, session);
          const lines = session.cart.map(i => i.quantity + 'x ' + i.name + ' - Rs.' + (i.price * i.quantity)).join('\n');
          const typeStr = session.orderType === 'takeaway' ? 'Self Pickup (Takeaway)' : 'Delivery: ' + session.deliveryAddress;
          await sendMessage(phone, 'Transaction ID recorded: ' + txnId + '\n\n*CONFIRM YOUR ORDER*\n\n' + session.restaurantName + '\n\n*Your Order:*\n' + lines + '\n\nTotal: Rs.' + session.total + '\n' + typeStr + '\n\nPayment: UPI PAID\nTransaction: ' + txnId + '\n\nType *CONFIRM* to place order\nType *CANCEL* to cancel');
          return res.status(200).send('OK');
        }
        await sendMessage(phone, 'Invalid transaction ID format\n\nPlease enter a valid Transaction ID (10+ characters)\nExample: 435623789012');
        return res.status(200).send('OK');
      }
      if (upper === 'CANCEL') {
        const t = pendingPayments.get(phone); if (t) clearTimeout(t); pendingPayments.delete(phone); sessions.delete(phone);
        await sendMessage(phone, 'Order cancelled. Type restaurant name to start over.'); return res.status(200).send('OK');
      }
      await sendMessage(phone, 'Type *PAID* after making payment or *CANCEL* to cancel.');
      return res.status(200).send('OK');
    }

    if (session.state === S.CONFIRM_ORDER) {
      if (upper === 'CONFIRM') {
        if (session.confirmTimeout) clearTimeout(session.confirmTimeout);
        const orderId = await saveOrder(session);
        await notifyOwner(session, orderId);
        await logOrderToGoogleSheets(session, orderId);
        sessions.delete(phone);
        await sendMessage(phone, buildOrderConfirmation(session, orderId));
        return res.status(200).send('OK');
      }
      if (upper === 'CANCEL') { if (session.confirmTimeout) clearTimeout(session.confirmTimeout); sessions.delete(phone); await sendMessage(phone, 'Order cancelled.'); return res.status(200).send('OK'); }
      await sendMessage(phone, 'Type *CONFIRM* or *CANCEL*');
      return res.status(200).send('OK');
    }

    // ─── BOOKING FLOW ───────────────────────────

    if (session.state === S.BOOKING_NAME) {
      const customerName = text.trim();
      if (customerName.length < 2 || customerName.length > 50) { await sendMessage(phone, 'Please enter a valid name (2-50 characters)'); return res.status(200).send('OK'); }
      session.customerName = customerName; session.state = S.BOOKING_DATE; sessions.set(phone, session);
      await sendMessage(phone, 'Thank you, ' + customerName + '!\n\nWhen would you like to book?\n\nType:\n- TODAY or TOMORROW\n- DD/MM/YYYY (e.g., 10/02/2026)');
      return res.status(200).send('OK');
    }

    if (session.state === S.BOOKING_DATE) {
      let bookingDate = null;
      if (upper === 'TODAY') { bookingDate = new Date(); }
      else if (upper === 'TOMORROW') { bookingDate = new Date(); bookingDate.setDate(bookingDate.getDate() + 1); }
      else {
        const dateMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (dateMatch) {
          const day = parseInt(dateMatch[1]), month = parseInt(dateMatch[2]) - 1, year = parseInt(dateMatch[3]);
          bookingDate = new Date(year, month, day);
          if (isNaN(bookingDate.getTime()) || bookingDate.getDate() !== day || bookingDate.getMonth() !== month) { await sendMessage(phone, 'Invalid date. Please use DD/MM/YYYY format (e.g., 10/02/2026)'); return res.status(200).send('OK'); }
        } else { await sendMessage(phone, 'Invalid format.\n\nType:\n- TODAY or TOMORROW\n- DD/MM/YYYY (e.g., 10/02/2026)'); return res.status(200).send('OK'); }
      }
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (bookingDate < today) { await sendMessage(phone, 'Cannot book for past dates. Please select a current or future date.'); return res.status(200).send('OK'); }
      const maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 30);
      if (bookingDate > maxDate) { await sendMessage(phone, 'Bookings can only be made up to 30 days in advance.'); return res.status(200).send('OK'); }
      session.bookingDate = bookingDate.toISOString().split('T')[0]; session.state = S.BOOKING_TIME; sessions.set(phone, session);
      const dateStr = bookingDate.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      await sendMessage(phone, 'Booking for: ' + dateStr + '\n\nWhat time?\n\nType time in 12-hour format:\n- 6:00 PM\n- 7:30 PM\n- 8:15 PM\n\nOr type: LUNCH or DINNER');
      return res.status(200).send('OK');
    }

    if (session.state === S.BOOKING_TIME) {
      let bookingTime = null;
      if (upper === 'LUNCH') { bookingTime = '13:00'; }
      else if (upper === 'DINNER') { bookingTime = '20:00'; }
      else {
        const timeMatch = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
        if (timeMatch) {
          let hours = parseInt(timeMatch[1]); const mins = timeMatch[2] ? parseInt(timeMatch[2]) : 0; const period = timeMatch[3].toUpperCase();
          if (hours < 1 || hours > 12 || mins < 0 || mins > 59) { await sendMessage(phone, 'Invalid time. Hours: 1-12, Minutes: 00-59\n\nExample: 6:30 PM'); return res.status(200).send('OK'); }
          if (period === 'PM' && hours !== 12) hours += 12; else if (period === 'AM' && hours === 12) hours = 0;
          if (hours < 11 || hours >= 23) { await sendMessage(phone, 'Restaurant is open 11:00 AM - 11:00 PM\n\nPlease select a time within operating hours.'); return res.status(200).send('OK'); }
          bookingTime = String(hours).padStart(2, '0') + ':' + String(mins).padStart(2, '0');
        } else { await sendMessage(phone, 'Invalid format.\n\nType:\n- 6:00 PM\n- 7:30 PM\n- LUNCH or DINNER'); return res.status(200).send('OK'); }
      }
      session.bookingTime = bookingTime; session.state = S.BOOKING_GUESTS; sessions.set(phone, session);
      const [h, m] = bookingTime.split(':').map(Number);
      const period = h >= 12 ? 'PM' : 'AM'; const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
      const timeStr = displayHour + ':' + String(m).padStart(2, '0') + ' ' + period;
      await sendMessage(phone, 'Time: ' + timeStr + '\n\nHow many guests?\n\nType a number (1-20)');
      return res.status(200).send('OK');
    }

    if (session.state === S.BOOKING_GUESTS) {
      const guests = parseInt(text);
      if (isNaN(guests) || guests < 1 || guests > 20) { await sendMessage(phone, 'Please enter a number between 1 and 20'); return res.status(200).send('OK'); }
      session.numberOfGuests = guests;

      const { rows } = await pool.query(
        'SELECT booking_payment_required, booking_fee_amount, payment_qr_enabled, qr_code_url, qr_code_description, payment_phonepe_enabled, phonepe_number, phonepe_name, payment_gpay_enabled, gpay_number, gpay_name, payment_paytm_enabled, paytm_number, paytm_name, payment_upi_enabled, upi_id, upi_name, payment_cod_enabled, cod_description FROM restaurants WHERE id = $1',
        [session.restaurantId]
      );
      const rest = rows[0];

      const [h, m] = session.bookingTime.split(':').map(Number);
      const period = h >= 12 ? 'PM' : 'AM'; const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
      const timeStr = displayHour + ':' + String(m).padStart(2, '0') + ' ' + period;
      const bookingDate = new Date(session.bookingDate);
      const dateStr = bookingDate.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

      if (!rest?.booking_payment_required || rest.booking_fee_amount <= 0) {
        session.state = S.BOOKING_CONFIRM; sessions.set(phone, session);
        await sendMessage(phone, '*CONFIRM YOUR BOOKING*\n\nRestaurant: ' + session.restaurantName + '\nName: ' + session.customerName + '\nDate: ' + dateStr + '\nTime: ' + timeStr + '\nGuests: ' + guests + '\n\nPayment: No booking fee required\n\nType *CONFIRM* to complete booking\nType *CANCEL* to cancel');
        return res.status(200).send('OK');
      }

      session.bookingFeeAmount = rest.booking_fee_amount;
      session.paymentMethods = { qr: rest.payment_qr_enabled, phonepe: rest.payment_phonepe_enabled, gpay: rest.payment_gpay_enabled, paytm: rest.payment_paytm_enabled, upi: rest.payment_upi_enabled, cod: rest.payment_cod_enabled };
      session.paymentDetails = {
        qr: { url: rest.qr_code_url, desc: rest.qr_code_description },
        phonepe: { number: rest.phonepe_number, name: rest.phonepe_name },
        gpay: { number: rest.gpay_number, name: rest.gpay_name },
        paytm: { number: rest.paytm_number, name: rest.paytm_name },
        upi: { id: rest.upi_id, name: rest.upi_name },
        cod: { desc: rest.cod_description }
      };

      const enabled = Object.values(session.paymentMethods).filter(Boolean);
      if (enabled.length === 0) {
        session.state = S.BOOKING_CONFIRM; sessions.set(phone, session);
        await sendMessage(phone, '*CONFIRM YOUR BOOKING*\n\nRestaurant: ' + session.restaurantName + '\nName: ' + session.customerName + '\nDate: ' + dateStr + '\nTime: ' + timeStr + '\nGuests: ' + guests + '\n\nPayment methods not configured\n\nType *CONFIRM* to complete booking\nType *CANCEL* to cancel');
        return res.status(200).send('OK');
      }

      session.state = S.BOOKING_SELECT_PAYMENT_METHOD;
      let msg = guests + ' guests\n\n*BOOKING FEE: Rs.' + rest.booking_fee_amount + '*\n\nSelect your payment method:\n\n';
      let optionNum = 1; const optionMap = {};
      if (session.paymentMethods.qr)      { msg += optionNum + '. QR Code - Scan & Pay\n';         optionMap[optionNum.toString()] = 'qr';       optionNum++; }
      if (session.paymentMethods.phonepe) { msg += optionNum + '. PhonePe - Direct link\n';         optionMap[optionNum.toString()] = 'phonepe';  optionNum++; }
      if (session.paymentMethods.gpay)    { msg += optionNum + '. Google Pay - Direct link\n';       optionMap[optionNum.toString()] = 'gpay';     optionNum++; }
      if (session.paymentMethods.paytm)   { msg += optionNum + '. Paytm - Direct link\n';             optionMap[optionNum.toString()] = 'paytm';    optionNum++; }
      if (session.paymentMethods.upi)     { msg += optionNum + '. Any UPI App - Manual UPI ID\n';   optionMap[optionNum.toString()] = 'upi';       optionNum++; }
      if (session.paymentMethods.cod)     { msg += optionNum + '. Pay at Restaurant - COD\n';        optionMap[optionNum.toString()] = 'cod';       optionNum++; }
      session.paymentOptionMap = optionMap; sessions.set(phone, session);
      msg += '\nReply with option number (1-' + (optionNum-1) + ')';
      await sendMessage(phone, msg);
      return res.status(200).send('OK');
    }

    if (session.state === S.BOOKING_SELECT_PAYMENT_METHOD) {
      const choice = text.trim();
      const selectedMethod = session.paymentOptionMap?.[choice];
      if (!selectedMethod) { await sendMessage(phone, 'Invalid choice. Please select a valid option number.'); return res.status(200).send('OK'); }
      session.selectedPaymentMethod = selectedMethod; session.state = S.BOOKING_PAYMENT;
      const tempBookingId = 'BK' + Date.now().toString().slice(-8);
      session.tempBookingId = tempBookingId; sessions.set(phone, session);
      const amount = session.bookingFeeAmount;
      const upiIds = await getRestaurantUPIIds(session.restaurantId);

      const [h, m] = session.bookingTime.split(':').map(Number);
      const period = h >= 12 ? 'PM' : 'AM'; const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
      const timeStr = displayHour + ':' + String(m).padStart(2, '0') + ' ' + period;
      const bookingDate = new Date(session.bookingDate);
      const dateStr = bookingDate.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

      if (selectedMethod === 'cod') {
        session.bookingFeePaid = false; session.paymentMethod = 'cod'; session.paymentAppUsed = 'cod'; session.state = S.BOOKING_CONFIRM; sessions.set(phone, session);
        const codDesc = session.paymentDetails.cod.desc || 'Pay Rs.' + amount + ' at restaurant';
        console.log('[Booking COD] ' + session.restaurantName + ' | Rs.' + amount);
        await sendMessage(phone, '*CONFIRM YOUR BOOKING*\n\nRestaurant: ' + session.restaurantName + '\nName: ' + session.customerName + '\nDate: ' + dateStr + '\nTime: ' + timeStr + '\nGuests: ' + session.numberOfGuests + '\n\nPayment: ' + codDesc + '\n\nType *CONFIRM* to complete booking\nType *CANCEL* to cancel');
        return res.status(200).send('OK');
      }

      if (selectedMethod === 'qr') {
        const qr = session.paymentDetails.qr;
        await sendMessage(phone, 'QR Code Payment\n\nBooking Fee: Rs.' + amount + '\n\n' + (qr.desc || 'Scan the QR code below to pay') + '\n\nQR Code: ' + qr.url + '\n\nAfter payment, type:\n*PAID* - to enter transaction ID\n*SKIP* - to pay at restaurant');
        return res.status(200).send('OK');
      }

      const methodMap = {
        phonepe: { upiId: upiIds.phonepe, name: session.paymentDetails.phonepe.name, label: 'PhonePe',    urlMethod: 'phonepe' },
        gpay:    { upiId: upiIds.gpay,    name: session.paymentDetails.gpay.name,    label: 'Google Pay', urlMethod: 'gpay' },
        paytm:   { upiId: upiIds.paytm,   name: session.paymentDetails.paytm.name,   label: 'Paytm',      urlMethod: 'paytm' },
        upi:     { upiId: upiIds.generic,  name: session.paymentDetails.upi.name,     label: 'UPI App',    urlMethod: 'upi' }
      };
      const mInfo = methodMap[selectedMethod];
      const paymentUrl = process.env.BASE_URL + '/pay/' + session.restaurantId + '/' + tempBookingId + '?amount=' + amount + '&upiId=' + encodeURIComponent(mInfo.upiId) + '&name=' + encodeURIComponent(mInfo.name) + '&method=' + mInfo.urlMethod;
      console.log('[Booking Payment] ' + session.restaurantName + ' | ' + mInfo.label + ' | UPI: ' + mInfo.upiId + ' | Rs.' + amount);
      await sendMessage(phone, '*' + mInfo.label + ' Payment*\n\nBooking Fee: Rs.' + amount + '\nUPI ID: ' + mInfo.upiId + '\nName: ' + mInfo.name + '\n\n*Click to Pay:*\n' + paymentUrl + '\n\n*Steps:*\n1. Click the link above\n2. ' + mInfo.label + ' app will open\n3. Complete payment of Rs.' + amount + '\n4. Return here and type *PAID*\n\nType *SKIP* to pay at restaurant');
      return res.status(200).send('OK');
    }

    if (session.state === S.BOOKING_PAYMENT) {
      if (upper === 'PAID') {
        session.paymentAppUsed = session.selectedPaymentMethod || 'upi'; session.state = S.BOOKING_VERIFY_PAYMENT; sessions.set(phone, session);
        await sendMessage(phone, 'Payment confirmation received!\n\nPlease enter your Transaction ID\n(Usually 10-12 digit number)\n\nExample: 435623789012\n\nOr type *SKIP* if you want to verify later');
        return res.status(200).send('OK');
      }
      if (upper === 'SKIP') {
        session.bookingFeePaid = false; session.paymentMethod = 'pending'; session.paymentAppUsed = session.selectedPaymentMethod || 'pending'; session.state = S.BOOKING_CONFIRM; sessions.set(phone, session);
        const [h, m] = session.bookingTime.split(':').map(Number);
        const period = h >= 12 ? 'PM' : 'AM'; const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
        const timeStr = displayHour + ':' + String(m).padStart(2, '0') + ' ' + period;
        const bookingDate = new Date(session.bookingDate);
        const dateStr = bookingDate.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        await sendMessage(phone, 'Proceeding without payment confirmation\n\n*CONFIRM YOUR BOOKING*\n\nRestaurant: ' + session.restaurantName + '\nName: ' + session.customerName + '\nDate: ' + dateStr + '\nTime: ' + timeStr + '\nGuests: ' + session.numberOfGuests + '\n\nPayment: Rs.' + session.bookingFeeAmount + ' - Pay at restaurant\n\nType *CONFIRM* to complete booking\nType *CANCEL* to cancel');
        return res.status(200).send('OK');
      }
      await sendMessage(phone, 'Please type:\n*PAID* - after making payment\n*SKIP* - to pay at restaurant\n\nAmount: Rs.' + session.bookingFeeAmount);
      return res.status(200).send('OK');
    }

    if (session.state === S.BOOKING_VERIFY_PAYMENT) {
      const [h, m] = session.bookingTime.split(':').map(Number);
      const period = h >= 12 ? 'PM' : 'AM'; const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
      const timeStr = displayHour + ':' + String(m).padStart(2, '0') + ' ' + period;
      const bookingDate = new Date(session.bookingDate);
      const dateStr = bookingDate.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

      if (upper === 'SKIP') {
        session.bookingFeePaid = true; session.paymentMethod = session.selectedPaymentMethod || 'upi'; session.paymentTransactionId = 'manual_verification_pending'; session.state = S.BOOKING_CONFIRM; sessions.set(phone, session);
        await sendMessage(phone, '*CONFIRM YOUR BOOKING*\n\nRestaurant: ' + session.restaurantName + '\nName: ' + session.customerName + '\nDate: ' + dateStr + '\nTime: ' + timeStr + '\nGuests: ' + session.numberOfGuests + '\n\nPayment: Rs.' + session.bookingFeeAmount + ' - Manual verification\n\nType *CONFIRM* to complete booking\nType *CANCEL* to cancel');
        return res.status(200).send('OK');
      }
      const txnId = text.trim();
      if (txnId.length >= 10 && /^[0-9A-Za-z]+$/.test(txnId)) {
        session.bookingFeePaid = true; session.paymentMethod = session.selectedPaymentMethod || 'upi'; session.paymentTransactionId = txnId; session.state = S.BOOKING_CONFIRM; sessions.set(phone, session);
        const methodName = { qr: 'QR Code', phonepe: 'PhonePe', gpay: 'Google Pay', paytm: 'Paytm', upi: 'UPI' }[session.selectedPaymentMethod] || 'UPI';
        await sendMessage(phone, 'Transaction ID recorded: ' + txnId + '\n\n*CONFIRM YOUR BOOKING*\n\nRestaurant: ' + session.restaurantName + '\nName: ' + session.customerName + '\nDate: ' + dateStr + '\nTime: ' + timeStr + '\nGuests: ' + session.numberOfGuests + '\n\nPayment: Rs.' + session.bookingFeeAmount + ' PAID (' + methodName + ')\nTransaction ID: ' + txnId + '\n\nType *CONFIRM* to complete booking\nType *CANCEL* to cancel');
        return res.status(200).send('OK');
      }
      await sendMessage(phone, 'Invalid transaction ID format\n\nPlease enter a valid Transaction ID (10+ characters)\nExample: 435623789012\n\nOr type *SKIP* to verify later');
      return res.status(200).send('OK');
    }

    if (session.state === S.BOOKING_CONFIRM) {
      if (upper === 'CONFIRM') {
        try {
          const result = await pool.query(
            "INSERT INTO table_bookings (restaurant_id, customer_phone, customer_name, booking_date, booking_time, number_of_guests, booking_fee_paid, payment_method, payment_transaction_id, payment_app_used, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CONFIRMED',NOW()) RETURNING id",
            [session.restaurantId, session.phone, session.customerName, session.bookingDate, session.bookingTime, session.numberOfGuests, session.bookingFeePaid || false, session.paymentMethod || null, session.paymentTransactionId || null, session.paymentAppUsed || null]
          );
          const bookingId = result.rows[0].id;
          const [h, m] = session.bookingTime.split(':').map(Number);
          const period = h >= 12 ? 'PM' : 'AM'; const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
          const timeStr = displayHour + ':' + String(m).padStart(2, '0') + ' ' + period;
          const bookingDate = new Date(session.bookingDate);
          const dateStr = bookingDate.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

          let paymentStatusMsg = '';
          if (session.bookingFeeAmount && session.bookingFeeAmount > 0) {
            if (session.bookingFeePaid) {
              paymentStatusMsg = '\nBooking Fee: Rs.' + session.bookingFeeAmount + ' - PAID\n';
              if (session.paymentTransactionId && session.paymentTransactionId !== 'manual_verification_pending') paymentStatusMsg += 'Transaction ID: ' + session.paymentTransactionId + '\n';
            } else { paymentStatusMsg = '\nBooking Fee: Rs.' + session.bookingFeeAmount + ' - Pay at restaurant\n'; }
          }

          await logBookingToGoogleSheets(session, bookingId);

          try {
            const { rows } = await pool.query('SELECT whatsapp_number FROM restaurants WHERE id = $1', [session.restaurantId]);
            if (rows[0]?.whatsapp_number) {
              let ownerPaymentMsg = '';
              if (session.bookingFeeAmount && session.bookingFeeAmount > 0) {
                if (session.bookingFeePaid) {
                  ownerPaymentMsg = 'Fee: Rs.' + session.bookingFeeAmount + ' - PAID\n';
                  if (session.paymentTransactionId && session.paymentTransactionId !== 'manual_verification_pending') ownerPaymentMsg += 'TXN: ' + session.paymentTransactionId + '\n';
                  else ownerPaymentMsg += 'Manual verification required\n';
                } else { ownerPaymentMsg = 'Fee: Rs.' + session.bookingFeeAmount + ' - PENDING\n'; }
              }
              await sendMessage(rows[0].whatsapp_number, 'NEW TABLE BOOKING #' + bookingId + '\n\n' + session.restaurantName + '\nName: ' + session.customerName + '\nPhone: ' + session.phone + '\nDate: ' + dateStr + '\nTime: ' + timeStr + '\nGuests: ' + session.numberOfGuests + '\n' + ownerPaymentMsg + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
              console.log('Owner notified of booking #' + bookingId);
            }
          } catch (e) { console.error('Failed to notify owner:', e.message); }

          await sendMessage(phone, 'Booking Confirmed!\n\nBooking ID: #' + bookingId + '\nName: ' + session.customerName + '\nRestaurant: ' + session.restaurantName + '\n\nDate: ' + dateStr + '\nTime: ' + timeStr + '\nGuests: ' + session.numberOfGuests + paymentStatusMsg + '\nYour table is reserved!\n\nPlease arrive on time. Thank you!');
          console.log('Booking #' + bookingId + ' confirmed for ' + session.phone);
          sessions.delete(phone);
          return res.status(200).send('OK');
        } catch (e) {
          console.error('Booking save failed:', e.message);
          await sendMessage(phone, 'Failed to save booking. Please try again or contact the restaurant.');
          return res.status(200).send('OK');
        }
      }
      if (upper === 'CANCEL') { sessions.delete(phone); await sendMessage(phone, 'Booking cancelled. Type restaurant name to start over.'); return res.status(200).send('OK'); }
      await sendMessage(phone, 'Type *CONFIRM* to complete booking or *CANCEL* to cancel');
      return res.status(200).send('OK');
    }

    await sendMessage(phone, 'Something went wrong. Type restaurant name to restart.');
    return res.status(200).send('OK');

  } catch (e) { console.error('Webhook:', e); res.status(500).send('Error'); }
});

// ════════════════════════════════════════════
// PAYMENT WEBHOOKS & CALLBACKS
// ════════════════════════════════════════════

app.post('/payment/razorpay/webhook', async (req, res) => {
  try {
    const event = req.body.event;
    const entity = req.body.payload?.payment_link?.entity || req.body.payload?.payment?.entity;
    if (!entity) return res.status(400).send('No entity');
    let phone = null;
    for (const [p, s] of sessions) { if (s.paymentId === entity.id) { phone = p; break; } }
    if (!phone) return res.status(200).send('OK');
    if (event === 'payment.captured' || event === 'payment_link.paid') {
      const session = sessions.get(phone);
      const t = pendingPayments.get(phone); if (t) clearTimeout(t); pendingPayments.delete(phone);
      const orderId = await saveOrder(session); await notifyOwner(session, orderId); await logOrderToGoogleSheets(session, orderId);
      await sendMessage(phone, buildOrderConfirmation(session, orderId)); sessions.delete(phone);
    }
    res.status(200).send('OK');
  } catch (e) { console.error('Razorpay webhook:', e.message); res.status(500).send('Error'); }
});

app.get('/payment/razorpay/callback', (req, res) => {
  res.send('<!DOCTYPE html><html><head><title>Payment Success</title><style>body{font-family:Arial;text-align:center;padding:60px;background:#f0faf0}h1{color:#2e7d32}p{color:#555;font-size:18px}</style></head><body><div style="font-size:80px">&#x2705;</div><h1>Payment Successful!</h1><p>Return to WhatsApp and type <b>CHECK</b> to confirm your order.</p></body></html>');
});

app.post('/payment/phonepe/webhook', async (req, res) => {
  try {
    const response = req.body.response;
    if (!response) return res.status(400).send('No response');
    const decodedResponse = Buffer.from(response, 'base64').toString('utf-8');
    const data = JSON.parse(decodedResponse);
    if (data.success && data.code === 'PAYMENT_SUCCESS') {
      const merchantTransactionId = data.data.merchantTransactionId;
      let phone = null;
      for (const [p, s] of sessions) { if (s.paymentId === merchantTransactionId) { phone = p; break; } }
      if (phone) {
        const session = sessions.get(phone);
        const t = pendingPayments.get(phone); if (t) clearTimeout(t); pendingPayments.delete(phone);
        const orderId = await saveOrder(session); await notifyOwner(session, orderId); await logOrderToGoogleSheets(session, orderId);
        await sendMessage(phone, buildOrderConfirmation(session, orderId)); sessions.delete(phone);
      }
    }
    res.status(200).send('OK');
  } catch (e) { console.error('PhonePe webhook:', e.message); res.status(500).send('Error'); }
});

app.get('/payment/phonepe/callback', (req, res) => {
  res.send('<!DOCTYPE html><html><head><title>Payment Success</title><style>body{font-family:Arial;text-align:center;padding:60px;background:#f0faf0}h1{color:#2e7d32}p{color:#555;font-size:18px}</style></head><body><div style="font-size:80px">&#x2705;</div><h1>Payment Successful!</h1><p>Return to WhatsApp and type <b>CHECK</b> to confirm your order.</p></body></html>');
});

app.post('/payment/paytm/callback', async (req, res) => {
  try {
    const PaytmChecksum = require('paytmchecksum');
    const paytmParams = {};
    for (let key in req.body) { if (key !== 'CHECKSUMHASH') paytmParams[key] = req.body[key]; }
    const checksumHash = req.body.CHECKSUMHASH;
    const isValidChecksum = PaytmChecksum.verifySignature(paytmParams, process.env.PAYTM_MERCHANT_KEY, checksumHash);
    if (isValidChecksum && req.body.STATUS === 'TXN_SUCCESS') {
      const orderId = req.body.ORDERID;
      let phone = null;
      for (const [p, s] of sessions) { if (s.paymentId === orderId) { phone = p; break; } }
      if (phone) {
        const session = sessions.get(phone);
        const t = pendingPayments.get(phone); if (t) clearTimeout(t); pendingPayments.delete(phone);
        const dbOrderId = await saveOrder(session); await notifyOwner(session, dbOrderId); await logOrderToGoogleSheets(session, dbOrderId);
        await sendMessage(phone, buildOrderConfirmation(session, dbOrderId)); sessions.delete(phone);
      }
    }
    res.send('<!DOCTYPE html><html><head><title>Payment Success</title><style>body{font-family:Arial;text-align:center;padding:60px;background:#f0faf0}h1{color:#2e7d32}p{color:#555;font-size:18px}</style></head><body><div style="font-size:80px">&#x2705;</div><h1>Payment Successful!</h1><p>Return to WhatsApp and type <b>CHECK</b> to confirm your order.</p></body></html>');
  } catch (e) { console.error('Paytm callback:', e.message); res.status(500).send('Error'); }
});

// ─── UTILITY & HEALTH ENDPOINTS ─────────────────

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    
    // Calculate Uptime
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptimeSeconds / 3600);
    const m = Math.floor((uptimeSeconds % 3600) / 60);
    const s = uptimeSeconds % 60;
    const uptimeString = `${h}h ${m}m ${s}s`;

    res.json({
      status: 'OK',
      uptime: uptimeString,
      serverTime: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      stats: {
        ordersToday: serverStats.totalOrdersToday,
        lastOrder: serverStats.lastOrderTime || 'No orders yet',
        activeSessions: sessions.size
      },
      infrastructure: {
        database: 'Connected',
        restaurantsLoaded: restaurantCache.length,
        googleSheets: process.env.GOOGLE_APPS_SCRIPT_URL ? 'Enabled' : 'Disabled'
      },
      system: {
        version: '6.6.0-LEGACYLENS',
        nodeEnv: NODE_ENV,
        memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
      }
    });
  } catch (e) { 
    res.status(503).json({ status: 'ERROR', database: 'Disconnected', error: e.message }); 
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
  res.json(s ? { found: true, state: s.state, restaurantName: s.restaurantName, cartSize: s.cart?.length || 0, paymentGateway: s.paymentGateway, upiIdUsed: s.upiIdUsed } : { found: false });
});

app.post('/admin/clear-sessions', (req, res) => {
  if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  sessions.forEach(s => { if (s.confirmTimeout) clearTimeout(s.confirmTimeout); });
  sessions.clear();
  res.json({ cleared: true });
});

app.post('/reload-cache', (req, res) => {
  loadRestaurants(true).then(() => res.json({ reloaded: true, count: restaurantCache.length }));
});

app.get('/test/messages/:phone', (req, res) => {
  const msgs = testMessages.get(req.params.phone) || [];
  testMessages.delete(req.params.phone);
  res.json({ messages: msgs });
});

app.post('/test/simulate-payment/:phone', (req, res) => {
  const s = sessions.get(req.params.phone);
  if (s && s.state === S.AWAITING_PAYMENT) {
    s.testPaymentPaid = true; sessions.set(req.params.phone, s);
    res.json({ success: true, paymentId: s.paymentId, gateway: s.paymentGateway });
  } else { res.json({ success: false, reason: 'No pending payment session' }); }
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
      console.log('');
      console.log('╔══════════════════════════════════════════╗');
      console.log('║  RESTAURANT WHATSAPP BOT v6.6            ║');
      console.log('║  ✅ Legacylens Edition                   ║');
      console.log('║  ✅ Conditional Takeaway Enabled         ║');
      console.log('║  ✅ Daily Order Counter                  ║');
      console.log('║  ✅ Auto-split >1500 chars               ║');
      console.log('║  ✅ Google Sheets Integration            ║');
      console.log('╠══════════════════════════════════════════╣');
      console.log('║  Port: ' + PORT + '                         ║');
      console.log('║  Test Mode: ' + (TEST_MODE ? 'ON' : 'OFF') + '                    ║');
      console.log('║  DB: ' + (dbConnected ? 'Connected' : 'Disconnected') + '                         ║');
      console.log('║  Restaurants: ' + restaurantCache.length + '                          ║');
      console.log('╚══════════════════════════════════════════╝');
      console.log('');
    });
  } catch (e) { console.error('Startup failed:', e); process.exit(1); }
}

startServer();
