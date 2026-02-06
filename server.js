// ============================================
// RESTAURANT WHATSAPP BOT v6.1 - CLICKABLE PAYMENT LINKS
// Multi-Restaurant | Multi-Payment Gateway | Google Sheets
// Razorpay | PhonePe | Paytm | COD
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
  BOOKING_NAME:     'BOOKING_NAME',
  BOOKING_DATE:     'BOOKING_DATE',
  BOOKING_TIME:     'BOOKING_TIME',
  BOOKING_GUESTS:   'BOOKING_GUESTS',
  BOOKING_SELECT_PAYMENT_METHOD: 'BOOKING_SELECT_PAYMENT_METHOD',
  BOOKING_PAYMENT:  'BOOKING_PAYMENT',
  BOOKING_VERIFY_PAYMENT: 'BOOKING_VERIFY_PAYMENT',
  BOOKING_CONFIRM:  'BOOKING_CONFIRM'
};

// ════════════════════════════════════════════
// PAYMENT GATEWAY INTEGRATIONS
// ════════════════════════════════════════════

// ─── RAZORPAY ────────────────────────────────
async function createRazorpayPayment(orderData) {
  try {
    const Razorpay = require('razorpay');
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });

    const options = {
      amount: Math.round(orderData.amount * 100),
      currency: 'INR',
      accept_partial: false,
      description: `Order from ${orderData.restaurantName}`,
      customer: {
        contact: orderData.phone,
        name: orderData.customerName || 'Customer'
      },
      notify: { sms: true, whatsapp: true },
      reminder_enable: true,
      callback_url: `${process.env.BASE_URL}/payment/razorpay/callback`,
      callback_method: 'get'
    };

    const paymentLink = await razorpay.paymentLink.create(options);
    console.log(`✅ Razorpay payment created: ${paymentLink.short_url}`);

    return {
      success: true,
      gateway: 'razorpay',
      paymentId: paymentLink.id,
      paymentUrl: paymentLink.short_url,
      orderId: paymentLink.order_id || paymentLink.id
    };
  } catch (error) {
    console.error('❌ Razorpay Error:', error.message);
    return { success: false, error: error.message };
  }
}

async function verifyRazorpayPayment(paymentId) {
  try {
    const Razorpay = require('razorpay');
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
    
    const paymentLink = await razorpay.paymentLink.fetch(paymentId);
    return {
      success: true,
      verified: paymentLink.status === 'paid'
    };
  } catch (error) {
    console.error('❌ Razorpay Verify Error:', error.message);
    return { success: false, verified: false };
  }
}

// ─── PHONEPE ─────────────────────────────────
async function createPhonePePayment(orderData) {
  try {
    const merchantId = process.env.PHONEPE_MERCHANT_ID;
    const saltKey = process.env.PHONEPE_SALT_KEY;
    const saltIndex = process.env.PHONEPE_SALT_INDEX || '1';
    const mode = process.env.PHONEPE_MODE || 'UAT';
    
    if (!merchantId || !saltKey) {
      return { success: false, error: 'PhonePe credentials not configured' };
    }
    
    const baseUrl = mode === 'PRODUCTION' 
      ? 'https://api.phonepe.com/apis/hermes'
      : 'https://api-preprod.phonepe.com/apis/pg-sandbox';

    const merchantTransactionId = `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const payload = {
      merchantId: merchantId,
      merchantTransactionId: merchantTransactionId,
      merchantUserId: orderData.phone.replace(/\D/g, '').substr(-10),
      amount: Math.round(orderData.amount * 100),
      redirectUrl: `${process.env.BASE_URL}/payment/phonepe/callback`,
      redirectMode: 'GET',
      callbackUrl: `${process.env.BASE_URL}/payment/phonepe/webhook`,
      mobileNumber: orderData.phone.replace(/\D/g, '').substr(-10),
      paymentInstrument: { type: 'PAY_PAGE' }
    };

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const checksumString = base64Payload + '/pg/v1/pay' + saltKey;
    const checksum = crypto.createHash('sha256').update(checksumString).digest('hex') + '###' + saltIndex;

    const response = await axios.post(
      `${baseUrl}/pg/v1/pay`,
      { request: base64Payload },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': checksum
        }
      }
    );

    if (response.data.success) {
      console.log(`✅ PhonePe payment created: ${merchantTransactionId}`);
      return {
        success: true,
        gateway: 'phonepe',
        paymentId: merchantTransactionId,
        paymentUrl: response.data.data.instrumentResponse.redirectInfo.url,
        orderId: merchantTransactionId
      };
    } else {
      return { success: false, error: response.data.message };
    }
  } catch (error) {
    console.error('❌ PhonePe Error:', error.message);
    return { success: false, error: error.message };
  }
}

async function verifyPhonePePayment(merchantTransactionId) {
  try {
    const merchantId = process.env.PHONEPE_MERCHANT_ID;
    const saltKey = process.env.PHONEPE_SALT_KEY;
    const saltIndex = process.env.PHONEPE_SALT_INDEX || '1';
    const mode = process.env.PHONEPE_MODE || 'UAT';
    
    const baseUrl = mode === 'PRODUCTION'
      ? 'https://api.phonepe.com/apis/hermes'
      : 'https://api-preprod.phonepe.com/apis/pg-sandbox';

    const checksumString = `/pg/v1/status/${merchantId}/${merchantTransactionId}` + saltKey;
    const checksum = crypto.createHash('sha256').update(checksumString).digest('hex') + '###' + saltIndex;

    const response = await axios.get(
      `${baseUrl}/pg/v1/status/${merchantId}/${merchantTransactionId}`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': checksum,
          'X-MERCHANT-ID': merchantId
        }
      }
    );

    return {
      success: true,
      verified: response.data.success && response.data.code === 'PAYMENT_SUCCESS'
    };
  } catch (error) {
    console.error('❌ PhonePe Verify Error:', error.message);
    return { success: false, verified: false };
  }
}

// ─── PAYTM ───────────────────────────────────
async function createPaytmPayment(orderData) {
  try {
    const PaytmChecksum = require('paytmchecksum');
    const merchantId = process.env.PAYTM_MERCHANT_ID;
    const merchantKey = process.env.PAYTM_MERCHANT_KEY;
    const website = process.env.PAYTM_WEBSITE || 'WEBSTAGING';
    
    if (!merchantId || !merchantKey) {
      return { success: false, error: 'Paytm credentials not configured' };
    }
    
    const orderId = `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const paytmParams = {
      body: {
        requestType: 'Payment',
        mid: merchantId,
        websiteName: website,
        orderId: orderId,
        callbackUrl: `${process.env.BASE_URL}/payment/paytm/callback`,
        txnAmount: {
          value: orderData.amount.toFixed(2),
          currency: 'INR'
        },
        userInfo: {
          custId: orderData.phone.replace(/\D/g, '').substr(-10)
        }
      }
    };

    const checksum = await PaytmChecksum.generateSignature(
      JSON.stringify(paytmParams.body),
      merchantKey
    );

    paytmParams.head = { signature: checksum };

    const baseUrl = website === 'WEBSTAGING'
      ? 'https://securegw-stage.paytm.in'
      : 'https://securegw.paytm.in';

    const response = await axios.post(
      `${baseUrl}/theia/api/v1/initiateTransaction?mid=${merchantId}&orderId=${orderId}`,
      paytmParams,
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (response.data.body.resultInfo.resultStatus === 'S') {
      const txnToken = response.data.body.txnToken;
      const paymentUrl = `${baseUrl}/theia/api/v1/showPaymentPage?mid=${merchantId}&orderId=${orderId}`;
      
      console.log(`✅ Paytm payment created: ${orderId}`);
      return {
        success: true,
        gateway: 'paytm',
        paymentId: orderId,
        paymentUrl: paymentUrl,
        txnToken: txnToken,
        orderId: orderId
      };
    } else {
      return { success: false, error: response.data.body.resultInfo.resultMsg };
    }
  } catch (error) {
    console.error('❌ Paytm Error:', error.message);
    return { success: false, error: error.message };
  }
}

async function verifyPaytmPayment(orderId) {
  try {
    const PaytmChecksum = require('paytmchecksum');
    const merchantId = process.env.PAYTM_MERCHANT_ID;
    const merchantKey = process.env.PAYTM_MERCHANT_KEY;
    const website = process.env.PAYTM_WEBSITE || 'WEBSTAGING';

    const paytmParams = {
      body: {
        mid: merchantId,
        orderId: orderId
      }
    };

    const checksum = await PaytmChecksum.generateSignature(
      JSON.stringify(paytmParams.body),
      merchantKey
    );

    paytmParams.head = { signature: checksum };

    const baseUrl = website === 'WEBSTAGING'
      ? 'https://securegw-stage.paytm.in'
      : 'https://securegw.paytm.in';

    const response = await axios.post(
      `${baseUrl}/v3/order/status`,
      paytmParams,
      { headers: { 'Content-Type': 'application/json' } }
    );

    return {
      success: true,
      verified: response.data.body.resultInfo.resultStatus === 'TXN_SUCCESS'
    };
  } catch (error) {
    console.error('❌ Paytm Verify Error:', error.message);
    return { success: false, verified: false };
  }
}

// ─── UNIFIED PAYMENT FUNCTIONS ───────────────
async function createPayment(gateway, orderData) {
  console.log(`💳 Creating ${gateway} payment for ₹${orderData.amount}`);
  
  if (TEST_MODE) {
    return {
      success: true,
      gateway: gateway,
      paymentId: `test_${gateway}_${Date.now()}`,
      paymentUrl: `https://test-payment.com/${gateway}`,
      orderId: `test_order_${Date.now()}`
    };
  }
  
  switch (gateway) {
    case 'razorpay':
      return await createRazorpayPayment(orderData);
    case 'phonepe':
      return await createPhonePePayment(orderData);
    case 'paytm':
      return await createPaytmPayment(orderData);
    default:
      return { success: false, error: 'Invalid payment gateway' };
  }
}

async function verifyPayment(gateway, paymentId) {
  console.log(`🔍 Verifying ${gateway} payment: ${paymentId}`);
  
  if (TEST_MODE) {
    const s = Array.from(sessions.values()).find(sess => sess.paymentId === paymentId);
    return { success: true, verified: s?.testPaymentPaid === true };
  }
  
  switch (gateway) {
    case 'razorpay':
      return await verifyRazorpayPayment(paymentId);
    case 'phonepe':
      return await verifyPhonePePayment(paymentId);
    case 'paytm':
      return await verifyPaytmPayment(paymentId);
    default:
      return { success: false, verified: false };
  }
}

// ════════════════════════════════════════════
// UPI PAYMENT REDIRECT PAGE (CLICKABLE LINKS)
// ════════════════════════════════════════════

app.get('/pay/:restaurantId/:bookingId', (req, res) => {
  const { restaurantId, bookingId } = req.params;
  const { amount, upiId, name, method } = req.query;
  
  const upiLink = method === 'phonepe' 
    ? `phonepe://pay?pa=${upiId}&pn=${encodeURIComponent(name)}&am=${amount}&cu=INR&tn=Booking-${bookingId}`
    : method === 'gpay'
    ? `gpay://upi/pay?pa=${upiId}&pn=${encodeURIComponent(name)}&am=${amount}&cu=INR&tn=Booking-${bookingId}`
    : method === 'paytm'
    ? `paytmmp://pay?pa=${upiId}&pn=${encodeURIComponent(name)}&am=${amount}&cu=INR&tn=Booking-${bookingId}`
    : `upi://pay?pa=${upiId}&pn=${encodeURIComponent(name)}&am=${amount}&cu=INR&tn=Booking-${bookingId}`;
  
  const methodName = method === 'phonepe' ? 'PhonePe' 
                   : method === 'gpay' ? 'Google Pay'
                   : method === 'paytm' ? 'Paytm'
                   : 'UPI App';
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment - ${name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 40px 30px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      text-align: center;
    }
    .icon { font-size: 60px; margin-bottom: 20px; }
    h1 { color: #333; font-size: 24px; margin-bottom: 10px; }
    .amount { 
      font-size: 42px; 
      font-weight: bold; 
      color: #667eea; 
      margin: 20px 0;
    }
    .details {
      background: #f5f5f5;
      padding: 15px;
      border-radius: 10px;
      margin: 20px 0;
      text-align: left;
    }
    .details p {
      margin: 8px 0;
      color: #666;
      font-size: 14px;
    }
    .details strong { color: #333; }
    .btn {
      display: block;
      width: 100%;
      padding: 15px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      text-decoration: none;
      border-radius: 10px;
      font-size: 18px;
      font-weight: 600;
      margin: 10px 0;
      border: none;
      cursor: pointer;
      transition: transform 0.2s;
    }
    .btn:hover { transform: translateY(-2px); }
    .btn:active { transform: scale(0.98); }
    .manual {
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid #ddd;
    }
    .upi-id {
      background: #f9f9f9;
      padding: 12px;
      border-radius: 8px;
      font-family: 'Courier New', monospace;
      font-size: 16px;
      margin: 10px 0;
      word-break: break-all;
      color: #333;
      font-weight: 600;
    }
    .copy-btn {
      background: #28a745;
      font-size: 14px;
      padding: 10px 20px;
    }
    .instructions {
      color: #666;
      font-size: 13px;
      margin-top: 20px;
      padding: 15px;
      background: #fff3cd;
      border-radius: 8px;
      text-align: left;
    }
    .instructions strong { color: #856404; }
    .loading {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 3px solid rgba(255,255,255,.3);
      border-radius: 50%;
      border-top-color: white;
      animation: spin 1s ease-in-out infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">💳</div>
    <h1>${name}</h1>
    <div class="amount">₹${amount}</div>
    
    <div class="details">
      <p><strong>Booking ID:</strong> ${bookingId}</p>
      <p><strong>UPI ID:</strong> ${upiId}</p>
      <p><strong>Method:</strong> ${methodName}</p>
    </div>
    
    <a href="${upiLink}" class="btn" id="payBtn">
      🚀 Pay with ${methodName}
    </a>
    
    <div class="manual">
      <p style="color: #666; margin-bottom: 10px; font-size: 14px;">
        <strong>Or copy UPI ID manually:</strong>
      </p>
      <div class="upi-id" id="upiId">${upiId}</div>
      <button class="btn copy-btn" onclick="copyUPI()">📋 Copy UPI ID</button>
    </div>
    
    <div class="instructions">
      <p><strong>📱 Steps to complete payment:</strong></p>
      <p>1. Click "Pay with ${methodName}" button above</p>
      <p>2. Complete payment in the app</p>
      <p>3. Return to WhatsApp</p>
      <p>4. Type <strong>PAID</strong> to enter transaction ID</p>
    </div>
  </div>
  
  <script>
    function copyUPI() {
      const upiText = document.getElementById('upiId').textContent;
      navigator.clipboard.writeText(upiText).then(() => {
        const btn = event.target;
        const originalText = btn.innerHTML;
        btn.innerHTML = '✅ Copied!';
        btn.style.background = '#28a745';
        setTimeout(() => {
          btn.innerHTML = originalText;
          btn.style.background = '';
        }, 2000);
      }).catch(() => {
        alert('UPI ID: ' + upiText);
      });
    }
    
    // Auto-redirect after 1.5 seconds
    setTimeout(() => {
      document.getElementById('payBtn').click();
    }, 1500);
  </script>
</body>
</html>
  `;
  
  res.send(html);
});

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
    const msg = await twilioClient.messages.create({ 
      from: wabaNumber, 
      to: `whatsapp:${to}`, 
      body 
    });
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
      console.log(`📋 Cached ${restaurantCache.length} restaurants`);
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
         total_amount, status, payment_status, payment_method, payment_gateway,
         gateway_transaction_id, gateway_order_id, created_at, confirmed_at
       ) VALUES ($1,$2,$3,$4,$5,'CONFIRMED',$6,$7,$8,$9,$10,NOW(),NOW()) RETURNING id`,
      [
        session.restaurantId, session.phone, session.deliveryAddress,
        session.specialInstructions || '', session.total,
        session.paymentMethod === 'online' ? 'PAID' : 'COD',
        session.paymentMethod,
        session.paymentGateway || 'cod',
        session.paymentId || null,
        session.gatewayOrderId || null
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
    console.log(`✅ Order #${orderId} saved (${session.paymentGateway})`);
    return orderId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { 
    client.release(); 
  }
}

async function notifyOwner(session, orderId) {
  try {
    const { rows } = await pool.query(
      'SELECT whatsapp_number, notify_on_order FROM restaurants WHERE id=$1',
      [session.restaurantId]
    );
    if (!rows[0] || rows[0].notify_on_order === false) return;
    
    const ownerWA = rows[0].whatsapp_number;
    if (!ownerWA) return;
    
    const gatewayName = session.paymentGateway === 'razorpay' ? 'Razorpay' :
                       session.paymentGateway === 'phonepe' ? 'PhonePe' :
                       session.paymentGateway === 'paytm' ? 'Paytm' : 'COD';
    
    const payLabel = session.paymentMethod === 'online' 
      ? `💳 ONLINE PAID (${gatewayName})` 
      : '💵 CASH ON DELIVERY';
    
    let m = `🔔 *NEW ORDER #${orderId}*\n\n🏪 ${session.restaurantName}\n📱 Customer: ${session.phone}\n📍 Address: ${session.deliveryAddress}\n\n🛒 *Items:*\n`;
    session.cart.forEach(i => { m += `• ${i.quantity}× ${i.name} — ₹${i.price * i.quantity}\n`; });
    m += `\n💰 *Total: ₹${session.total}*\n${payLabel}`;
    if (session.specialInstructions && session.specialInstructions.toLowerCase() !== 'no')
      m += `\n📝 Instructions: ${session.specialInstructions}`;
    m += `\n⏰ ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
    
    await sendMessage(ownerWA, m);
    console.log(`✅ Owner notified at ${ownerWA}`);
  } catch (e) { 
    console.error('❌ notifyOwner:', e.message); 
  }
}

async function logOrderToGoogleSheets(session, orderId) {
  try {
    if (!process.env.GOOGLE_APPS_SCRIPT_URL || !process.env.GOOGLE_APPS_SCRIPT_SECRET) {
      console.log('⏭️  Google Sheets logging skipped');
      return;
    }

    const orderData = {
      secret: process.env.GOOGLE_APPS_SCRIPT_SECRET,
      orderId: orderId,
      timestamp: new Date().toISOString(),
      restaurantName: session.restaurantName,
      customerPhone: session.phone,
      items: session.cart.map(item => ({
        name: item.name,
        quantity: item.quantity,
        price: item.price
      })),
      subtotal: session.subtotal,
      deliveryFee: session.deliveryFee,
      total: session.total,
      paymentMethod: session.paymentMethod,
      paymentGateway: session.paymentGateway || 'cod',
      paymentStatus: session.paymentMethod === 'online' ? 'PAID' : 'COD',
      deliveryAddress: session.deliveryAddress,
      specialInstructions: session.specialInstructions || 'None'
    };

    const response = await fetch(process.env.GOOGLE_APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderData)
    });

    const result = await response.json();
    if (result.success) {
      console.log(`✅ Order #${orderId} logged to Google Sheets`);
    }
  } catch (e) {
    console.error('❌ logOrderToGoogleSheets:', e.message);
  }
}

function buildOrderConfirmation(session, orderId) {
  const cart = session.cart.map((item, i) =>
    `${i+1}. ${item.name}\n   Qty: ${item.quantity} × ₹${item.price} = ₹${item.price * item.quantity}`
  ).join('\n\n');
  
  const gatewayName = session.paymentGateway === 'razorpay' ? 'Razorpay' :
                     session.paymentGateway === 'phonepe' ? 'PhonePe' :
                     session.paymentGateway === 'paytm' ? 'Paytm' : 'Cash';
  
  const pay = session.paymentMethod === 'online'
    ? `💳 Payment: Online (${gatewayName} - PAID)`
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
    // PRIORITY: Check for restaurant keyword FIRST
    // ═══════════════════════════════════════════════════════════
    const restaurant = restaurantCache.find(r =>
      r.qr_keyword && upper.includes(r.qr_keyword.toUpperCase())
    );
    
    if (restaurant) {
      const old = sessions.get(phone);
      if (old?.confirmTimeout) clearTimeout(old.confirmTimeout);
      const paymentTimeout = pendingPayments.get(phone);
      if (paymentTimeout) {
        clearTimeout(paymentTimeout);
        pendingPayments.delete(phone);
      }

      const canDeliver = restaurant.delivery_available !== false;
      const canBook    = restaurant.table_booking_available !== false;

      sessions.set(phone, {
        phone, state: S.SELECT_SERVICE,
        restaurantId: restaurant.id, 
        restaurantName: restaurant.name,
        deliveryFee:  restaurant.delivery_fee || 30,
        minOrder:     restaurant.min_delivery_amount || 0,
        canDeliver, canBook,
        createdAt: Date.now()
      });

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
        session.state = S.BOOKING_NAME; 
        session.serviceType = 'booking';
        sessions.set(phone, session);
        await sendMessage(phone, `📝 What's your name?\n\nPlease enter your full name for the booking.`);
        return res.status(200).send('OK');
      }
      
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
    // ADD_INSTRUCTIONS → CHOOSE_PAYMENT (Show 4 payment options)
    // ═══════════════════════════════════════════════════════════
    if (session.state === S.ADD_INSTRUCTIONS) {
      session.specialInstructions = text;
      session.state = S.CHOOSE_PAYMENT;
      sessions.set(phone, session);

      const lines = session.cart.map(i => `  ${i.quantity}× ${i.name} — ₹${i.price * i.quantity}`).join('\n');

      await sendMessage(phone,
        `💳 *Choose Payment Method*\n\n` +
        `🛒 *Your Order:*\n${lines}\n\n` +
        `Subtotal: ₹${session.subtotal}\n` +
        `Delivery Fee: ₹${session.deliveryFee}\n` +
        `💰 *Total: ₹${session.total}*\n\n` +
        `📍 Delivery: ${session.deliveryAddress}\n\n` +
        `Select payment method:\n\n` +
        `1️⃣ Razorpay\n` +
        `    💳 Cards, UPI, Wallets, NetBanking\n\n` +
        `2️⃣ PhonePe\n` +
        `    📱 PhonePe UPI & Wallet\n\n` +
        `3️⃣ Paytm\n` +
        `    💳 Paytm Wallet & UPI\n\n` +
        `4️⃣ Cash on Delivery (COD)\n` +
        `    💵 Pay when food arrives\n\n` +
        `Reply with *1*, *2*, *3*, or *4*`
      );
      return res.status(200).send('OK');
    }

    // ═══════════════════════════════════════════════════════════
    // CHOOSE_PAYMENT State Handler - MULTI-GATEWAY
    // ═══════════════════════════════════════════════════════════
    if (session.state === S.CHOOSE_PAYMENT) {
      // ─── Options 1, 2, 3: Online Payment Gateways ──────────────────────
      if (text === '1' || text === '2' || text === '3') {
        let gateway = null;
        if (text === '1') gateway = 'razorpay';
        if (text === '2') gateway = 'phonepe';
        if (text === '3') gateway = 'paytm';

        session.paymentMethod = 'online';
        session.paymentGateway = gateway;
        session.state = S.AWAITING_PAYMENT;
        sessions.set(phone, session);

        const orderData = {
          amount: session.total,
          restaurantName: session.restaurantName,
          phone: session.phone,
          customerName: session.customerName || 'Customer'
        };

        const paymentResult = await createPayment(gateway, orderData);

        if (!paymentResult.success) {
          session.state = S.CHOOSE_PAYMENT;
          sessions.set(phone, session);
          await sendMessage(phone, 
            `❌ ${gateway} payment unavailable.\n\n` +
            `Try:\n1️⃣ Razorpay\n2️⃣ PhonePe\n3️⃣ Paytm\n4️⃣ Cash on Delivery`
          );
          return res.status(200).send('OK');
        }

        session.paymentId = paymentResult.paymentId;
        session.paymentLink = paymentResult.paymentUrl;
        session.gatewayOrderId = paymentResult.orderId;
        sessions.set(phone, session);

        pendingPayments.set(phone, setTimeout(async () => {
          if (sessions.get(phone)?.state === S.AWAITING_PAYMENT) {
            sessions.delete(phone);
            await sendMessage(phone, '⏱️ Payment timeout. Type restaurant name to start over.');
          }
        }, 900000));

        const gatewayName = gateway === 'razorpay' ? 'Razorpay' :
                           gateway === 'phonepe' ? 'PhonePe' : 'Paytm';

        await sendMessage(phone,
          `💳 *${gatewayName} Payment*\n\n` +
          `Amount: ₹${session.total}\n\n` +
          `Click to pay securely:\n${paymentResult.paymentUrl}\n\n` +
          `After payment:\n` +
          `• Type *CHECK* to verify\n` +
          `• Type *CANCEL* to cancel\n\n` +
          `⏱️ Link expires in 15 minutes`
        );
        return res.status(200).send('OK');
      }

      // ─── Option 4: Cash on Delivery ────────────────────
      if (text === '4') {
        session.paymentMethod = 'cod';
        session.paymentGateway = 'cod';
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
          `⚠️ *IMPORTANT:*\n` +
          `✅ Pay ₹${session.total} in CASH\n` +
          `✅ Have exact change ready\n` +
          `✅ Be available at address\n\n` +
          `Type *CONFIRM* to place order\n` +
          `Type *CANCEL* to cancel\n\n` +
          `⏱️ You have 10 minutes`
        );
        return res.status(200).send('OK');
      }

      await sendMessage(phone, `❌ Invalid choice.\n\nReply *1*, *2*, *3*, or *4*`);
      return res.status(200).send('OK');
    }

    // ═══════════════════════════════════════════════════════════
    // AWAITING_PAYMENT - Multi-Gateway Verification
    // ═══════════════════════════════════════════════════════════
    if (session.state === S.AWAITING_PAYMENT) {
      if (upper === 'CHECK') {
        const result = await verifyPayment(session.paymentGateway, session.paymentId);

        if (result.success && result.verified) {
          const t = pendingPayments.get(phone);
          if (t) clearTimeout(t);
          pendingPayments.delete(phone);

          const orderId = await saveOrder(session);
          await notifyOwner(session, orderId);
          await logOrderToGoogleSheets(session, orderId);
          sessions.delete(phone);
          await sendMessage(phone, buildOrderConfirmation(session, orderId));
          return res.status(200).send('OK');
        }

        await sendMessage(phone, 
          `⏳ Payment not received yet.\n\n` +
          `Complete payment via the link, then type *CHECK* again.\n` +
          `Or type *CANCEL* to cancel.`
        );
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
        await logOrderToGoogleSheets(session, orderId);
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

    // ═══════════════════════════════════════════════════════════
    // BOOKING FLOW - TABLE BOOKING STATES
    // ═══════════════════════════════════════════════════════════
    
    // ─── BOOKING_NAME State ─────────────────
    if (session.state === S.BOOKING_NAME) {
      const customerName = text.trim();
      
      if (customerName.length < 2 || customerName.length > 50) {
        await sendMessage(phone, '❌ Please enter a valid name (2-50 characters)');
        return res.status(200).send('OK');
      }
      
      session.customerName = customerName;
      session.state = S.BOOKING_DATE;
      sessions.set(phone, session);
      
      await sendMessage(phone, 
        `✅ Thank you, ${customerName}!\n\n` +
        `📅 When would you like to book?\n\n` +
        `Type:\n• TODAY or TOMORROW\n• DD/MM/YYYY (e.g., 10/02/2026)`
      );
      return res.status(200).send('OK');
    }
    
    // ─── BOOKING_DATE State ─────────────────
    if (session.state === S.BOOKING_DATE) {
      let bookingDate = null;
      
      if (upper === 'TODAY') {
        bookingDate = new Date();
      } else if (upper === 'TOMORROW') {
        bookingDate = new Date();
        bookingDate.setDate(bookingDate.getDate() + 1);
      } else {
        // Try parsing DD/MM/YYYY or D/M/YYYY
        const dateMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (dateMatch) {
          const day = parseInt(dateMatch[1]);
          const month = parseInt(dateMatch[2]) - 1; // JS months are 0-indexed
          const year = parseInt(dateMatch[3]);
          bookingDate = new Date(year, month, day);
          
          // Validate date
          if (isNaN(bookingDate.getTime()) || 
              bookingDate.getDate() !== day || 
              bookingDate.getMonth() !== month) {
            await sendMessage(phone, '❌ Invalid date. Please use DD/MM/YYYY format (e.g., 10/02/2026)');
            return res.status(200).send('OK');
          }
        } else {
          await sendMessage(phone, '❌ Invalid format.\n\nType:\n• TODAY or TOMORROW\n• DD/MM/YYYY (e.g., 10/02/2026)');
          return res.status(200).send('OK');
        }
      }
      
      // Check if date is in the past
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (bookingDate < today) {
        await sendMessage(phone, '❌ Cannot book for past dates. Please select a current or future date.');
        return res.status(200).send('OK');
      }
      
      // Check if date is too far in future (e.g., max 30 days)
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + 30);
      if (bookingDate > maxDate) {
        await sendMessage(phone, '❌ Bookings can only be made up to 30 days in advance.');
        return res.status(200).send('OK');
      }
      
      session.bookingDate = bookingDate.toISOString().split('T')[0]; // Store as YYYY-MM-DD
      session.state = S.BOOKING_TIME;
      sessions.set(phone, session);
      
      const dateStr = bookingDate.toLocaleDateString('en-IN', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });
      
      await sendMessage(phone,
        `✅ Booking for: ${dateStr}\n\n` +
        `⏰ What time?\n\n` +
        `Type time in 24-hour format:\n` +
        `• 1800 (for 6:00 PM)\n` +
        `• 1930 (for 7:30 PM)\n` +
        `• 2015 (for 8:15 PM)\n\n` +
        `Or type: LUNCH or DINNER`
      );
      return res.status(200).send('OK');
    }
    
    // ─── BOOKING_TIME State ─────────────────
    if (session.state === S.BOOKING_TIME) {
      let bookingTime = null;
      
      if (upper === 'LUNCH') {
        bookingTime = '13:00';
      } else if (upper === 'DINNER') {
        bookingTime = '20:00';
      } else {
        // Parse 24-hour format (e.g., 1830, 1945)
        const timeMatch = text.match(/^(\d{2})(\d{2})$/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          
          if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
            await sendMessage(phone, '❌ Invalid time. Hours: 00-23, Minutes: 00-59\n\nExample: 1830 for 6:30 PM');
            return res.status(200).send('OK');
          }
          
          // Check restaurant operating hours (example: 11:00 - 23:00)
          if (hours < 11 || hours >= 23) {
            await sendMessage(phone, '⚠️ Restaurant is open 11:00 AM - 11:00 PM\n\nPlease select a time within operating hours.');
            return res.status(200).send('OK');
          }
          
          bookingTime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        } else {
          await sendMessage(phone, '❌ Invalid format.\n\nType:\n• 1830 (for 6:30 PM)\n• LUNCH or DINNER');
          return res.status(200).send('OK');
        }
      }
      
      session.bookingTime = bookingTime;
      session.state = S.BOOKING_GUESTS;
      sessions.set(phone, session);
      
      // Convert to 12-hour format for display
      const [h, m] = bookingTime.split(':').map(Number);
      const period = h >= 12 ? 'PM' : 'AM';
      const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
      const timeStr = `${displayHour}:${String(m).padStart(2, '0')} ${period}`;
      
      await sendMessage(phone,
        `✅ Time: ${timeStr}\n\n` +
        `👥 How many guests?\n\n` +
        `Type a number (1-20)`
      );
      return res.status(200).send('OK');
    }
    
    // ─── BOOKING_GUESTS State ───────────────
    if (session.state === S.BOOKING_GUESTS) {
      const guests = parseInt(text);
      
      if (isNaN(guests) || guests < 1 || guests > 20) {
        await sendMessage(phone, '❌ Please enter a number between 1 and 20');
        return res.status(200).send('OK');
      }
      
      session.numberOfGuests = guests;
      
      // Fetch all payment method settings for this restaurant
      const { rows } = await pool.query(
        `SELECT 
          booking_payment_required, 
          booking_fee_amount,
          payment_qr_enabled, qr_code_url, qr_code_description,
          payment_phonepe_enabled, phonepe_number, phonepe_name,
          payment_gpay_enabled, gpay_number, gpay_name,
          payment_paytm_enabled, paytm_number, paytm_name,
          payment_upi_enabled, upi_id, upi_name,
          payment_cod_enabled, cod_description
         FROM restaurants WHERE id = $1`,
        [session.restaurantId]
      );
      
      const restaurant = rows[0];
      
      if (!restaurant?.booking_payment_required || restaurant.booking_fee_amount <= 0) {
        // No payment required - go directly to confirmation
        session.state = S.BOOKING_CONFIRM;
        sessions.set(phone, session);
        
        const bookingDate = new Date(session.bookingDate);
        const dateStr = bookingDate.toLocaleDateString('en-IN', { 
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
        });
        
        const [h, m] = session.bookingTime.split(':').map(Number);
        const period = h >= 12 ? 'PM' : 'AM';
        const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
        const timeStr = `${displayHour}:${String(m).padStart(2, '0')} ${period}`;
        
        await sendMessage(phone,
          `📋 *CONFIRM YOUR BOOKING*\n\n` +
          `🏪 Restaurant: ${session.restaurantName}\n` +
          `👤 Name: ${session.customerName}\n` +
          `📅 Date: ${dateStr}\n` +
          `⏰ Time: ${timeStr}\n` +
          `👥 Guests: ${guests}\n\n` +
          `💵 Payment: No booking fee required\n\n` +
          `Type *CONFIRM* to complete booking\n` +
          `Type *CANCEL* to cancel`
        );
        return res.status(200).send('OK');
      }
      
      // Store payment settings in session
      session.bookingFeeAmount = restaurant.booking_fee_amount;
      session.paymentMethods = {
        qr: restaurant.payment_qr_enabled,
        phonepe: restaurant.payment_phonepe_enabled,
        gpay: restaurant.payment_gpay_enabled,
        paytm: restaurant.payment_paytm_enabled,
        upi: restaurant.payment_upi_enabled,
        cod: restaurant.payment_cod_enabled
      };
      session.paymentDetails = {
        qr: { url: restaurant.qr_code_url, desc: restaurant.qr_code_description },
        phonepe: { number: restaurant.phonepe_number, name: restaurant.phonepe_name },
        gpay: { number: restaurant.gpay_number, name: restaurant.gpay_name },
        paytm: { number: restaurant.paytm_number, name: restaurant.paytm_name },
        upi: { id: restaurant.upi_id, name: restaurant.upi_name },
        cod: { desc: restaurant.cod_description }
      };
      
      // Count enabled payment methods
      const enabled = Object.values(session.paymentMethods).filter(Boolean);
      
      if (enabled.length === 0) {
        // No payment methods configured - skip payment
        session.state = S.BOOKING_CONFIRM;
        sessions.set(phone, session);
        
        const bookingDate = new Date(session.bookingDate);
        const dateStr = bookingDate.toLocaleDateString('en-IN', { 
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
        });
        
        const [h, m] = session.bookingTime.split(':').map(Number);
        const period = h >= 12 ? 'PM' : 'AM';
        const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
        const timeStr = `${displayHour}:${String(m).padStart(2, '0')} ${period}`;
        
        await sendMessage(phone,
          `📋 *CONFIRM YOUR BOOKING*\n\n` +
          `🏪 Restaurant: ${session.restaurantName}\n` +
          `👤 Name: ${session.customerName}\n` +
          `📅 Date: ${dateStr}\n` +
          `⏰ Time: ${timeStr}\n` +
          `👥 Guests: ${guests}\n\n` +
          `⚠️ Payment methods not configured\n\n` +
          `Type *CONFIRM* to complete booking\n` +
          `Type *CANCEL* to cancel`
        );
        return res.status(200).send('OK');
      }
      
      // Show available payment methods
      session.state = S.BOOKING_SELECT_PAYMENT_METHOD;
      sessions.set(phone, session);
      
      let msg = `✅ ${guests} guests\n\n` +
        `💳 *BOOKING FEE: ₹${restaurant.booking_fee_amount}*\n\n` +
        `Select your payment method:\n\n`;
      
      let optionNum = 1;
      const optionMap = {};
      
      if (session.paymentMethods.qr) {
        msg += `${optionNum}️⃣ *QR Code* - Scan & Pay\n`;
        optionMap[optionNum.toString()] = 'qr';
        optionNum++;
      }
      if (session.paymentMethods.phonepe) {
        msg += `${optionNum}️⃣ *PhonePe* - Direct link\n`;
        optionMap[optionNum.toString()] = 'phonepe';
        optionNum++;
      }
      if (session.paymentMethods.gpay) {
        msg += `${optionNum}️⃣ *Google Pay* - Direct link\n`;
        optionMap[optionNum.toString()] = 'gpay';
        optionNum++;
      }
      if (session.paymentMethods.paytm) {
        msg += `${optionNum}️⃣ *Paytm* - Direct link\n`;
        optionMap[optionNum.toString()] = 'paytm';
        optionNum++;
      }
      if (session.paymentMethods.upi) {
        msg += `${optionNum}️⃣ *Any UPI App* - Manual UPI ID\n`;
        optionMap[optionNum.toString()] = 'upi';
        optionNum++;
      }
      if (session.paymentMethods.cod) {
        msg += `${optionNum}️⃣ *Pay at Restaurant* - COD\n`;
        optionMap[optionNum.toString()] = 'cod';
        optionNum++;
      }
      
      session.paymentOptionMap = optionMap;
      sessions.set(phone, session);
      
      msg += `\nReply with option number (1-${optionNum-1})`;
      
      await sendMessage(phone, msg);
      return res.status(200).send('OK');
    }
    
    // ─── BOOKING_SELECT_PAYMENT_METHOD State (UPDATED WITH CLICKABLE LINKS) ───
    if (session.state === S.BOOKING_SELECT_PAYMENT_METHOD) {
      const choice = text.trim();
      const selectedMethod = session.paymentOptionMap?.[choice];
      
      if (!selectedMethod) {
        await sendMessage(phone, `❌ Invalid choice. Please select a valid option number.`);
        return res.status(200).send('OK');
      }
      
      session.selectedPaymentMethod = selectedMethod;
      session.state = S.BOOKING_PAYMENT;
      
      // Generate temporary booking ID for payment link
      const tempBookingId = `BK${Date.now().toString().slice(-8)}`;
      session.tempBookingId = tempBookingId;
      sessions.set(phone, session);
      
      const amount = session.bookingFeeAmount;
      
      // Generate payment instructions based on selected method
      if (selectedMethod === 'phonepe') {
        const pp = session.paymentDetails.phonepe;
        const paymentUrl = `${process.env.BASE_URL}/pay/${session.restaurantId}/${tempBookingId}?amount=${amount}&upiId=${pp.number}@ybl&name=${encodeURIComponent(pp.name)}&method=phonepe`;
        
        await sendMessage(phone,
          `📱 *PhonePe Payment*\n\n` +
          `Amount: ₹${amount}\n` +
          `UPI ID: ${pp.number}@ybl\n` +
          `Name: ${pp.name}\n\n` +
          `🔗 *Click to Pay:*\n` +
          `${paymentUrl}\n\n` +
          `After payment, type:\n` +
          `*PAID* - to enter transaction ID`
        );
        
      } else if (selectedMethod === 'gpay') {
        const gp = session.paymentDetails.gpay;
        const paymentUrl = `${process.env.BASE_URL}/pay/${session.restaurantId}/${tempBookingId}?amount=${amount}&upiId=${gp.number}@okaxis&name=${encodeURIComponent(gp.name)}&method=gpay`;
        
        await sendMessage(phone,
          `📱 *Google Pay Payment*\n\n` +
          `Amount: ₹${amount}\n` +
          `UPI ID: ${gp.number}@okaxis\n` +
          `Name: ${gp.name}\n\n` +
          `🔗 *Click to Pay:*\n` +
          `${paymentUrl}\n\n` +
          `After payment, type:\n` +
          `*PAID* - to enter transaction ID`
        );
        
      } else if (selectedMethod === 'paytm') {
        const pt = session.paymentDetails.paytm;
        const paymentUrl = `${process.env.BASE_URL}/pay/${session.restaurantId}/${tempBookingId}?amount=${amount}&upiId=${pt.number}@paytm&name=${encodeURIComponent(pt.name)}&method=paytm`;
        
        await sendMessage(phone,
          `📱 *Paytm Payment*\n\n` +
          `Amount: ₹${amount}\n` +
          `UPI ID: ${pt.number}@paytm\n` +
          `Name: ${pt.name}\n\n` +
          `🔗 *Click to Pay:*\n` +
          `${paymentUrl}\n\n` +
          `After payment, type:\n` +
          `*PAID* - to enter transaction ID`
        );
        
      } else if (selectedMethod === 'upi') {
        const upi = session.paymentDetails.upi;
        const paymentUrl = `${process.env.BASE_URL}/pay/${session.restaurantId}/${tempBookingId}?amount=${amount}&upiId=${upi.id}&name=${encodeURIComponent(upi.name)}&method=upi`;
        
        await sendMessage(phone,
          `📱 *UPI Payment*\n\n` +
          `Amount: ₹${amount}\n` +
          `UPI ID: ${upi.id}\n` +
          `Name: ${upi.name}\n\n` +
          `🔗 *Click to Pay:*\n` +
          `${paymentUrl}\n\n` +
          `Or copy UPI ID: ${upi.id}\n\n` +
          `After payment, type:\n` +
          `*PAID* - to enter transaction ID`
        );
        
      } else if (selectedMethod === 'qr') {
        const qr = session.paymentDetails.qr;
        await sendMessage(phone,
          `📱 *QR Code Payment*\n\n` +
          `Amount: ₹${amount}\n\n` +
          `${qr.desc || 'Scan the QR code below to pay'}\n\n` +
          `QR Code: ${qr.url}\n\n` +
          `After payment, type:\n` +
          `*PAID* - to enter transaction ID\n` +
          `*SKIP* - to pay at restaurant`
        );
        
      } else if (selectedMethod === 'cod') {
        session.bookingFeePaid = false;
        session.paymentMethod = 'cod';
        session.paymentAppUsed = 'cod';
        session.state = S.BOOKING_CONFIRM;
        sessions.set(phone, session);
        
        const bookingDate = new Date(session.bookingDate);
        const dateStr = bookingDate.toLocaleDateString('en-IN', { 
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
        });
        
        const [h, m] = session.bookingTime.split(':').map(Number);
        const period = h >= 12 ? 'PM' : 'AM';
        const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
        const timeStr = `${displayHour}:${String(m).padStart(2, '0')} ${period}`;
        
        const codDesc = session.paymentDetails.cod.desc || `Pay ₹${amount} at restaurant`;
        
        await sendMessage(phone,
          `📋 *CONFIRM YOUR BOOKING*\n\n` +
          `🏪 Restaurant: ${session.restaurantName}\n` +
          `👤 Name: ${session.customerName}\n` +
          `📅 Date: ${dateStr}\n` +
          `⏰ Time: ${timeStr}\n` +
          `👥 Guests: ${session.numberOfGuests}\n\n` +
          `💵 Payment: ${codDesc}\n\n` +
          `Type *CONFIRM* to complete booking\n` +
          `Type *CANCEL* to cancel`
        );
      }
      
      return res.status(200).send('OK');
    }
    
    // ─── BOOKING_PAYMENT State ──────────────
    if (session.state === S.BOOKING_PAYMENT) {
      if (upper === 'PAID') {
        // Store which payment method was used
        session.paymentAppUsed = session.selectedPaymentMethod || 'upi';
        session.state = S.BOOKING_VERIFY_PAYMENT;
        sessions.set(phone, session);
        
        await sendMessage(phone,
          `✅ Payment confirmation received!\n\n` +
          `Please enter your Transaction ID\n` +
          `(Usually 10-12 digit number)\n\n` +
          `Example: 435623789012\n\n` +
          `Or type *SKIP* if you want to verify later`
        );
        return res.status(200).send('OK');
      }
      
      if (upper === 'SKIP') {
        session.bookingFeePaid = false;
        session.paymentMethod = 'pending';
        session.paymentAppUsed = session.selectedPaymentMethod || 'pending';
        session.state = S.BOOKING_CONFIRM;
        sessions.set(phone, session);
        
        const bookingDate = new Date(session.bookingDate);
        const dateStr = bookingDate.toLocaleDateString('en-IN', { 
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
        });
        
        const [h, m] = session.bookingTime.split(':').map(Number);
        const period = h >= 12 ? 'PM' : 'AM';
        const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
        const timeStr = `${displayHour}:${String(m).padStart(2, '0')} ${period}`;
        
        await sendMessage(phone,
          `⚠️ *Proceeding without payment confirmation*\n\n` +
          `📋 *CONFIRM YOUR BOOKING*\n\n` +
          `🏪 Restaurant: ${session.restaurantName}\n` +
          `👤 Name: ${session.customerName}\n` +
          `📅 Date: ${dateStr}\n` +
          `⏰ Time: ${timeStr}\n` +
          `👥 Guests: ${session.numberOfGuests}\n\n` +
          `💵 Payment: ₹${session.bookingFeeAmount} - Pay at restaurant\n\n` +
          `Type *CONFIRM* to complete booking\n` +
          `Type *CANCEL* to cancel`
        );
        return res.status(200).send('OK');
      }
      
      await sendMessage(phone,
        `Please type:\n` +
        `*PAID* - after making payment\n` +
        `*SKIP* - to pay at restaurant\n\n` +
        `Amount: ₹${session.bookingFeeAmount}`
      );
      return res.status(200).send('OK');
    }
    
    // ─── BOOKING_VERIFY_PAYMENT State ───────
    if (session.state === S.BOOKING_VERIFY_PAYMENT) {
      if (upper === 'SKIP') {
        session.bookingFeePaid = true;
        session.paymentMethod = session.selectedPaymentMethod || 'upi';
        session.paymentTransactionId = 'manual_verification_pending';
        session.state = S.BOOKING_CONFIRM;
        sessions.set(phone, session);
        
        const bookingDate = new Date(session.bookingDate);
        const dateStr = bookingDate.toLocaleDateString('en-IN', { 
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
        });
        
        const [h, m] = session.bookingTime.split(':').map(Number);
        const period = h >= 12 ? 'PM' : 'AM';
        const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
        const timeStr = `${displayHour}:${String(m).padStart(2, '0')} ${period}`;
        
        await sendMessage(phone,
          `📋 *CONFIRM YOUR BOOKING*\n\n` +
          `🏪 Restaurant: ${session.restaurantName}\n` +
          `👤 Name: ${session.customerName}\n` +
          `📅 Date: ${dateStr}\n` +
          `⏰ Time: ${timeStr}\n` +
          `👥 Guests: ${session.numberOfGuests}\n\n` +
          `💳 Payment: ₹${session.bookingFeeAmount} - Manual verification\n\n` +
          `Type *CONFIRM* to complete booking\n` +
          `Type *CANCEL* to cancel`
        );
        return res.status(200).send('OK');
      }
      
      // Validate transaction ID format
      const txnId = text.trim();
      if (txnId.length >= 10 && /^[0-9A-Za-z]+$/.test(txnId)) {
        session.bookingFeePaid = true;
        session.paymentMethod = session.selectedPaymentMethod || 'upi';
        session.paymentTransactionId = txnId;
        session.state = S.BOOKING_CONFIRM;
        sessions.set(phone, session);
        
        const bookingDate = new Date(session.bookingDate);
        const dateStr = bookingDate.toLocaleDateString('en-IN', { 
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
        });
        
        const [h, m] = session.bookingTime.split(':').map(Number);
        const period = h >= 12 ? 'PM' : 'AM';
        const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
        const timeStr = `${displayHour}:${String(m).padStart(2, '0')} ${period}`;
        
        const methodName = {
          'qr': 'QR Code',
          'phonepe': 'PhonePe',
          'gpay': 'Google Pay',
          'paytm': 'Paytm',
          'upi': 'UPI'
        }[session.selectedPaymentMethod] || 'UPI';
        
        await sendMessage(phone,
          `✅ Transaction ID recorded: ${txnId}\n\n` +
          `📋 *CONFIRM YOUR BOOKING*\n\n` +
          `🏪 Restaurant: ${session.restaurantName}\n` +
          `👤 Name: ${session.customerName}\n` +
          `📅 Date: ${dateStr}\n` +
          `⏰ Time: ${timeStr}\n` +
          `👥 Guests: ${session.numberOfGuests}\n\n` +
          `💳 Payment: ₹${session.bookingFeeAmount} PAID (${methodName})\n` +
          `Transaction ID: ${txnId}\n\n` +
          `Type *CONFIRM* to complete booking\n` +
          `Type *CANCEL* to cancel`
        );
        return res.status(200).send('OK');
      }
      
      await sendMessage(phone,
        `❌ Invalid transaction ID format\n\n` +
        `Please enter a valid Transaction ID (10+ characters)\n` +
        `Example: 435623789012\n\n` +
        `Or type *SKIP* to verify later`
      );
      return res.status(200).send('OK');
    }
    
    // ─── BOOKING_CONFIRM State ──────────────
    if (session.state === S.BOOKING_CONFIRM) {
      if (upper === 'CONFIRM') {
        try {
          // Save booking to database with payment information
          const result = await pool.query(
            `INSERT INTO table_bookings 
             (restaurant_id, customer_phone, customer_name, booking_date, booking_time, 
              number_of_guests, booking_fee_paid, payment_method, payment_transaction_id, 
              payment_app_used, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'CONFIRMED', NOW())
             RETURNING id`,
            [
              session.restaurantId, 
              session.phone, 
              session.customerName, 
              session.bookingDate, 
              session.bookingTime, 
              session.numberOfGuests,
              session.bookingFeePaid || false,
              session.paymentMethod || null,
              session.paymentTransactionId || null,
              session.paymentAppUsed || null
            ]
          );
          
          const bookingId = result.rows[0].id;
          
          // Format confirmation message
          const bookingDate = new Date(session.bookingDate);
          const dateStr = bookingDate.toLocaleDateString('en-IN', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          });
          
          const [h, m] = session.bookingTime.split(':').map(Number);
          const period = h >= 12 ? 'PM' : 'AM';
          const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
          const timeStr = `${displayHour}:${String(m).padStart(2, '0')} ${period}`;
          
          // Prepare payment status message
          let paymentStatusMsg = '';
          if (session.bookingFeeAmount && session.bookingFeeAmount > 0) {
            if (session.bookingFeePaid) {
              paymentStatusMsg = `\n💳 Booking Fee: ₹${session.bookingFeeAmount} - PAID\n`;
              if (session.paymentTransactionId && session.paymentTransactionId !== 'manual_verification_pending') {
                paymentStatusMsg += `Transaction ID: ${session.paymentTransactionId}\n`;
              }
            } else {
              paymentStatusMsg = `\n💵 Booking Fee: ₹${session.bookingFeeAmount} - Pay at restaurant\n`;
            }
          }
          
          // Notify restaurant owner
          try {
            const { rows } = await pool.query(
              'SELECT whatsapp_number FROM restaurants WHERE id = $1',
              [session.restaurantId]
            );
            
            if (rows[0]?.whatsapp_number) {
              let ownerPaymentMsg = '';
              if (session.bookingFeeAmount && session.bookingFeeAmount > 0) {
                if (session.bookingFeePaid) {
                  ownerPaymentMsg = `💳 Booking Fee: ₹${session.bookingFeeAmount} - PAID\n`;
                  if (session.paymentTransactionId && session.paymentTransactionId !== 'manual_verification_pending') {
                    ownerPaymentMsg += `   Transaction: ${session.paymentTransactionId}\n`;
                  } else {
                    ownerPaymentMsg += `   ⚠️ Manual verification required\n`;
                  }
                } else {
                  ownerPaymentMsg = `💵 Booking Fee: ₹${session.bookingFeeAmount} - PENDING\n`;
                }
              }
              
              await sendMessage(rows[0].whatsapp_number,
                `🔔 *NEW TABLE BOOKING #${bookingId}*\n\n` +
                `🏪 ${session.restaurantName}\n` +
                `👤 Name: ${session.customerName}\n` +
                `📱 Phone: ${session.phone}\n` +
                `📅 Date: ${dateStr}\n` +
                `⏰ Time: ${timeStr}\n` +
                `👥 Guests: ${session.numberOfGuests}\n` +
                ownerPaymentMsg + `\n` +
                `⏰ ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
              );
              console.log(`✅ Owner notified of booking #${bookingId}`);
            }
          } catch (e) {
            console.error('❌ Failed to notify owner:', e.message);
          }
          
          // Send confirmation to customer
          await sendMessage(phone,
            `🎉 *Booking Confirmed!*\n\n` +
            `Booking ID: #${bookingId}\n` +
            `Name: ${session.customerName}\n` +
            `Restaurant: ${session.restaurantName}\n\n` +
            `📅 Date: ${dateStr}\n` +
            `⏰ Time: ${timeStr}\n` +
            `👥 Guests: ${session.numberOfGuests}` +
            paymentStatusMsg + `\n` +
            `✅ Your table is reserved!\n\n` +
            `Please arrive on time. If you need to cancel or modify, contact the restaurant directly.\n\n` +
            `Thank you! 🍽️`
          );
          
          console.log(`✅ Booking #${bookingId} confirmed for ${session.phone} (Payment: ${session.bookingFeePaid ? 'PAID' : 'PENDING'})`);
          sessions.delete(phone);
          return res.status(200).send('OK');
          
        } catch (e) {
          console.error('❌ Booking save failed:', e.message);
          await sendMessage(phone, '❌ Failed to save booking. Please try again or contact the restaurant.');
          return res.status(200).send('OK');
        }
      }
      
      if (upper === 'CANCEL') {
        sessions.delete(phone);
        await sendMessage(phone, '❌ Booking cancelled. Type restaurant name to start over.');
        return res.status(200).send('OK');
      }
      
      await sendMessage(phone, 'Type *CONFIRM* to complete booking or *CANCEL* to cancel');
      return res.status(200).send('OK');
    }

    await sendMessage(phone, '❌ Something went wrong. Type restaurant name to restart.');
    return res.status(200).send('OK');

  } catch (e) { 
    console.error('❌ Webhook:', e); 
    res.status(500).send('Error'); 
  }
});

// ════════════════════════════════════════════
// PAYMENT WEBHOOKS & CALLBACKS
// ════════════════════════════════════════════

// ─── Razorpay Webhook ────────────────────────
app.post('/payment/razorpay/webhook', async (req, res) => {
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
      
      const orderId = await saveOrder(session);
      await notifyOwner(session, orderId);
      await logOrderToGoogleSheets(session, orderId);
      await sendMessage(phone, buildOrderConfirmation(session, orderId));
      sessions.delete(phone);
    }
    res.status(200).send('OK');
  } catch (e) {
    console.error('❌ Razorpay webhook:', e.message);
    res.status(500).send('Error');
  }
});

app.get('/payment/razorpay/callback', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Payment Success</title>
<style>body{font-family:Arial;text-align:center;padding:60px;background:#f0faf0}.ck{font-size:80px}h1{color:#2e7d32}p{color:#555;font-size:18px}</style></head>
<body><div class="ck">✅</div><h1>Payment Successful!</h1>
<p>Return to WhatsApp and type <b>CHECK</b> to confirm your order.</p></body></html>`);
});

// ─── PhonePe Webhook ─────────────────────────
app.post('/payment/phonepe/webhook', async (req, res) => {
  try {
    const response = req.body.response;
    if (!response) return res.status(400).send('No response');

    const decodedResponse = Buffer.from(response, 'base64').toString('utf-8');
    const data = JSON.parse(decodedResponse);

    if (data.success && data.code === 'PAYMENT_SUCCESS') {
      const merchantTransactionId = data.data.merchantTransactionId;
      
      let phone = null;
      for (const [p, s] of sessions) {
        if (s.paymentId === merchantTransactionId) {
          phone = p;
          break;
        }
      }
      
      if (phone) {
        const session = sessions.get(phone);
        const t = pendingPayments.get(phone);
        if (t) clearTimeout(t);
        pendingPayments.delete(phone);
        
        const orderId = await saveOrder(session);
        await notifyOwner(session, orderId);
        await logOrderToGoogleSheets(session, orderId);
        await sendMessage(phone, buildOrderConfirmation(session, orderId));
        sessions.delete(phone);
      }
    }
    res.status(200).send('OK');
  } catch (e) {
    console.error('❌ PhonePe webhook:', e.message);
    res.status(500).send('Error');
  }
});

app.get('/payment/phonepe/callback', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Payment Success</title>
<style>body{font-family:Arial;text-align:center;padding:60px;background:#f0faf0}.ck{font-size:80px}h1{color:#2e7d32}p{color:#555;font-size:18px}</style></head>
<body><div class="ck">✅</div><h1>Payment Successful!</h1>
<p>Return to WhatsApp and type <b>CHECK</b> to confirm your order.</p></body></html>`);
});

// ─── Paytm Webhook ───────────────────────────
app.post('/payment/paytm/callback', async (req, res) => {
  try {
    const PaytmChecksum = require('paytmchecksum');
    const paytmParams = {};
    
    for (let key in req.body) {
      if (key !== 'CHECKSUMHASH') {
        paytmParams[key] = req.body[key];
      }
    }

    const checksumHash = req.body.CHECKSUMHASH;
    const isValidChecksum = PaytmChecksum.verifySignature(
      paytmParams,
      process.env.PAYTM_MERCHANT_KEY,
      checksumHash
    );

    if (isValidChecksum && req.body.STATUS === 'TXN_SUCCESS') {
      const orderId = req.body.ORDERID;
      
      let phone = null;
      for (const [p, s] of sessions) {
        if (s.paymentId === orderId) {
          phone = p;
          break;
        }
      }
      
      if (phone) {
        const session = sessions.get(phone);
        const t = pendingPayments.get(phone);
        if (t) clearTimeout(t);
        pendingPayments.delete(phone);
        
        const dbOrderId = await saveOrder(session);
        await notifyOwner(session, dbOrderId);
        await logOrderToGoogleSheets(session, dbOrderId);
        await sendMessage(phone, buildOrderConfirmation(session, dbOrderId));
        sessions.delete(phone);
      }
    }
    
    res.send(`<!DOCTYPE html><html><head><title>Payment Success</title>
<style>body{font-family:Arial;text-align:center;padding:60px;background:#f0faf0}.ck{font-size:80px}h1{color:#2e7d32}p{color:#555;font-size:18px}</style></head>
<body><div class="ck">✅</div><h1>Payment Successful!</h1>
<p>Return to WhatsApp and type <b>CHECK</b> to confirm your order.</p></body></html>`);
  } catch (e) {
    console.error('❌ Paytm callback:', e.message);
    res.status(500).send('Error');
  }
});

// ════════════════════════════════════════════
// API ENDPOINTS
// ════════════════════════════════════════════

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status:'OK',
      database:'Connected',
      sessions: sessions.size,
      restaurants: restaurantCache.length,
      testMode: TEST_MODE,
      version: '6.1-CLICKABLE-PAYMENT-LINKS',
      paymentGateways: {
        razorpay: process.env.RAZORPAY_KEY_ID ? 'Configured' : 'Not set',
        phonepe: process.env.PHONEPE_MERCHANT_ID ? 'Configured' : 'Not set',
        paytm: process.env.PAYTM_MERCHANT_ID ? 'Configured' : 'Not set'
      },
      googleSheets: process.env.GOOGLE_APPS_SCRIPT_URL ? 'Enabled' : 'Not configured'
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
    cartSize: s.cart?.length||0,
    paymentGateway: s.paymentGateway
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
    res.json({ success: true, paymentId: s.paymentId, gateway: s.paymentGateway });
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
║   🍽️  RESTAURANT WHATSAPP BOT v6.1           ║
║   ✅ Clickable Payment Links                 ║
║   ✅ Table Booking System                    ║
╠═══════════════════════════════════════════════╣
║  Port:           ${String(PORT).padEnd(28)}║
║  Test Mode:      ${String(TEST_MODE ? '🧪 ON' : '🚀 OFF').padEnd(28)}║
║  Database:       ${String(dbConnected ? '✅ Connected' : '❌ Disconnected').padEnd(28)}║
║  Restaurants:    ${String(restaurantCache.length).padEnd(28)}║
╠═══════════════════════════════════════════════╣
║  💳 PAYMENT GATEWAYS                          ║
║  1️⃣ Razorpay:    ${String(process.env.RAZORPAY_KEY_ID ? '✅ Configured' : '⚠️  Not set').padEnd(28)}║
║  2️⃣ PhonePe:     ${String(process.env.PHONEPE_MERCHANT_ID ? '✅ Configured' : '⚠️  Not set').padEnd(28)}║
║  3️⃣ Paytm:       ${String(process.env.PAYTM_MERCHANT_ID ? '✅ Configured' : '⚠️  Not set').padEnd(28)}║
║  4️⃣ COD:         ✅ Always available          ║
╠═══════════════════════════════════════════════╣
║  📅 TABLE BOOKING PAYMENTS                    ║
║     ✅ PhonePe - Clickable Links              ║
║     ✅ Google Pay - Clickable Links           ║
║     ✅ Paytm - Clickable Links                ║
║     ✅ Generic UPI - Clickable Links          ║
║     ✅ QR Code Payment                        ║
║     ✅ Pay at Restaurant (COD)                ║
╠═══════════════════════════════════════════════╣
║  📊 Google Sheets:                            ║
║     ${String(process.env.GOOGLE_APPS_SCRIPT_URL ? '✅ Enabled' : '⚠️  Not configured').padEnd(42)}║
╚═══════════════════════════════════════════════╝
      `);
    });
  } catch (e) {
    console.error('❌ Startup failed:', e);
    process.exit(1);
  }
}

startServer();
