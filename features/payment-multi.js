// features/payment-multi.js
// Multi-Gateway Payment Integration

const crypto = require('crypto');
const axios = require('axios');

// =====================================================
// RAZORPAY INTEGRATION
// =====================================================
async function createRazorpayPayment(orderData) {
    try {
        const Razorpay = require('razorpay');
        const razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET
        });

        const options = {
            amount: Math.round(orderData.amount * 100), // paise
            currency: 'INR',
            accept_partial: false,
            description: `Order from ${orderData.restaurantName}`,
            customer: {
                contact: orderData.phone,
                name: orderData.customerName || 'Customer'
            },
            notify: {
                sms: true,
                whatsapp: true
            },
            reminder_enable: true,
            callback_url: `${process.env.BASE_URL}/payment/razorpay/callback`,
            callback_method: 'get'
        };

        const paymentLink = await razorpay.paymentLink.create(options);

        return {
            success: true,
            gateway: 'razorpay',
            paymentId: paymentLink.id,
            paymentUrl: paymentLink.short_url,
            orderId: paymentLink.order_id
        };
    } catch (error) {
        console.error('Razorpay Error:', error.message);
        return { success: false, error: error.message };
    }
}

// =====================================================
// PHONEPE INTEGRATION
// =====================================================
async function createPhonePePayment(orderData) {
    try {
        const merchantId = process.env.PHONEPE_MERCHANT_ID;
        const saltKey = process.env.PHONEPE_SALT_KEY;
        const saltIndex = process.env.PHONEPE_SALT_INDEX || '1';
        const mode = process.env.PHONEPE_MODE || 'UAT';
        
        const baseUrl = mode === 'PRODUCTION' 
            ? 'https://api.phonepe.com/apis/hermes'
            : 'https://api-preprod.phonepe.com/apis/pg-sandbox';

        // Generate unique transaction ID
        const merchantTransactionId = `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const payload = {
            merchantId: merchantId,
            merchantTransactionId: merchantTransactionId,
            merchantUserId: orderData.phone.replace(/\D/g, ''),
            amount: Math.round(orderData.amount * 100), // paise
            redirectUrl: `${process.env.BASE_URL}/payment/phonepe/callback`,
            redirectMode: 'GET',
            callbackUrl: `${process.env.BASE_URL}/payment/phonepe/webhook`,
            mobileNumber: orderData.phone.replace(/\D/g, ''),
            paymentInstrument: {
                type: 'PAY_PAGE'
            }
        };

        // Encode payload in base64
        const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');

        // Generate checksum: base64(payload) + "/pg/v1/pay" + saltKey
        const checksumString = base64Payload + '/pg/v1/pay' + saltKey;
        const checksum = crypto.createHash('sha256').update(checksumString).digest('hex') + '###' + saltIndex;

        // Make API request
        const response = await axios.post(
            `${baseUrl}/pg/v1/pay`,
            {
                request: base64Payload
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-VERIFY': checksum
                }
            }
        );

        if (response.data.success) {
            return {
                success: true,
                gateway: 'phonepe',
                paymentId: merchantTransactionId,
                paymentUrl: response.data.data.instrumentResponse.redirectInfo.url,
                orderId: merchantTransactionId
            };
        } else {
            return {
                success: false,
                error: response.data.message
            };
        }
    } catch (error) {
        console.error('PhonePe Error:', error.message);
        return { success: false, error: error.message };
    }
}

// =====================================================
// PAYTM INTEGRATION
// =====================================================
async function createPaytmPayment(orderData) {
    try {
        const PaytmChecksum = require('paytmchecksum');
        
        const merchantId = process.env.PAYTM_MERCHANT_ID;
        const merchantKey = process.env.PAYTM_MERCHANT_KEY;
        const website = process.env.PAYTM_WEBSITE || 'WEBSTAGING';
        
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
                    custId: orderData.phone.replace(/\D/g, '')
                }
            }
        };

        // Generate checksum
        const checksum = await PaytmChecksum.generateSignature(
            JSON.stringify(paytmParams.body),
            merchantKey
        );

        paytmParams.head = {
            signature: checksum
        };

        // Initiate transaction
        const baseUrl = website === 'WEBSTAGING'
            ? 'https://securegw-stage.paytm.in'
            : 'https://securegw.paytm.in';

        const response = await axios.post(
            `${baseUrl}/theia/api/v1/initiateTransaction?mid=${merchantId}&orderId=${orderId}`,
            paytmParams,
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.body.resultInfo.resultStatus === 'S') {
            const txnToken = response.data.body.txnToken;
            const paymentUrl = `${baseUrl}/theia/api/v1/showPaymentPage?mid=${merchantId}&orderId=${orderId}`;

            return {
                success: true,
                gateway: 'paytm',
                paymentId: orderId,
                paymentUrl: paymentUrl,
                txnToken: txnToken,
                orderId: orderId
            };
        } else {
            return {
                success: false,
                error: response.data.body.resultInfo.resultMsg
            };
        }
    } catch (error) {
        console.error('Paytm Error:', error.message);
        return { success: false, error: error.message };
    }
}

// =====================================================
// UNIFIED PAYMENT CREATION
// =====================================================
async function createPayment(gateway, orderData) {
    console.log(`Creating ${gateway} payment for order: ${orderData.amount}`);
    
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

// =====================================================
// PAYMENT VERIFICATION
// =====================================================
async function verifyPayment(gateway, paymentId, pool) {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM orders WHERE gateway_transaction_id = $1',
            [paymentId]
        );
        
        if (rows.length > 0 && rows[0].payment_status === 'PAID') {
            return { success: true, verified: true };
        }

        // Gateway-specific verification
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
    } catch (error) {
        console.error('Verify Payment Error:', error.message);
        return { success: false, verified: false };
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
        return { success: false, verified: false };
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
        return { success: false, verified: false };
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

        paytmParams.head = {
            signature: checksum
        };

        const baseUrl = website === 'WEBSTAGING'
            ? 'https://securegw-stage.paytm.in'
            : 'https://securegw.paytm.in';

        const response = await axios.post(
            `${baseUrl}/v3/order/status`,
            paytmParams,
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        return {
            success: true,
            verified: response.data.body.resultInfo.resultStatus === 'TXN_SUCCESS'
        };
    } catch (error) {
        return { success: false, verified: false };
    }
}

// =====================================================
// PHONEPE REFUND INTEGRATION
// =====================================================
async function refundPhonePePayment(originalTransactionId, amount) {
    try {
        const merchantId = process.env.PHONEPE_MERCHANT_ID;
        const saltKey = process.env.PHONEPE_SALT_KEY;
        const saltIndex = process.env.PHONEPE_SALT_INDEX || '1';
        const mode = process.env.PHONEPE_MODE || 'UAT';
        
        const baseUrl = mode === 'PRODUCTION' 
            ? 'https://api.phonepe.com/apis/hermes'
            : 'https://api-preprod.phonepe.com/apis/pg-sandbox';

        // Unique ID for the refund action itself
        const refundTransactionId = `RFND_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

        const payload = {
            merchantId: merchantId,
            originalTransactionId: originalTransactionId, // The ID from the initial payment
            merchantTransactionId: refundTransactionId,
            amount: Math.round(amount * 100), // paise
            callbackUrl: `${process.env.BASE_URL}/payment/phonepe/refund-webhook`
        };

        const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
        const checksumString = base64Payload + '/pg/v1/refund' + saltKey;
        const checksum = crypto.createHash('sha256').update(checksumString).digest('hex') + '###' + saltIndex;

        const response = await axios.post(
            `${baseUrl}/pg/v1/refund`,
            { request: base64Payload },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-VERIFY': checksum
                }
            }
        );

        if (response.data.success) {
            return { success: true, refundId: refundTransactionId, status: response.data.code };
        } else {
            return { success: false, error: response.data.message };
        }
    } catch (error) {
        console.error('PhonePe Refund Error:', error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    createPayment,
    verifyPayment,
    refundPhonePePayment
};
