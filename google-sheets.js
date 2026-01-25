// google-sheets.js - DIAGNOSTIC VERSION
// Google Sheets Integration with Enhanced Debugging

const { google } = require('googleapis');

let sheetsClient = null;
let isConfigured = false;

/**
 * Initialize Google Sheets client with detailed debugging
 */
function initializeGoogleSheets() {
    try {
        console.log('🔍 DIAGNOSTIC: Starting Google Sheets initialization...');
        
        // Check if credentials exist
        if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
            console.log('❌ DIAGNOSTIC: GOOGLE_SERVICE_ACCOUNT_EMAIL is missing');
            return false;
        }
        
        if (!process.env.GOOGLE_PRIVATE_KEY) {
            console.log('❌ DIAGNOSTIC: GOOGLE_PRIVATE_KEY is missing');
            return false;
        }

        console.log('✅ DIAGNOSTIC: Both credentials present');
        console.log('📧 Service Email:', process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
        
        // Get private key and check its format
        let privateKey = process.env.GOOGLE_PRIVATE_KEY;
        
        console.log('🔑 DIAGNOSTIC: Private key length:', privateKey.length);
        console.log('🔑 DIAGNOSTIC: First 50 chars:', privateKey.substring(0, 50));
        console.log('🔑 DIAGNOSTIC: Contains \\\\n (double):', privateKey.includes('\\\\n'));
        console.log('🔑 DIAGNOSTIC: Contains \\n (single):', privateKey.includes('\\n'));
        console.log('🔑 DIAGNOSTIC: Contains actual newline:', privateKey.includes('\n'));
        
        // Handle both \n and \\n escaping from Railway
        if (privateKey.includes('\\\\n')) {
            console.log('🔧 DIAGNOSTIC: Converting \\\\n to newlines...');
            privateKey = privateKey.replace(/\\\\n/g, '\n');
        } else if (privateKey.includes('\\n') && !privateKey.includes('\n')) {
            console.log('🔧 DIAGNOSTIC: Converting \\n to newlines...');
            privateKey = privateKey.replace(/\\n/g, '\n');
        } else {
            console.log('✅ DIAGNOSTIC: Key already has proper newlines');
        }
        
        console.log('🔑 DIAGNOSTIC: After conversion, first 50 chars:', privateKey.substring(0, 50));
        console.log('🔑 DIAGNOSTIC: After conversion, contains newlines:', privateKey.includes('\n'));
        
        // Verify key format
        if (!privateKey.startsWith('-----BEGIN PRIVATE KEY-----')) {
            console.log('❌ DIAGNOSTIC: Key does not start with BEGIN marker!');
            console.log('🔑 DIAGNOSTIC: Key starts with:', privateKey.substring(0, 30));
            return false;
        }
        
        if (!privateKey.includes('-----END PRIVATE KEY-----')) {
            console.log('❌ DIAGNOSTIC: Key does not contain END marker!');
            return false;
        }
        
        console.log('✅ DIAGNOSTIC: Key has proper BEGIN and END markers');

        // Create JWT auth
        console.log('🔐 DIAGNOSTIC: Creating JWT authentication...');
        const auth = new google.auth.JWT(
            process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            null,
            privateKey,
            ['https://www.googleapis.com/auth/spreadsheets']
        );

        console.log('✅ DIAGNOSTIC: JWT auth object created');

        // Create sheets client
        sheetsClient = google.sheets({ version: 'v4', auth });
        isConfigured = true;
        
        console.log('✅ Google Sheets initialized successfully');
        console.log('✅ Private key format detected and parsed correctly');
        
        return true;
    } catch (error) {
        console.error('❌ DIAGNOSTIC: Failed to initialize Google Sheets');
        console.error('❌ Error name:', error.name);
        console.error('❌ Error message:', error.message);
        console.error('❌ Error stack:', error.stack);
        return false;
    }
}

/**
 * Test authentication by attempting to create a spreadsheet
 */
async function testAuthentication() {
    if (!isConfigured) {
        console.log('⚠️ DIAGNOSTIC TEST: Google Sheets not configured');
        return false;
    }
    
    try {
        console.log('🧪 DIAGNOSTIC TEST: Attempting to create test spreadsheet...');
        
        const response = await sheetsClient.spreadsheets.create({
            requestBody: {
                properties: {
                    title: 'Test - Delete Me'
                }
            }
        });
        
        console.log('✅ DIAGNOSTIC TEST: Authentication successful!');
        console.log('✅ DIAGNOSTIC TEST: Created spreadsheet:', response.data.spreadsheetId);
        console.log('🗑️ DIAGNOSTIC TEST: You can delete this test sheet manually');
        
        return true;
    } catch (error) {
        console.error('❌ DIAGNOSTIC TEST: Authentication test failed');
        console.error('❌ DIAGNOSTIC TEST: Error:', error.message);
        if (error.response) {
            console.error('❌ DIAGNOSTIC TEST: Response status:', error.response.status);
            console.error('❌ DIAGNOSTIC TEST: Response data:', JSON.stringify(error.response.data));
        }
        return false;
    }
}

/**
 * Get or create spreadsheet
 */
async function getOrCreateSpreadsheet() {
    try {
        const spreadsheetId = process.env.GOOGLE_SHEET_ID;

        if (spreadsheetId) {
            try {
                await sheetsClient.spreadsheets.get({ spreadsheetId });
                console.log('✅ Using existing spreadsheet:', spreadsheetId);
                return spreadsheetId;
            } catch (error) {
                console.log('⚠️ Spreadsheet ID not found, will create new one');
            }
        }

        console.log('📊 Creating new spreadsheet...');
        const response = await sheetsClient.spreadsheets.create({
            requestBody: {
                properties: {
                    title: `Restaurant Orders - ${new Date().toISOString().split('T')[0]}`
                },
                sheets: [
                    { properties: { title: 'Orders', gridProperties: { frozenRowCount: 1 } } },
                    { properties: { title: 'Order Items', gridProperties: { frozenRowCount: 1 } } },
                    { properties: { title: 'Summary', gridProperties: { frozenRowCount: 1 } } }
                ]
            }
        });

        const newSpreadsheetId = response.data.spreadsheetId;
        console.log(`✅ Created new spreadsheet: ${newSpreadsheetId}`);
        console.log(`📊 View at: https://docs.google.com/spreadsheets/d/${newSpreadsheetId}`);

        await initializeSheetHeaders(newSpreadsheetId);
        return newSpreadsheetId;
    } catch (error) {
        console.error('❌ Failed to get/create spreadsheet:', error.message);
        throw error;
    }
}

/**
 * Initialize sheet headers
 */
async function initializeSheetHeaders(spreadsheetId) {
    try {
        const ordersHeaders = [
            'Order ID', 'Date & Time', 'Restaurant Name', 'Restaurant ID',
            'Customer Phone', 'Customer Name', 'Order Type', 'Delivery Address',
            'Subtotal', 'Delivery Fee', 'Total Amount', 'Special Instructions',
            'Status', 'Payment Status', 'Estimated Delivery'
        ];

        const itemsHeaders = [
            'Order ID', 'Date & Time', 'Restaurant Name', 'Item Name',
            'Category', 'Quantity', 'Unit Price', 'Subtotal', 'Is Vegetarian'
        ];

        const summaryHeaders = [
            'Restaurant Name', 'Total Orders', 'Total Revenue',
            'Total Items Sold', 'Avg Order Value', 'Last Order Date'
        ];

        await sheetsClient.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
                valueInputOption: 'RAW',
                data: [
                    { range: 'Orders!A1:O1', values: [ordersHeaders] },
                    { range: 'Order Items!A1:I1', values: [itemsHeaders] },
                    { range: 'Summary!A1:F1', values: [summaryHeaders] }
                ]
            }
        });

        console.log('✅ Sheet headers initialized');
    } catch (error) {
        console.error('❌ Failed to initialize headers:', error.message);
        throw error;
    }
}

/**
 * Log order to Google Sheets
 */
async function logOrderToSheets(orderData) {
    try {
        if (!isConfigured) {
            console.log('⚠️ Google Sheets not configured, skipping log');
            return { success: false, reason: 'not_configured' };
        }

        const spreadsheetId = await getOrCreateSpreadsheet();
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        const orderRow = [
            orderData.orderId,
            timestamp,
            orderData.restaurantName,
            orderData.restaurantId,
            orderData.customerPhone,
            orderData.customerName || 'Customer',
            orderData.orderType || 'delivery',
            orderData.deliveryAddress || 'N/A',
            orderData.subtotal.toFixed(2),
            orderData.deliveryFee.toFixed(2),
            orderData.total.toFixed(2),
            orderData.specialInstructions || 'None',
            orderData.status || 'pending',
            orderData.paymentStatus || 'pending',
            orderData.estimatedDeliveryTime || 'N/A'
        ];

        const itemRows = orderData.items.map(item => [
            orderData.orderId,
            timestamp,
            orderData.restaurantName,
            item.name,
            item.category || 'N/A',
            item.quantity,
            item.price.toFixed(2),
            (item.price * item.quantity).toFixed(2),
            item.is_vegetarian ? 'Yes' : 'No'
        ]);

        await sheetsClient.spreadsheets.values.append({
            spreadsheetId,
            range: 'Orders!A:O',
            valueInputOption: 'RAW',
            requestBody: { values: [orderRow] }
        });

        await sheetsClient.spreadsheets.values.append({
            spreadsheetId,
            range: 'Order Items!A:I',
            valueInputOption: 'RAW',
            requestBody: { values: itemRows }
        });

        await updateRestaurantSummary(spreadsheetId, orderData);

        console.log(`✅ Order #${orderData.orderId} logged to Google Sheets`);

        return {
            success: true,
            spreadsheetId,
            url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
        };
    } catch (error) {
        console.error('❌ Failed to log order to Google Sheets:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Update restaurant summary statistics
 */
async function updateRestaurantSummary(spreadsheetId, orderData) {
    try {
        const summaryResponse = await sheetsClient.spreadsheets.values.get({
            spreadsheetId,
            range: 'Summary!A:F'
        });

        const summaryRows = summaryResponse.data.values || [[]];
        const restaurantName = orderData.restaurantName;

        let restaurantRowIndex = -1;
        for (let i = 1; i < summaryRows.length; i++) {
            if (summaryRows[i][0] === restaurantName) {
                restaurantRowIndex = i;
                break;
            }
        }

        let totalOrders = 1;
        let totalRevenue = orderData.total;
        let totalItems = orderData.items.reduce((sum, item) => sum + item.quantity, 0);

        if (restaurantRowIndex >= 0) {
            totalOrders = parseInt(summaryRows[restaurantRowIndex][1] || 0) + 1;
            totalRevenue = parseFloat(summaryRows[restaurantRowIndex][2] || 0) + orderData.total;
            totalItems = parseInt(summaryRows[restaurantRowIndex][3] || 0) + orderData.items.reduce((sum, item) => sum + item.quantity, 0);
        }

        const avgOrderValue = totalRevenue / totalOrders;
        const lastOrderDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        const summaryRow = [
            restaurantName,
            totalOrders,
            totalRevenue.toFixed(2),
            totalItems,
            avgOrderValue.toFixed(2),
            lastOrderDate
        ];

        if (restaurantRowIndex >= 0) {
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId,
                range: `Summary!A${restaurantRowIndex + 1}:F${restaurantRowIndex + 1}`,
                valueInputOption: 'RAW',
                requestBody: { values: [summaryRow] }
            });
        } else {
            await sheetsClient.spreadsheets.values.append({
                spreadsheetId,
                range: 'Summary!A:F',
                valueInputOption: 'RAW',
                requestBody: { values: [summaryRow] }
            });
        }
    } catch (error) {
        console.error('⚠️ Failed to update summary:', error.message);
    }
}

/**
 * Log booking to Google Sheets
 */
async function logBookingToSheets(bookingData) {
    try {
        if (!isConfigured) {
            console.log('⚠️ Google Sheets not configured, skipping log');
            return { success: false, reason: 'not_configured' };
        }

        const spreadsheetId = await getOrCreateSpreadsheet();
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        try {
            await sheetsClient.spreadsheets.values.get({
                spreadsheetId,
                range: 'Bookings!A1'
            });
        } catch (error) {
            await sheetsClient.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{
                        addSheet: {
                            properties: {
                                title: 'Bookings',
                                gridProperties: { frozenRowCount: 1 }
                            }
                        }
                    }]
                }
            });

            const headers = [
                'Booking ID', 'Date & Time', 'Restaurant Name', 'Restaurant ID',
                'Customer Name', 'Customer Phone', 'Booking Date', 'Booking Time',
                'Number of Guests', 'Special Requests', 'Status'
            ];

            await sheetsClient.spreadsheets.values.update({
                spreadsheetId,
                range: 'Bookings!A1:K1',
                valueInputOption: 'RAW',
                requestBody: { values: [headers] }
            });
        }

        const bookingRow = [
            bookingData.bookingId,
            timestamp,
            bookingData.restaurantName,
            bookingData.restaurantId,
            bookingData.customerName,
            bookingData.customerPhone,
            bookingData.bookingDate,
            bookingData.bookingTime,
            bookingData.numberOfGuests,
            bookingData.specialRequests || 'None',
            bookingData.status || 'pending'
        ];

        await sheetsClient.spreadsheets.values.append({
            spreadsheetId,
            range: 'Bookings!A:K',
            valueInputOption: 'RAW',
            requestBody: { values: [bookingRow] }
        });

        console.log(`✅ Booking #${bookingData.bookingId} logged to Google Sheets`);

        return {
            success: true,
            spreadsheetId,
            url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
        };
    } catch (error) {
        console.error('❌ Failed to log booking to Google Sheets:', error.message);
        return { success: false, error: error.message };
    }
}

function getSpreadsheetUrl() {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    if (spreadsheetId) {
        return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    }
    return null;
}

// Initialize on module load
initializeGoogleSheets();

// Run diagnostic test after 5 seconds (give server time to start)
setTimeout(async () => {
    console.log('\n🧪 Running authentication diagnostic test...');
    await testAuthentication();
    console.log('🧪 Diagnostic test complete\n');
}, 5000);

module.exports = {
    initializeGoogleSheets,
    logOrderToSheets,
    logBookingToSheets,
    getSpreadsheetUrl,
    testAuthentication,
    isConfigured: () => isConfigured
};
