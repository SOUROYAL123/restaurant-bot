// menu-manager.js - Real-time Menu Availability Manager
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const twilio = require('twilio');

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ═══════════════════════════════════════════════════════
// 1. TOGGLE ITEM AVAILABILITY (API)
// ═══════════════════════════════════════════════════════
router.post('/api/menu/toggle/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { restaurantId, ownerKey } = req.body;

    // Verify owner authorization
    const restaurant = await pool.query(
      'SELECT owner_api_key FROM restaurants WHERE id = $1',
      [restaurantId]
    );

    if (restaurant.rows[0]?.owner_api_key !== ownerKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Toggle availability
    const result = await pool.query(
      `UPDATE menu_items 
       SET available = NOT available,
           updated_at = NOW()
       WHERE id = $1 AND restaurant_id = $2
       RETURNING id, name, available`,
      [itemId, restaurantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = result.rows[0];
    
    console.log(
      `✅ ${item.name} - ${item.available ? 'AVAILABLE' : 'OUT OF STOCK'}`
    );

    res.json({
      success: true,
      itemId: item.id,
      itemName: item.name,
      available: item.available,
      status: item.available ? 'Available' : 'Out of Stock'
    });

  } catch (error) {
    console.error('Toggle error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════
// 2. MARK MULTIPLE ITEMS UNAVAILABLE
// ═══════════════════════════════════════════════════════
router.post('/api/menu/bulk-unavailable', async (req, res) => {
  try {
    const { restaurantId, ownerKey, itemIds } = req.body;

    // Verify owner
    const restaurant = await pool.query(
      'SELECT owner_api_key, name FROM restaurants WHERE id = $1',
      [restaurantId]
    );

    if (restaurant.rows[0]?.owner_api_key !== ownerKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Update items
    const result = await pool.query(
      `UPDATE menu_items 
       SET available = false,
           updated_at = NOW()
       WHERE id = ANY($1) AND restaurant_id = $2
       RETURNING id, name`,
      [itemIds, restaurantId]
    );

    console.log(
      `✅ ${result.rows.length} items marked unavailable for ${restaurant.rows[0].name}`
    );

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
// 3. GET CURRENT MENU STATUS
// ═══════════════════════════════════════════════════════
router.get('/api/menu/status/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const items = await pool.query(
      `SELECT id, name, category, price, available
       FROM menu_items
       WHERE restaurant_id = $1
       ORDER BY category, name`,
      [restaurantId]
    );

    const available = items.rows.filter(i => i.available).length;
    const unavailable = items.rows.filter(i => !i.available).length;

    res.json({
      success: true,
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

// ═══════════════════════════════════════════════════════
// 4. WHATSAPP COMMAND PROCESSOR
// ═══════════════════════════════════════════════════════
async function processOwnerCommand(phone, text, restaurantId) {
  try {
    const upper = text.toUpperCase().trim();

    // Command: UNAVAILABLE [item_id] or OUT [item_id]
    const unavailableMatch = upper.match(/^(UNAVAILABLE|OUT)\s+(\d+)$/);
    if (unavailableMatch) {
      const itemId = parseInt(unavailableMatch[2]);
      
      const result = await pool.query(
        `UPDATE menu_items 
         SET available = false, updated_at = NOW()
         WHERE id = $1 AND restaurant_id = $2
         RETURNING name`,
        [itemId, restaurantId]
      );

      if (result.rows.length > 0) {
        return `✅ *${result.rows[0].name}* marked as OUT OF STOCK`;
      }
      return `❌ Item #${itemId} not found`;
    }

    // Command: AVAILABLE [item_id] or IN [item_id]
    const availableMatch = upper.match(/^(AVAILABLE|IN)\s+(\d+)$/);
    if (availableMatch) {
      const itemId = parseInt(availableMatch[2]);
      
      const result = await pool.query(
        `UPDATE menu_items 
         SET available = true, updated_at = NOW()
         WHERE id = $1 AND restaurant_id = $2
         RETURNING name`,
        [itemId, restaurantId]
      );

      if (result.rows.length > 0) {
        return `✅ *${result.rows[0].name}* marked as AVAILABLE`;
      }
      return `❌ Item #${itemId} not found`;
    }

    // Command: STATUS or MENU
    if (upper === 'STATUS' || upper === 'MENU') {
      const items = await pool.query(
        `SELECT id, name, available
         FROM menu_items
         WHERE restaurant_id = $1
         ORDER BY category, name`,
        [restaurantId]
      );

      let msg = `📋 *MENU STATUS*\n\n`;
      items.rows.forEach(item => {
        const status = item.available ? '✅' : '❌';
        msg += `${status} ${item.id}. ${item.name}\n`;
      });
      
      msg += `\n💡 *Commands:*\n`;
      msg += `OUT [id] - Mark unavailable\n`;
      msg += `IN [id] - Mark available\n`;
      msg += `STATUS - View menu`;

      return msg;
    }

    return null; // Not an owner command

  } catch (error) {
    console.error('Owner command error:', error);
    return '❌ Error processing command';
  }
}

// ═══════════════════════════════════════════════════════
// 5. CHECK IF USER IS RESTAURANT OWNER
// ═══════════════════════════════════════════════════════
async function isRestaurantOwner(phone) {
  try {
    const result = await pool.query(
      'SELECT id, name FROM restaurants WHERE whatsapp_number = $1',
      [phone]
    );
    
    if (result.rows.length > 0) {
      return {
        isOwner: true,
        restaurantId: result.rows[0].id,
        restaurantName: result.rows[0].name
      };
    }
    
    return { isOwner: false };
  } catch (error) {
    console.error('Owner check error:', error);
    return { isOwner: false };
  }
}

module.exports = {
  router,
  processOwnerCommand,
  isRestaurantOwner
};
