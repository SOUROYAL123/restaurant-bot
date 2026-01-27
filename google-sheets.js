// google-sheets.js
// Google Sheets Integration - Direct API Method
// Complete Production-Ready Version

const { google } = require('googleapis');

let sheetsClient = null;
let isConfigured = false;
let authClient = null;

/**
 * Initialize Google Sheets client with comprehensive error handling
 */
function initializeGoogleSheets() {
    try {
        console.log('🔍 DIAGNOSTIC: Starting Google Sheets initialization...');
        
        // Check if credentials exist
        const serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
        const privateKey = process.env.GOOGLE_PRIVATE_KEY;
        
        if (!serviceEmail) {
            console.log('⚠️ GOOGLE_SERVICE_ACCOUNT_EMAIL not set - Sheets disabled');
            return false;
        }
        
        if (!privateKey) {
            console.log('⚠️ GOOGLE_PRIVATE_KEY not set - Sheets disabled');
            return false;
        }

        console.log('✅ DIAGNOSTIC: Both credentials present');
        console.log('📧 Service Email:', serviceEmail);
        
        // Handle private key formatting
        let formattedKey = privateKey;
        
        console.log('🔑 DIAGNOSTIC: Private key length:', formattedKey.length);
        console.log('🔑 DIAGNOSTIC: First 50 chars:', formattedKey.substring(0, 50));
        
        // Check for different newline formats
        const hasDoubleBackslash = formattedKey.includes('\\\\n');
        const hasSingleBackslash = formattedKey.includes('\\n') && !formattedKey.includes('\n');
        const hasActualNewline = formattedKey.includes('\n');
        
        console.log('🔑 DIAGNOSTIC: Contains \\\\n (double):', hasDoubleBackslash);
        console.log('🔑 DIAGNOSTIC: Contains \\n (single):', hasSingleBackslash);
        console.log('🔑 DIAGNOSTIC: Contains actual newline:', hasActualNewline);
        
        // Convert to actual newlines if needed
        if (hasDoubleBackslash) {
            console.log('🔧 DIAGNOSTIC: Converting \\\\n to newlines...');
            formattedKey = formattedKey.replace(/\\\\n/g, '\n');
        } else if (hasSingleBackslash) {
            console.log('🔧 DIAGNOSTIC: Converting \\n to newlines...');
            formattedKey = formattedKey.replace(/\\n/g, '\n');
        } else {
            console.log('✅ DIAGNOSTIC: Key already has proper newlines');
        }
        
        console.log('🔑 DIAGNOSTIC: After conversion, first 50 chars:', formattedKey.substring(0, 50));
        console.log('🔑 DIAGNOSTIC: After conversion, contains newlines:', formattedKey.includes('\n'));
        
        // Verify key format
        if (!formattedKey.includes('-----BEGIN PRIVATE KEY-----')) {
            console.log('❌ DIAGNOSTIC: Key does not start with BEGIN marker!');
            console.log('🔑 DIAGNOSTIC: Key starts with:', formattedKey.substring(0, 30));
            return false;
        }
        
        if (!formattedKey.includes('-----END PRIVATE KEY-----')) {
            console.log('❌ DIAGNOSTIC: Key does not contain END marker!');
            return false;
        }
        
        console.log('✅ DIAGNOSTIC: Key has proper BEGIN and END markers');

        // Create JWT auth client
        console.log('🔐 DIAGNOSTIC: Creating JWT authentication...');
        
        authClient = new google.auth.JWT({
            email: serviceEmail,
            key: formattedKey,
            scopes: [
                'https://www.googleapis.com/auth/spreadsheets',
                'https://www.googleapis.com/auth/drive.file'
            ]
        });

        console.log('✅ DIAGNOSTIC: JWT auth object created');

        // Create sheets client
        sheetsClient = google.sheets({ version: 'v4', auth: authClient });
        isConfigured = true;
        
        console.log('✅ Google Sheets initialized successfully');
        console.log('✅ Private key format detected and parsed correctly');
        
        return true;
    } catch (error) {
        console.error('❌ DIAGNOSTIC: Failed to initialize Google Sheets');
        console.error('❌ Error name:', error.name);
        console.error('❌ Error message:', error.message);
        if (error.stack) {
            console.error('❌ Error stack:', error.stack);
        }
        isConfigured = false;
        return false;
    }
}

/**
 * Test authentication by attempting to create a test spreadsheet
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
                    title: `Test Sheet - ${new Date().toISOString()}`
                }
            }
        });
        
        console.log('✅ DIAGNOSTIC TEST: Authentication successful!');
        console.log('✅ DIAGNOSTIC TEST: Created spreadsheet:', response.data.spreadsheetId);
        console.log('🗑️ DIAGNOSTIC TEST: You can delete this test sheet manually');
        console.log('📊 DIAGNOSTIC TEST: View at:', `https://docs.google.com/spreadsheets/d/${response.data.spreadsheetId}`);
        
        return true;
    } catch (error) {
        console.error('❌ DIAGNOSTIC TEST: Authentication test failed');
        console.error('❌ DIAGNOSTIC TEST: Error:', error.message);
        if (error.response) {
            console.error('❌ DIAGNOSTIC TEST: Response status:', error.response.status);
            console.error('❌ DIAGNOSTIC TEST: Response data:', JSON.stringify(error.response.data));
        }
        if (error.code) {
            console.error('❌ DIAGNOSTIC TEST: Error code:', error.code);
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
                console.log('⚠️ Spreadsheet ID not accessible, creating new one...');
            }
        }

        console.log('📊 Creating new spreadsheet...');
        const response = await sheetsClient.spreadsheets.create({
            requestBody: {
                properties: {
                    title: `Restaurant Orders - ${new Date().toISOString().split('T')[0]}`
                },
                sheets: [
                    { 
                        properties: { 
                            title: 'Orders',
                            gridProperties: { 
                                frozenRowCount: 1,
                                frozenColumnCount: 1
                            }
                        } 
                    },
                    { 
                        properties: { 
                            title: 'Order Items',
                            gridProperties: { frozenRowCount: 1 }
                        } 
                    },
                    { 
                        properties: { 
                            title: 'Bookings',
                            gridProperties: { frozenRowCount: 1 }
                        } 
                    },
                    { 
                        properties: { 
                            title: 'Summary',
                            gridProperties: { frozenRowCount: 1 }
                        } 
                    }
                ]
            }
        });

        const newSpreadsheetId = response.data.spreadsheetId;
        console.log(`✅ Created new spreadsheet: ${newSpreadsheetId}`);
        console.log(`📊 View at: https://docs.google.com/spreadsheets/d/${newSpreadsheetId}`);
        console.log(`\n⚠️ IMPORTANT: Add this to your .env file:`);
        console.log(`GOOGLE_SHEET_ID=${newSpreadsheetId}\n`);

        await initializeSheetHeaders(newSpreadsheetId);
        return newSpreadsheetId;
    } catch (error) {
        console.error('❌ Failed to get/create spreadsheet:', error.message);
        if (error.response) {
            console.error('❌ Response:', error.response.data);
        }
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

        const bookingsHeaders = [
            'Booking ID', 'Date & Time', 'Restaurant Name', 'Restaurant ID',
            'Customer Name', 'Customer Phone', 'Booking Date', 'Booking Time',
            'Number of Guests', 'Special Requests', 'Status'
        ];

        const summaryHeaders = [
            'Restaurant Name', 'Total Orders', 'Total Bookings', 'Total Revenue',
            'Total Items Sold', 'Avg Order Value', 'Last Updated'
        ];

        await sheetsClient.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
                valueInputOption: 'RAW',
                data: [
                    { range: 'Orders!A1:O1', values: [ordersHeaders] },
                    { range: 'Order Items!A1:I1', values: [itemsHeaders] },
                    { range: 'Bookings!A1:K1', values: [bookingsHeaders] },
                    { range: 'Summary!A1:G1', values: [summaryHeaders] }
                ]
            }
        });

        // Format headers (bold, background color)
        await sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [
                    {
                        repeatCell: {
                            range: {
                                sheetId: 0, // Orders
                                startRowIndex: 0,
                                endRowIndex: 1
                            },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: { red: 0.2, green: 0.6, blue: 1 },
                                    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
                                }
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat)'
                        }
                    },
                    {
                        repeatCell: {
                            range: {
                                sheetId: 1, // Order Items
                                startRowIndex: 0,
                                endRowIndex: 1
                            },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: { red: 0.2, green: 0.6, blue: 1 },
                                    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
                                }
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat)'
                        }
                    },
                    {
                        repeatCell: {
                            range: {
                                sheetId: 2, // Bookings
                                startRowIndex: 0,
                                endRowIndex: 1
                            },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: { red: 0.2, green: 0.6, blue: 1 },
                                    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
                                }
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat)'
                        }
                    },
                    {
                        repeatCell: {
                            range: {
                                sheetId: 3, // Summary
                                startRowIndex: 0,
                                endRowIndex: 1
                            },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: { red: 0.2, green: 0.6, blue: 1 },
                                    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
                                }
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat)'
                        }
                    }
                ]
            }
        });

        console.log('✅ Sheet headers initialized with formatting');
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
            console.log('⚠️ Google Sheets not configured, skipping order log');
            return { success: false, reason: 'not_configured' };
        }

        console.log(`📊 Logging order #${orderData.orderId} to Google Sheets...`);
        
        const spreadsheetId = await getOrCreateSpreadsheet();
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        // Prepare order row
        const orderRow = [
            orderData.orderId,
            timestamp,
            orderData.restaurantName,
            orderData.restaurantId,
            orderData.customerPhone,
            orderData.customerName || 'Customer',
            orderData.orderType || 'delivery',
            orderData.deliveryAddress || 'N/A',
            parseFloat(orderData.subtotal).toFixed(2),
            parseFloat(orderData.deliveryFee).toFixed(2),
            parseFloat(orderData.total).toFixed(2),
            orderData.specialInstructions || 'None',
            orderData.status || 'pending',
            orderData.paymentStatus || 'COD',
            orderData.estimatedDeliveryTime || '45 minutes'
        ];

        // Prepare item rows
        const itemRows = orderData.items.map(item => [
            orderData.orderId,
            timestamp,
            orderData.restaurantName,
            item.name,
            item.category || 'N/A',
            item.quantity,
            parseFloat(item.price).toFixed(2),
            (parseFloat(item.price) * item.quantity).toFixed(2),
            item.is_vegetarian ? 'Yes' : 'No'
        ]);

        // Append order
        await sheetsClient.spreadsheets.values.append({
            spreadsheetId,
            range: 'Orders!A:O',
            valueInputOption: 'RAW',
            requestBody: { values: [orderRow] }
        });

        // Append order items
        if (itemRows.length > 0) {
            await sheetsClient.spreadsheets.values.append({
                spreadsheetId,
                range: 'Order Items!A:I',
                valueInputOption: 'RAW',
                requestBody: { values: itemRows }
            });
        }

        // Update summary
        await updateRestaurantSummary(spreadsheetId, orderData);

        console.log(`✅ Order #${orderData.orderId} logged to Google Sheets successfully`);
        console.log(`📊 View at: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);

        return {
            success: true,
            spreadsheetId,
            url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
        };
    } catch (error) {
        console.error('❌ Failed to log order to Google Sheets:', error.message);
        if (error.response) {
            console.error('❌ Response:', error.response.data);
        }
        return { success: false, error: error.message };
    }
}

/**
 * Log booking to Google Sheets
 */
async function logBookingToSheets(bookingData) {
    try {
        if (!isConfigured) {
            console.log('⚠️ Google Sheets not configured, skipping booking log');
            return { success: false, reason: 'not_configured' };
        }

        console.log(`📊 Logging booking #${bookingData.bookingId} to Google Sheets...`);
        
        const spreadsheetId = await getOrCreateSpreadsheet();
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

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

        console.log(`✅ Booking #${bookingData.bookingId} logged to Google Sheets successfully`);
        console.log(`📊 View at: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);

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

/**
 * Update restaurant summary statistics
 */
async function updateRestaurantSummary(spreadsheetId, orderData) {
    try {
        const summaryResponse = await sheetsClient.spreadsheets.values.get({
            spreadsheetId,
            range: 'Summary!A:G'
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
        let totalBookings = 0;
        let totalRevenue = orderData.total;
        let totalItems = orderData.items.reduce((sum, item) => sum + item.quantity, 0);

        if (restaurantRowIndex >= 0) {
            totalOrders = parseInt(summaryRows[restaurantRowIndex][1] || 0) + 1;
            totalBookings = parseInt(summaryRows[restaurantRowIndex][2] || 0);
            totalRevenue = parseFloat(summaryRows[restaurantRowIndex][3] || 0) + orderData.total;
            totalItems = parseInt(summaryRows[restaurantRowIndex][4] || 0) + orderData.items.reduce((sum, item) => sum + item.quantity, 0);
        }

        const avgOrderValue = totalRevenue / totalOrders;
        const lastUpdated = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        const summaryRow = [
            restaurantName,
            totalOrders,
            totalBookings,
            totalRevenue.toFixed(2),
            totalItems,
            avgOrderValue.toFixed(2),
            lastUpdated
        ];

        if (restaurantRowIndex >= 0) {
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId,
                range: `Summary!A${restaurantRowIndex + 1}:G${restaurantRowIndex + 1}`,
                valueInputOption: 'RAW',
                requestBody: { values: [summaryRow] }
            });
        } else {
            await sheetsClient.spreadsheets.values.append({
                spreadsheetId,
                range: 'Summary!A:G',
                valueInputOption: 'RAW',
                requestBody: { values: [summaryRow] }
            });
        }
    } catch (error) {
        console.error('⚠️ Failed to update summary:', error.message);
    }
}

/**
 * Get spreadsheet URL
 */
function getSpreadsheetUrl() {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    if (spreadsheetId) {
        return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    }
    return null;
}

/**
 * Check if Google Sheets is configured
 */
function getSheetsStatus() {
    return isConfigured;
}

// Initialize on module load
initializeGoogleSheets();

// Run diagnostic test after initialization (delayed to allow server startup)
setTimeout(async () => {
    if (isConfigured) {
        console.log('\n🧪 Running authentication diagnostic test...');
        await testAuthentication();
        console.log('🧪 Diagnostic test complete\n');
    }
}, 5000);

// Export all functions
module.exports = {
    initializeGoogleSheets,
    testAuthentication,
    logOrderToSheets,
    logBookingToSheets,
    getSpreadsheetUrl,
    isConfigured: getSheetsStatus
};
