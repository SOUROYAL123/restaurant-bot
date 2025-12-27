/**
 * ═══════════════════════════════════════════════════════════
 * RAZORPAY PAYMENT INTEGRATION
 * Handles deposit collection for appointments
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const Razorpay = require('razorpay');
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

/**
 * Create payment link for appointment deposit
 */
async function createDepositLink(appointmentId, patientName, patientPhone) {
    try {
        const depositAmount = parseInt(process.env.DEPOSIT_AMOUNT) || 200;
        
        // Create payment link
        const paymentLink = await razorpay.paymentLink.create({
            amount: depositAmount * 100, // Convert to paise
            currency: "INR",
            description: `Appointment Deposit #${appointmentId}`,
            customer: {
                name: patientName,
                contact: patientPhone.replace('whatsapp:', '').replace('+', '')
            },
            notify: {
                sms: false,
                email: false,
                whatsapp: false // We'll send via our bot
            },
            reminder_enable: false,
            callback_url: `${process.env.BASE_URL}/payment-callback?appointment_id=${appointmentId}`,
            callback_method: 'get'
        });
        
        // Store payment link ID in database
        await sql`
            UPDATE appointments 
            SET 
                payment_link_id = ${paymentLink.id},
                payment_status = 'pending',
                updated_at = NOW()
            WHERE id = ${appointmentId}
        `;
        
        console.log(`✅ Payment link created for appointment #${appointmentId}`);
        
        return {
            success: true,
            paymentUrl: paymentLink.short_url,
            amount: depositAmount
        };
        
    } catch (error) {
        console.error('❌ Payment link creation failed:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Verify payment callback
 */
async function verifyPayment(paymentLinkId, paymentId) {
    try {
        // Fetch payment link details
        const paymentLink = await razorpay.paymentLink.fetch(paymentLinkId);
        
        if (paymentLink.status === 'paid') {
            return {
                success: true,
                amount: paymentLink.amount / 100,
                paymentId: paymentId
            };
        }
        
        return {
            success: false,
            error: 'Payment not completed'
        };
        
    } catch (error) {
        console.error('❌ Payment verification failed:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Process refund for cancelled appointment
 */
async function processRefund(appointmentId) {
    try {
        // Get appointment details
        const appointments = await sql`
            SELECT payment_id, payment_link_id, appointment_date, created_at
            FROM appointments 
            WHERE id = ${appointmentId}
            AND payment_status = 'paid'
        `;
        
        if (appointments.length === 0) {
            return { success: false, error: 'No paid appointment found' };
        }
        
        const appt = appointments[0];
        
        // Check if within refund window
        const refundHours = parseInt(process.env.DEPOSIT_REFUND_HOURS) || 24;
        const appointmentDate = new Date(appt.appointment_date);
        const hoursUntilAppt = (appointmentDate - new Date()) / (1000 * 60 * 60);
        
        if (hoursUntilAppt < refundHours) {
            return { 
                success: false, 
                error: `Refund only available if cancelled ${refundHours}+ hours before appointment` 
            };
        }
        
        // Process refund
        const payment = await razorpay.payments.fetch(appt.payment_id);
        
        const refund = await razorpay.payments.refund(appt.payment_id, {
            amount: payment.amount, // Full refund
            speed: 'normal',
            notes: {
                reason: 'Appointment cancelled by patient',
                appointment_id: appointmentId
            }
        });
        
        // Update database
        await sql`
            UPDATE appointments 
            SET 
                payment_status = 'refunded',
                refund_id = ${refund.id},
                updated_at = NOW()
            WHERE id = ${appointmentId}
        `;
        
        console.log(`✅ Refund processed for appointment #${appointmentId}`);
        
        return {
            success: true,
            refundId: refund.id,
            amount: refund.amount / 100
        };
        
    } catch (error) {
        console.error('❌ Refund failed:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

module.exports = {
    createDepositLink,
    verifyPayment,
    processRefund
};
