// features/loyalty.js
// Loyalty Points System Module

const { LOYALTY_CONFIG } = require('./config');

/**
 * Calculate points earned from order amount
 */
function calculatePointsEarned(orderAmount) {
    return Math.floor(orderAmount * LOYALTY_CONFIG.EARN_RATE);
}

/**
 * Calculate discount from points redeemed
 */
function calculatePointsDiscount(points) {
    return points * LOYALTY_CONFIG.REDEEM_RATE;
}

/**
 * Get customer loyalty points balance
 */
async function getCustomerPoints(pool, phoneNumber) {
    try {
        // Get or create customer
        const customer = await pool.query(
            `INSERT INTO customers (phone_number, loyalty_points)
             VALUES ($1, 0)
             ON CONFLICT (phone_number) 
             DO UPDATE SET updated_at = CURRENT_TIMESTAMP
             RETURNING loyalty_points`,
            [phoneNumber]
        );

        return {
            success: true,
            points: customer.rows[0].loyalty_points
        };
    } catch (error) {
        console.error('Error getting customer points:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Award points for completed order
 */
async function awardPoints(pool, phoneNumber, orderId, orderAmount) {
    try {
        const pointsEarned = calculatePointsEarned(orderAmount);

        // Update customer points
        const result = await pool.query(
            `UPDATE customers 
             SET loyalty_points = loyalty_points + $1,
                 total_orders = total_orders + 1,
                 total_spent = total_spent + $2,
                 last_order_date = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE phone_number = $3
             RETURNING loyalty_points`,
            [pointsEarned, orderAmount, phoneNumber]
        );

        const newBalance = result.rows[0].loyalty_points;

        // Record points history
        await pool.query(
            `INSERT INTO loyalty_points_history 
             (customer_phone, order_id, points_change, transaction_type, description, balance_after)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                phoneNumber,
                orderId,
                pointsEarned,
                'earned',
                `Points earned from order #${orderId}`,
                newBalance
            ]
        );

        return {
            success: true,
            pointsEarned,
            newBalance
        };
    } catch (error) {
        console.error('Error awarding points:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Redeem points for discount
 */
async function redeemPoints(pool, phoneNumber, pointsToRedeem) {
    try {
        // Check if customer has enough points
        const customer = await pool.query(
            'SELECT loyalty_points FROM customers WHERE phone_number = $1',
            [phoneNumber]
        );

        if (customer.rows.length === 0) {
            return { success: false, error: 'Customer not found' };
        }

        const currentPoints = customer.rows[0].loyalty_points;

        if (currentPoints < pointsToRedeem) {
            return { 
                success: false, 
                error: `Insufficient points. You have ${currentPoints} points.` 
            };
        }

        if (pointsToRedeem < LOYALTY_CONFIG.MIN_REDEEM) {
            return { 
                success: false, 
                error: `Minimum ${LOYALTY_CONFIG.MIN_REDEEM} points required to redeem` 
            };
        }

        // Calculate discount
        const discount = calculatePointsDiscount(pointsToRedeem);

        // Deduct points
        const result = await pool.query(
            `UPDATE customers 
             SET loyalty_points = loyalty_points - $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE phone_number = $2
             RETURNING loyalty_points`,
            [pointsToRedeem, phoneNumber]
        );

        const newBalance = result.rows[0].loyalty_points;

        // Record points history
        await pool.query(
            `INSERT INTO loyalty_points_history 
             (customer_phone, points_change, transaction_type, description, balance_after)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                phoneNumber,
                -pointsToRedeem,
                'redeemed',
                `Redeemed ${pointsToRedeem} points for ₹${discount} discount`,
                newBalance
            ]
        );

        return {
            success: true,
            pointsRedeemed: pointsToRedeem,
            discount,
            newBalance
        };
    } catch (error) {
        console.error('Error redeeming points:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Get points history for customer
 */
async function getPointsHistory(pool, phoneNumber, limit = 10) {
    try {
        const history = await pool.query(
            `SELECT * FROM loyalty_points_history 
             WHERE customer_phone = $1 
             ORDER BY created_at DESC 
             LIMIT $2`,
            [phoneNumber, limit]
        );

        return {
            success: true,
            history: history.rows
        };
    } catch (error) {
        console.error('Error getting points history:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Generate loyalty points message
 */
function getLoyaltyMessage(points, pointsEarned = null) {
    let message = `🎁 *Loyalty Points*\n\n`;
    message += `Current Balance: ${points} points\n`;
    message += `Value: ₹${calculatePointsDiscount(points)}\n\n`;

    if (pointsEarned) {
        message += `✨ You earned ${pointsEarned} points from this order!\n\n`;
    }

    message += `💡 *How to use:*\n`;
    message += `• Earn ${LOYALTY_CONFIG.EARN_RATE} point per ₹1 spent\n`;
    message += `• Redeem points for discounts\n`;
    message += `• Minimum ${LOYALTY_CONFIG.MIN_REDEEM} points to redeem\n\n`;

    if (points >= LOYALTY_CONFIG.MIN_REDEEM) {
        message += `You can redeem up to ₹${calculatePointsDiscount(points)} on your next order!`;
    } else {
        const pointsNeeded = LOYALTY_CONFIG.MIN_REDEEM - points;
        message += `Earn ${pointsNeeded} more points to start redeeming!`;
    }

    return message;
}

/**
 * Check if customer can use loyalty points
 */
async function canUsePoints(pool, phoneNumber, pointsToUse) {
    const result = await getCustomerPoints(pool, phoneNumber);
    
    if (!result.success) return false;
    
    return result.points >= pointsToUse && pointsToUse >= LOYALTY_CONFIG.MIN_REDEEM;
}

module.exports = {
    calculatePointsEarned,
    calculatePointsDiscount,
    getCustomerPoints,
    awardPoints,
    redeemPoints,
    getPointsHistory,
    getLoyaltyMessage,
    canUsePoints
};
