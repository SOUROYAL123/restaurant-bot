// features/payment.js
// Payment Integration Module (Razorpay)

const Razorpay = require('razorpay');
const { PAYMENT_CONFIG } = require('./config');

// Initialize Razorpay
let razorpayInstance = null;

if (PAYMENT_CONFIG.RAZORPAY_KEY_ID && PAYMENT_CONFIG.RAZORPAY_KEY_SECRET) {
    razorpayInstance = new Razorpay({
        key_id: PAYMENT_CONFIG.RAZORPAY_KEY_ID,
        key_secret: PAYMENT_CONFIG.RAZORPAY_KEY_SECRET
    });
}

/**
 * Create a payment link for an order
 */
async function createPaymentLink(pool, orderId, amount, customerPhone, customerName) {
    try {
        if (!razorpayInstance) {
            throw new Error('Razorpay not configured');
        }

        const options = {
            amount: Math.round(amount * 100), // Amount in paise
            currency: 'INR',
            accept_partial: false,
            description: `Order #${orderId}`,
            customer: {
                contact: customerPhone,
                name: customerName || 'Customer'
            },
            notify: {
                sms: true,
                whatsapp: true
            },
            reminder_enable: true,
            callback_url: `${process.env.APP_URL || 'https://restaurant.legacylens.co.in'}/payment/callback`,
            callback_method: 'get'
        };

        const paymentLink = await razorpayInstance.paymentLink.create(options);

        // Store payment transaction
        await pool.query(
            `INSERT INTO payment_transactions (order_id, payment_gateway, payment_id, amount, status)
             VALUES ($1, $2, $3, $4, $5)`,
            [orderId, 'razorpay', paymentLink.id, amount, 'pending']
        );

        return {
            success: true,
            paymentLink: paymentLink.short_url,
            paymentId: paymentLink.id
        };

    } catch (error) {
        console.error('Error creating payment link:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Verify payment status
 */
async function verifyPayment(pool, paymentId) {
    try {
        if (!razorpayInstance) {
            throw new Error('Razorpay not configured');
        }

        const payment = await razorpayInstance.paymentLink.fetch(paymentId);
        
        // Update payment transaction
        await pool.query(
            `UPDATE payment_transactions 
             SET status = $1, webhook_data = $2
             WHERE payment_id = $3`,
            [payment.status, JSON.stringify(payment), paymentId]
        );

        // If payment successful, update order status
        if (payment.status === 'paid') {
            const txn = await pool.query(
                'SELECT order_id FROM payment_transactions WHERE payment_id = $1',
                [paymentId]
            );
            
            if (txn.rows.length > 0) {
                await pool.query(
                    `UPDATE orders 
                     SET payment_status = 'completed', status = 'confirmed'
                     WHERE id = $1`,
                    [txn.rows[0].order_id]
                );

                // Add to order status history
                await pool.query(
                    `INSERT INTO order_status_history (order_id, status, notes)
                     VALUES ($1, $2, $3)`,
                    [txn.rows[0].order_id, 'confirmed', 'Payment received']
                );
            }
        }

        return {
            success: true,
            status: payment.status,
            paid: payment.status === 'paid'
        };

    } catch (error) {
        console.error('Error verifying payment:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Handle payment webhook from Razorpay
 */
async function handlePaymentWebhook(pool, webhookBody, webhookSignature) {
    try {
        // Verify webhook signature
        const isValid = razorpayInstance.webhooks.validateWebhookSignature(
            JSON.stringify(webhookBody),
            webhookSignature,
            PAYMENT_CONFIG.RAZORPAY_WEBHOOK_SECRET
        );

        if (!isValid) {
            return { success: false, error: 'Invalid signature' };
        }

        const event = webhookBody.event;
        const payment = webhookBody.payload.payment.entity;

        if (event === 'payment.captured') {
            // Update payment status
            await pool.query(
                `UPDATE payment_transactions 
                 SET status = 'completed', webhook_data = $1
                 WHERE payment_id = $2`,
                [JSON.stringify(payment), payment.id]
            );

            // Get order and update status
            const txn = await pool.query(
                'SELECT order_id FROM payment_transactions WHERE payment_id = $1',
                [payment.id]
            );

            if (txn.rows.length > 0) {
                await pool.query(
                    `UPDATE orders 
                     SET payment_status = 'completed', status = 'confirmed'
                     WHERE id = $1`,
                    [txn.rows[0].order_id]
                );
            }

            return { success: true, orderId: txn.rows[0]?.order_id };
        }

        return { success: true };

    } catch (error) {
        console.error('Error handling payment webhook:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Generate payment message for customer
 */
function getPaymentMessage(orderId, amount, paymentLink) {
    return `💳 *Payment Required*

Order ID: #${orderId}
Amount: ₹${amount}

Please complete payment to confirm your order:

${paymentLink}

⏰ Payment link valid for 15 minutes
✅ Secure payment via Razorpay

After payment, your order will be confirmed automatically!`;
}

/**
 * Check if payment is required for order
 */
async function isPaymentRequired(pool, orderId) {
    const result = await pool.query(
        'SELECT payment_status FROM orders WHERE id = $1',
        [orderId]
    );
    
    return result.rows.length > 0 && result.rows[0].payment_status === 'pending';
}

module.exports = {
    createPaymentLink,
    verifyPayment,
    handlePaymentWebhook,
    getPaymentMessage,
    isPaymentRequired
};
