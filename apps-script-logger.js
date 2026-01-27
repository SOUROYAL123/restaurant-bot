// apps-script-logger.js
// Sends order and booking data to Google Apps Script webhook
// Matches your deployed Apps Script configuration

const axios = require('axios');

// =====================================================
// CONFIGURATION
// =====================================================
const APPS_SCRIPT_URL = process.env.GOOGLE_APPS_SCRIPT_URL || '';
const SECRET_KEY = process.env.GOOGLE_APPS_SCRIPT_SECRET || 'Sourav@Legacylens#2026!Orders';

// =====================================================
// LOG ORDER TO GOOGLE SHEETS VIA APPS SCRIPT
// =====================================================
async function logOrderToSheets(orderData) {
    try {
        if (!APPS_SCRIPT_URL) {
            console.log('⚠️ Google Apps Script URL not configured, skipping log');
            return { success: false, reason: 'not_configured' };
        }

        console.log(`📊 Logging order #${orderData.orderId} to Google Sheets...`);

        const payload = {
            secretKey: SECRET_KEY,
            type: 'order',
            orderId: orderData.orderId,
            restaurantName: orderData.restaurantName,
            restaurantId: orderData.restaurantId,
            customerPhone: orderData.customerPhone,
            customerName: orderData.customerName || 'Customer',
            orderType: orderData.orderType || 'delivery',
            deliveryAddress: orderData.deliveryAddress || 'N/A',
            items: orderData.items.map(item => ({
                name: item.name,
                quantity: item.quantity,
                price: parseFloat(item.price),
                category: item.category || 'N/A',
                is_vegetarian: item.is_vegetarian || false
            })),
            subtotal: parseFloat(orderData.subtotal),
            deliveryFee: parseFloat(orderData.deliveryFee),
            total: parseFloat(orderData.total),
            specialInstructions: orderData.specialInstructions || '',
            status: orderData.status || 'pending',
            paymentStatus: orderData.paymentStatus || 'COD',
            estimatedDeliveryTime: orderData.estimatedDeliveryTime || '45 minutes'
        };

        const response = await axios.post(APPS_SCRIPT_URL, payload, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 15000 // 15 second timeout for Apps Script
        });

        if (response.data.success) {
            console.log(`✅ Order #${orderData.orderId} logged to Google Sheets successfully`);
            console.log(`📊 View sheet: https://docs.google.com/spreadsheets/d/1eoxhcdDumc1cBZE46-TWansPdskAcwf77hYkDx4n-d4`);
            return { success: true };
        } else {
            console.error(`❌ Failed to log order: ${response.data.error}`);
            return { success: false, error: response.data.error };
        }

    } catch (error) {
        console.error('❌ Failed to log order to Google Sheets:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        return { success: false, error: error.message };
    }
}

// =====================================================
// LOG BOOKING TO GOOGLE SHEETS VIA APPS SCRIPT
// =====================================================
async function logBookingToSheets(bookingData) {
    try {
        if (!APPS_SCRIPT_URL) {
            console.log('⚠️ Google Apps Script URL not configured, skipping log');
            return { success: false, reason: 'not_configured' };
        }

        console.log(`📊 Logging booking #${bookingData.bookingId} to Google Sheets...`);

        const payload = {
            secretKey: SECRET_KEY,
            type: 'booking',
            bookingId: bookingData.bookingId,
            restaurantName: bookingData.restaurantName,
            restaurantId: bookingData.restaurantId,
            customerPhone: bookingData.customerPhone,
            customerName: bookingData.customerName,
            bookingDate: bookingData.bookingDate,
            bookingTime: bookingData.bookingTime,
            numberOfGuests: bookingData.numberOfGuests,
            specialRequests: bookingData.specialRequests || '',
            status: bookingData.status || 'pending'
        };

        const response = await axios.post(APPS_SCRIPT_URL, payload, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        if (response.data.success) {
            console.log(`✅ Booking #${bookingData.bookingId} logged to Google Sheets successfully`);
            console.log(`📊 View sheet: https://docs.google.com/spreadsheets/d/1eoxhcdDumc1cBZE46-TWansPdskAcwf77hYkDx4n-d4`);
            return { success: true };
        } else {
            console.error(`❌ Failed to log booking: ${response.data.error}`);
            return { success: false, error: response.data.error };
        }

    } catch (error) {
        console.error('❌ Failed to log booking to Google Sheets:', error.message);
        return { success: false, error: error.message };
    }
}

// =====================================================
// TEST CONNECTION
// =====================================================
async function testConnection() {
    if (!APPS_SCRIPT_URL) {
        console.log('⚠️ Google Apps Script URL not configured');
        console.log('   Please set GOOGLE_APPS_SCRIPT_URL in your .env file');
        return false;
    }

    console.log('🧪 Testing Google Apps Script connection...');
    console.log('📍 URL:', APPS_SCRIPT_URL);
    console.log('🔑 Secret Key:', SECRET_KEY.substring(0, 10) + '...');

    try {
        const testPayload = {
            secretKey: SECRET_KEY,
            type: 'order',
            orderId: 0,
            restaurantName: 'Test Restaurant',
            restaurantId: 0,
            customerPhone: '+918013610018',
            customerName: 'Test Customer',
            orderType: 'test',
            deliveryAddress: 'Test Address - Kolkata',
            items: [
                { 
                    name: 'Test Biryani', 
                    quantity: 1, 
                    price: 100, 
                    category: 'Test', 
                    is_vegetarian: false 
                }
            ],
            subtotal: 100,
            deliveryFee: 0,
            total: 100,
            specialInstructions: 'This is a test order from Node.js',
            status: 'test',
            paymentStatus: 'test',
            estimatedDeliveryTime: 'test'
        };

        console.log('📤 Sending test payload...');
        
        const response = await axios.post(APPS_SCRIPT_URL, testPayload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        if (response.data.success) {
            console.log('✅ Google Apps Script connection successful!');
            console.log('✅ Test data logged to spreadsheet');
            console.log('📊 View at: https://docs.google.com/spreadsheets/d/1eoxhcdDumc1cBZE46-TWansPdskAcwf77hYkDx4n-d4');
            return true;
        } else {
            console.log('❌ Connection test failed:', response.data.error);
            return false;
        }
    } catch (error) {
        console.error('❌ Connection test failed:', error.message);
        if (error.response) {
            console.error('❌ Response status:', error.response.status);
            console.error('❌ Response data:', error.response.data);
        }
        return false;
    }
}

// =====================================================
// CHECK IF CONFIGURED
// =====================================================
function isConfigured() {
    return APPS_SCRIPT_URL && APPS_SCRIPT_URL.length > 0;
}

// =====================================================
// GET SPREADSHEET URL
// =====================================================
function getSpreadsheetUrl() {
    return 'https://docs.google.com/spreadsheets/d/1eoxhcdDumc1cBZE46-TWansPdskAcwf77hYkDx4n-d4';
}

module.exports = {
    logOrderToSheets,
    logBookingToSheets,
    testConnection,
    isConfigured,
    getSpreadsheetUrl
};
