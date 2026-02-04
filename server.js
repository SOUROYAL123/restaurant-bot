// ============================================
// RESTAURANT WHATSAPP BOT v8.0 - COMPLETE
// Multi-Restaurant | COD | Real-time Menu Management
// Instant Menu Updates via WhatsApp/Web/API
// ============================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const TEST_MODE = process.env.TEST_MODE === 'true';

// ═══════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.set('trust proxy', true);
app.use(express.static('public'));

// ═══════════════════════════════════════════════════════
// TWILIO SETUP
// ═══════════════════════════════════════════════════════
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const wabaNumber = process.env.WABA_NUMBER;

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

// ═══════════════════════════════════════════════════════
// DATABASE POOL
// ═══════════════════════════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false, require: true },
  connectionTimeoutMillis: 10000,
  max: 10,
  min: 0,
  idleTimeoutMillis: 5000,
  statement_timeout: 30000
});

let dbConnected = false;
pool.on('connect', () => { dbConnected = true; });
pool.on('error', (e) => {
  console.warn('⚠️  Pool idle connection terminated:', e.message);
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
  console.error('❌ FATAL: DB connection failed');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════
// IN-MEMORY STORES
// ═══════════════════════════════════════════════════════
const sessions = new Map();
const testMessages = new Map();

// Session cleanup (30 min timeout)
setInterval(() => {
  const now = Date.now();
  for (const [phone, s] of sessions) {
    if (now - s.createdAt > 1800000) {
      if (s.confirmTimeout) clearTimeout(s.confirmTimeout);
      sessions.delete(phone);
    }
  }
}, 300000);

// ═══════════════════════════════════════════════════════
// RESTAURANT CACHE
// ═══════════════════════════════════════════════════════
let restaurantCache = [];
let menuCache = new Map();
let lastCacheUpdate = 0;
const CACHE_TTL = 300000; // 5 minutes

// ═══════════════════════════════════════════════════════
// STATES
// ═══════════════════════════════════════════════════════
const S = {
  SELECT_SERVICE: 'SELECT_SERVICE',
  BROWSE_MENU: 'BROWSE_MENU',
  ADD_ADDRESS: 'ADD_ADDRESS',
  ADD_INSTRUCTIONS: 'ADD_INSTRUCTIONS',
  CONFIRM_ORDER: 'CONFIRM_ORDER',
  BOOKING_DATE: 'BOOKING_DATE',
  BOOKING_TIME: 'BOOKING_TIME',
  BOOKING_GUESTS: 'BOOKING_GUESTS',
  BOOKING_CONFIRM: 'BOOKING_CONFIRM'
};

// ═══════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════

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
    restaurantCache = hasActive ? rows.filter(r => r.active !== false) : rows;
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

async function getMenuItems(restaurantId, forceRefresh = false) {
  if (!forceRefresh && menuCache.has(restaurantId)) {
    const cached = menuCache.get(restaurantId);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.items;
    }
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, price, category, is_vegetarian, 
              COALESCE(available, is_available, true) as available
       FROM menu_items 
       WHERE restaurant_id = $1 
       ORDER BY category, name`,
      [restaurantId]
    );
    
    // Filter only available items
    const filtered = rows.filter(r => r.available !== false);
    
    // Cache the results
    menuCache.set(restaurantId, {
      items: filtered,
      timestamp: Date.now()
    });
    
    return filtered;
  } catch (e) {
    console.error('❌ getMenuItems:', e.message);
    return menuCache.has(restaurantId) ? menuCache.get(restaurantId).items : [];
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
    const t = item.price * item.quantity;
    sub += t;
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
       ) VALUES ($1,$2,$3,$4,$5,'CONFIRMED','COD','cod',NOW(),NOW()) RETURNING id`,
      [
        session.restaurantId, session.phone, session.deliveryAddress,
        session.specialInstructions || '', session.total
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
    console.log(`✅ Order #${orderId} saved (COD)`);
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

    let m = `🔔 *NEW ORDER #${orderId}*\n\n🏪 ${session.restaurantName}\n📱 Customer: ${session.phone}\n📍 Address: ${session.deliveryAddress}\n\n🛒 *Items:*\n`;
    session.cart.forEach(i => { m += `• ${i.quantity}× ${i.name} — ₹${i.price * i.quantity}\n`; });
    m += `\n💰 *Total: ₹${session.total}*\n💵 CASH ON DELIVERY`;
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
      paymentMethod: 'cod',
      paymentStatus: 'COD',
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
    `${i + 1}. ${item.name}\n   Qty: ${item.quantity} × ₹${item.price} = ₹${item.price * item.quantity}`
  ).join('\n\n');

  return (
    `🎉 *Order Confirmed!*\n\n` +
    `Order ID: #${orderId}\n` +
    `Restaurant: ${session.restaurantName}\n\n` +
    `🛒 Your Cart:\n${cart}\n\n` +
    `Subtotal: ₹${session.subtotal}\n` +
    `Delivery Fee: ₹${session.deliveryFee}\n` +
    `*Total: ₹${session.total}*\n\n` +
    `📍 Delivery Address:\n${session.deliveryAddress}\n\n` +
    `💵 *Payment: CASH ON DELIVERY*\n` +
    `💰 Please keep ₹${session.total} ready in cash\n\n` +
    `⏱️ Estimated Delivery: 45 minutes\n\n` +
    `The restaurant has been notified and is preparing your food.\n\n` +
    `Thank you for your order! 🍽️\n\n` +
    `Scan QR code to place another order.`
  );
}

// ═══════════════════════════════════════════════════════
// OWNER MENU MANAGEMENT FUNCTIONS
// ═══════════════════════════════════════════════════════

async function isRestaurantOwner(phone) {
  try {
    const result = await pool.query(
      'SELECT id, name, owner_api_key FROM restaurants WHERE whatsapp_number = $1',
      [phone]
    );

    if (result.rows.length > 0) {
      return {
        isOwner: true,
        restaurantId: result.rows[0].id,
        restaurantName: result.rows[0].name,
        apiKey: result.rows[0].owner_api_key
      };
    }

    return { isOwner: false };
  } catch (error) {
    console.error('Owner check error:', error);
    return { isOwner: false };
  }
}

async function processOwnerCommand(phone, text, ownerInfo) {
  try {
    const upper = text.toUpperCase().trim();
    const restaurantId = ownerInfo.restaurantId;

    // Command: MENU or STATUS
    if (upper === 'MENU' || upper === 'STATUS') {
      const items = await pool.query(
        `SELECT id, name, category, price, 
                COALESCE(available, is_available, true) as available
         FROM menu_items
         WHERE restaurant_id = $1
         ORDER BY category, name`,
        [restaurantId]
      );

      if (items.rows.length === 0) {
        return '❌ No menu items found';
      }

      let msg = `📋 *MENU STATUS - ${ownerInfo.restaurantName}*\n\n`;
      
      const available = items.rows.filter(i => i.available !== false);
      const unavailable = items.rows.filter(i => i.available === false);
      
      msg += `✅ Available: ${available.length}\n`;
      msg += `❌ Out of Stock: ${unavailable.length}\n\n`;
      
      const grouped = {};
      items.rows.forEach(i => {
        (grouped[i.category] = grouped[i.category] || []).push(i);
      });

      Object.keys(grouped).sort().forEach(cat => {
        msg += `*${cat}*\n`;
        grouped[cat].forEach(item => {
          const status = item.available !== false ? '✅' : '❌';
          msg += `${status} ${item.id}. ${item.name} - ₹${item.price}\n`;
        });
        msg += '\n';
      });

      msg += `💡 *Commands:*\n`;
      msg += `OUT [id] - Mark unavailable\n`;
      msg += `IN [id] - Mark available\n`;
      msg += `STOCK [id] - Toggle availability\n`;
      msg += `MENU - View this status`;

      return msg;
    }

    // Command: OUT [item_id]
    const outMatch = upper.match(/^(OUT|UNAVAILABLE)\s+(\d+)$/);
    if (outMatch) {
      const itemId = parseInt(outMatch[2]);

      const result = await pool.query(
        `UPDATE menu_items 
         SET available = false, is_available = false
         WHERE id = $1 AND restaurant_id = $2
         RETURNING name`,
        [itemId, restaurantId]
      );

      if (result.rows.length > 0) {
        menuCache.delete(restaurantId);
        return `❌ *${result.rows[0].name}* marked as OUT OF STOCK\n\nCustomers will no longer see this item.`;
      }
      return `❌ Item #${itemId} not found`;
    }

    // Command: IN [item_id]
    const inMatch = upper.match(/^(IN|AVAILABLE)\s+(\d+)$/);
    if (inMatch) {
      const itemId = parseInt(inMatch[2]);

      const result = await pool.query(
        `UPDATE menu_items 
         SET available = true, is_available = true
         WHERE id = $1 AND restaurant_id = $2
         RETURNING name`,
        [itemId, restaurantId]
      );

      if (result.rows.length > 0) {
        menuCache.delete(restaurantId);
        return `✅ *${result.rows[0].name}* marked as AVAILABLE\n\nCustomers can now order this item.`;
      }
      return `❌ Item #${itemId} not found`;
    }

    // Command: STOCK [item_id]
    const stockMatch = upper.match(/^STOCK\s+(\d+)$/);
    if (stockMatch) {
      const itemId = parseInt(stockMatch[1]);

      const result = await pool.query(
        `UPDATE menu_items 
         SET available = NOT COALESCE(available, true),
             is_available = NOT COALESCE(is_available, true)
         WHERE id = $1 AND restaurant_id = $2
         RETURNING name, COALESCE(available, is_available, true) as available`,
        [itemId, restaurantId]
      );

      if (result.rows.length > 0) {
        menuCache.delete(restaurantId);
        const item = result.rows[0];
        const status = item.available ? '✅ AVAILABLE' : '❌ OUT OF STOCK';
        return `${item.available ? '✅' : '❌'} *${item.name}* toggled to ${status}`;
      }
      return `❌ Item #${itemId} not found`;
    }

    // Command: HELP
    if (upper === 'HELP' || upper === 'COMMANDS') {
      return (
        `🔧 *OWNER COMMANDS*\n\n` +
        `📋 *View Menu:*\n` +
        `  MENU or STATUS\n\n` +
        `❌ *Mark Unavailable:*\n` +
        `  OUT [id]\n` +
        `  Example: OUT 15\n\n` +
        `✅ *Mark Available:*\n` +
        `  IN [id]\n` +
        `  Example: IN 15\n\n` +
        `🔄 *Toggle Status:*\n` +
        `  STOCK [id]\n` +
        `  Example: STOCK 15\n\n` +
        `💡 Changes are instant!`
      );
    }

    return null;

  } catch (error) {
    console.error('Owner command error:', error);
    return '❌ Error processing command';
  }
}

// ═══════════════════════════════════════════════════════
// MENU MANAGEMENT API ENDPOINTS
// ═══════════════════════════════════════════════════════

app.post('/api/menu/toggle/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { restaurantId, ownerKey } = req.body;

    console.log(`🔄 Toggle: Item ${itemId}, Restaurant ${restaurantId}`);

    const restaurant = await pool.query(
      'SELECT owner_api_key, name FROM restaurants WHERE id = $1',
      [restaurantId]
    );

    if (!restaurant.rows[0] || restaurant.rows[0].owner_api_key !== ownerKey) {
      console.log('❌ Auth failed');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await pool.query(
      `UPDATE menu_items 
       SET available = NOT COALESCE(available, true),
           is_available = NOT COALESCE(is_available, true)
       WHERE id = $1 AND restaurant_id = $2
       RETURNING id, name, COALESCE(available, is_available, true) as available`,
      [itemId, restaurantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = result.rows[0];
    menuCache.delete(restaurantId);
    
    console.log(`✅ ${item.name}: ${item.available ? 'AVAILABLE' : 'OUT'}`);

    res.json({
      success: true,
      itemId: item.id,
      itemName: item.name,
      available: item.available,
      status: item.available ? 'Available' : 'Out of Stock'
    });

  } catch (error) {
    console.error('❌ Toggle error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/menu/status/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurant = await pool.query(
      'SELECT name FROM restaurants WHERE id = $1',
      [restaurantId]
    );

    if (restaurant.rows.length === 0) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const items = await pool.query(
      `SELECT id, name, category, price, is_vegetarian,
              COALESCE(available, is_available, true) as available
       FROM menu_items
       WHERE restaurant_id = $1
       ORDER BY category, name`,
      [restaurantId]
    );

    const available = items.rows.filter(i => i.available !== false).length;
    const unavailable = items.rows.filter(i => i.available === false).length;

    res.json({
      success: true,
      restaurantName: restaurant.rows[0].name,
      total: items.rows.length,
      available,
      unavailable,
      items: items.rows
    });

  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/menu/bulk-update', async (req, res) => {
  try {
    const { restaurantId, ownerKey, itemIds, available } = req.body;

    const restaurant = await pool.query(
      'SELECT owner_api_key, name FROM restaurants WHERE id = $1',
      [restaurantId]
    );

    if (!restaurant.rows[0] || restaurant.rows[0].owner_api_key !== ownerKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await pool.query(
      `UPDATE menu_items 
       SET available = $1, is_available = $1
       WHERE id = ANY($2) AND restaurant_id = $3
       RETURNING id, name`,
      [available, itemIds, restaurantId]
    );

    menuCache.delete(restaurantId);

    console.log(`✅ ${result.rows.length} items updated for ${restaurant.rows[0].name}`);

    res.json({
      success: true,
      updated: result.rows.length,
      items: result.rows
    });

  } catch (error) {
    console.error('Bulk update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════
// MAIN WEBHOOK
// ═══════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  try {
    const { From, Body } = req.body;
    if (!From || !Body) return res.status(400).send('Missing params');

    const phone = From.replace('whatsapp:', '');
    const text = Body.trim();
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

    // Check if user is restaurant owner
    const ownerInfo = await isRestaurantOwner(phone);
    
    if (ownerInfo.isOwner) {
      const ownerResponse = await processOwnerCommand(phone, text, ownerInfo);
      
      if (ownerResponse) {
        await sendMessage(phone, ownerResponse);
        console.log(`✅ Owner command processed for ${ownerInfo.restaurantName}`);
        return res.status(200).send('OK');
      }
    }

    // Check for restaurant keyword
    const restaurant = restaurantCache.find(r =>
      r.qr_keyword && upper.includes(r.qr_keyword.toUpperCase())
    );

    if (restaurant) {
      const old = sessions.get(phone);
      if (old?.confirmTimeout) clearTimeout(old.confirmTimeout);

      const canDeliver = restaurant.delivery_available !== false;
      const canBook = restaurant.table_booking_available !== false;

      sessions.set(phone, {
        phone, state: S.SELECT_SERVICE,
        restaurantId: restaurant.id,
        restaurantName: restaurant.name,
        deliveryFee: restaurant.delivery_fee || 30,
        minOrder: restaurant.min_delivery_amount || 0,
        canDeliver, canBook,
        createdAt: Date.now()
      });

      let options = '', idx = 0;
      if (canDeliver) { idx++; options += `${idx}️⃣ Order Delivery\n`; }
      if (canBook) { idx++; options += `${idx}️⃣ Book a Table\n`; }

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
      const isGreeting = ['hi', 'hello', 'hey', 'start', 'menu', 'help'].some(w => text.toLowerCase().includes(w));
      await sendMessage(phone, isGreeting
        ? `👋 *Welcome!*\n\nScan the QR code to start ordering!`
        : `👋 Scan the QR code to start ordering!`
      );
      return res.status(200).send('OK');
    }

    // STATE MACHINE
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
        
        if (session.menuItems.length === 0) {
          await sendMessage(phone, '⚠️ Menu is currently unavailable. Please try again later.');
          sessions.delete(phone);
          return res.status(200).send('OK');
        }
        
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
        const sub = session.cart.reduce((s, i) => s + i.price * i.quantity, 0);
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
          await sendMessage(phone, `❌ Item #${id} not found or unavailable.`);
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

    if (session.state === S.ADD_INSTRUCTIONS) {
      session.specialInstructions = text;
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

    await sendMessage(phone, '❌ Something went wrong. Type restaurant name to restart.');
    return res.status(200).send('OK');

  } catch (e) {
    console.error('❌ Webhook:', e);
    res.status(500).send('Error');
  }
});

// ═══════════════════════════════════════════════════════
// STANDARD API ENDPOINTS
// ═══════════════════════════════════════════════════════

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'OK',
      database: 'Connected',
      sessions: sessions.size,
      restaurants: restaurantCache.length,
      menuCacheSize: menuCache.size,
      testMode: TEST_MODE,
      version: '8.0-MENU-MANAGEMENT',
      features: {
        payment: 'Cash on Delivery Only',
        menuUpdates: 'Real-time via WhatsApp/API/Web',
        googleSheets: process.env.GOOGLE_APPS_SCRIPT_URL ? 'Enabled' : 'Not configured'
      }
    });
  } catch {
    res.status(503).json({ status: 'ERROR', database: 'Disconnected' });
  }
});

app.get('/restaurants', async (req, res) => {
  await loadRestaurants(true);
  res.json({ count: restaurantCache.length, restaurants: restaurantCache });
});

app.get('/menu/:restaurantId', async (req, res) => {
  const items = await getMenuItems(parseInt(req.params.restaurantId), true);
  res.json({ restaurantId: req.params.restaurantId, items });
});

app.get('/test-session/:phone', (req, res) => {
  const s = sessions.get(req.params.phone);
  res.json(s ? {
    found: true,
    state: s.state,
    restaurantName: s.restaurantName,
    cartSize: s.cart?.length || 0
  } : { found: false });
});

app.post('/admin/clear-sessions', (req, res) => {
  if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });
  sessions.forEach(s => { if (s.confirmTimeout) clearTimeout(s.confirmTimeout); });
  sessions.clear();
  res.json({ cleared: true });
});

app.post('/reload-cache', async (req, res) => {
  await loadRestaurants(true);
  menuCache.clear();
  res.json({
    reloaded: true,
    restaurantCount: restaurantCache.length,
    menuCacheCleared: true
  });
});

app.get('/test/messages/:phone', (req, res) => {
  const msgs = testMessages.get(req.params.phone) || [];
  testMessages.delete(req.params.phone);
  res.json({ messages: msgs });
});

app.get('/menu-updater', (req, res) => {
  res.sendFile(path.join(__dirname, 'menu-updater.html'));
});

// ═══════════════════════════════════════════════════════
// ERROR HANDLERS
// ═══════════════════════════════════════════════════════
process.on('uncaughtException', e => console.error('❌ Uncaught:', e));
process.on('unhandledRejection', e => console.error('❌ Unhandled:', e));
process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
process.on('SIGINT', async () => { await pool.end(); process.exit(0); });

// ═══════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════
async function startServer() {
  try {
    await connectDatabase();
    await loadRestaurants();
    
    app.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════════════════╗
║   🍽️  RESTAURANT WHATSAPP BOT v8.0                   ║
║   💵 COD + Real-time Menu Management                 ║
╠═══════════════════════════════════════════════════════╣
║  Port:              ${String(PORT).padEnd(33)}║
║  Test Mode:         ${String(TEST_MODE ? '🧪 ON' : '🚀 OFF').padEnd(33)}║
║  Database:          ${String(dbConnected ? '✅ Connected' : '❌ Disconnected').padEnd(33)}║
║  Restaurants:       ${String(restaurantCache.length).padEnd(33)}║
╠═══════════════════════════════════════════════════════╣
║  🆕 MENU MANAGEMENT FEATURES                          ║
║     ✅ Instant availability updates                   ║
║     ✅ Owner commands via WhatsApp                    ║
║     ✅ Web-based menu manager                         ║
║     ✅ REST API for integrations                      ║
╠═══════════════════════════════════════════════════════╣
║  📱 OWNER WHATSAPP COMMANDS                           ║
║     MENU or STATUS  - View all items                  ║
║     OUT [id]        - Mark unavailable                ║
║     IN [id]         - Mark available                  ║
║     STOCK [id]      - Toggle status                   ║
║     HELP            - Show commands                   ║
╠═══════════════════════════════════════════════════════╣
║  🌐 WEB INTERFACE                                     ║
║     http://localhost:${PORT}/menu-updater             ║
╠═══════════════════════════════════════════════════════╣
║  🔌 API ENDPOINTS                                     ║
║     POST /api/menu/toggle/:id                         ║
║     GET  /api/menu/status/:restaurantId               ║
║     POST /api/menu/bulk-update                        ║
╠═══════════════════════════════════════════════════════╣
║  💵 PAYMENT: Cash on Delivery Only                    ║
║  📊 Google Sheets: ${String(process.env.GOOGLE_APPS_SCRIPT_URL ? '✅ Enabled' : '⚠️  Not configured').padEnd(30)}║
╠═══════════════════════════════════════════════════════╣
║  ⚡ Ready for production!                             ║
╚═══════════════════════════════════════════════════════╝
      `);
      
      console.log('📋 Quick Start:');
      console.log('   1. Customers: Scan QR → Start ordering');
      console.log('   2. Owners: Text commands → Update menu');
      console.log('   3. Web: http://localhost:' + PORT + '/menu-updater');
      console.log('   4. Health: http://localhost:' + PORT + '/health\n');
    });
  } catch (e) {
    console.error('❌ Startup failed:', e);
    process.exit(1);
  }
}

startServer();
