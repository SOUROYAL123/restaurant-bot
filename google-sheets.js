// google-sheets.js
// Google Sheets Integration for Order & Booking Logging

const { google } = require('googleapis');

// =====================================================
// GOOGLE SHEETS CONFIGURATION
// =====================================================

let sheetsClient = null;
let isConfigured = false;

/**
 * Initialize Google Sheets client
 */
function initializeGoogleSheets() {
    try {
        if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
            console.log('⚠️ Google Sheets not configured (missing credentials)');
            return false;
        }

        const auth = new google.auth.JWT(
            process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            null,
            process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            ['https://www.googleapis.com/auth/spreadsheets']
        );

        sheetsClient = google.sheets({ version: 'v4', auth });
        isConfigured = true;
        console.log('✅ Google Sheets initialized successfully');
        return true;
    } catch (error) {
        console.error('❌ Failed to initialize Google Sheets:', error.message);
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
            // Verify spreadsheet exists
            try {
                await sheetsClient.spreadsheets.get({ spreadsheetId });
                return spreadsheetId;
            } catch (error) {
                console.log('⚠️ Spreadsheet ID not found, will create new one');
            }
        }

        // Create new spreadsheet
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
                                frozenRowCount: 1
                            }
                        }
                    },
                    {
                        properties: {
                            title: 'Order Items',
                            gridProperties: {
                                frozenRowCount: 1
                            }
                        }
                    },
                    {
                        properties: {
                            title: 'Summary',
                            gridProperties: {
                                frozenRowCount: 1
                            }
                        }
                    }
                ]
            }
        });

        const newSpreadsheetId = response.data.spreadsheetId;
        console.log(`✅ Created new spreadsheet: ${newSpreadsheetId}`);
        console.log(`📊 View at: https://docs.google.com/spreadsheets/d/${newSpreadsheetId}`);

        // Initialize headers
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
        // Orders sheet headers
        const ordersHeaders = [
            'Order ID',
            'Date & Time',
            'Restaurant Name',
            'Restaurant ID',
            'Customer Phone',
            'Customer Name',
            'Order Type',
            'Delivery Address',
            'Subtotal',
            'Delivery Fee',
            'Total Amount',
            'Special Instructions',
            'Status',
            'Payment Status',
            'Estimated Delivery'
        ];

        // Order Items sheet headers
        const itemsHeaders = [
            'Order ID',
            'Date & Time',
            'Restaurant Name',
            'Item Name',
            'Category',
            'Quantity',
            'Unit Price',
            'Subtotal',
            'Is Vegetarian'
        ];

        // Summary sheet headers
        const summaryHeaders = [
            'Restaurant Name',
            'Total Orders',
            'Total Revenue',
            'Total Items Sold',
            'Avg Order Value',
            'Last Order Date'
        ];

        // Write headers
        await sheetsClient.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
                valueInputOption: 'RAW',
                data: [
                    {
                        range: 'Orders!A1:O1',
                        values: [ordersHeaders]
                    },
                    {
                        range: 'Order Items!A1:I1',
                        values: [itemsHeaders]
                    },
                    {
                        range: 'Summary!A1:F1',
                        values: [summaryHeaders]
                    }
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
                                sheetId: 0, // Orders sheet
                                startRowIndex: 0,
                                endRowIndex: 1
                            },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: { red: 0.2, green: 0.6, blue: 1 },
                                    textFormat: {
                                        bold: true,
                                        foregroundColor: { red: 1, green: 1, blue: 1 }
                                    }
                                }
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat)'
                        }
                    },
                    {
                        repeatCell: {
                            range: {
                                sheetId: 1, // Order Items sheet
                                startRowIndex: 0,
                                endRowIndex: 1
                            },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: { red: 0.2, green: 0.8, blue: 0.6 },
                                    textFormat: {
                                        bold: true,
                                        foregroundColor: { red: 1, green: 1, blue: 1 }
                                    }
                                }
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat)'
                        }
                    },
                    {
                        repeatCell: {
                            range: {
                                sheetId: 2, // Summary sheet
                                startRowIndex: 0,
                                endRowIndex: 1
                            },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: { red: 1, green: 0.6, blue: 0.2 },
                                    textFormat: {
                                        bold: true,
                                        foregroundColor: { red: 1, green: 1, blue: 1 }
                                    }
                                }
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat)'
                        }
                    }
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
            orderData.subtotal.toFixed(2),
            orderData.deliveryFee.toFixed(2),
            orderData.total.toFixed(2),
            orderData.specialInstructions || 'None',
            orderData.status || 'pending',
            orderData.paymentStatus || 'pending',
            orderData.estimatedDeliveryTime || 'N/A'
        ];

        // Prepare order items rows
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

        // Append to sheets
        await sheetsClient.spreadsheets.values.append({
            spreadsheetId,
            range: 'Orders!A:O',
            valueInputOption: 'RAW',
            requestBody: {
                values: [orderRow]
            }
        });

        await sheetsClient.spreadsheets.values.append({
            spreadsheetId,
            range: 'Order Items!A:I',
            valueInputOption: 'RAW',
            requestBody: {
                values: itemRows
            }
        });

        // Update summary
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
        // Get existing summary data
        const summaryResponse = await sheetsClient.spreadsheets.values.get({
            spreadsheetId,
            range: 'Summary!A:F'
        });

        const summaryRows = summaryResponse.data.values || [[]];
        const restaurantName = orderData.restaurantName;

        // Find restaurant row
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
            // Update existing row
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
            // Update existing row
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId,
                range: `Summary!A${restaurantRowIndex + 1}:F${restaurantRowIndex + 1}`,
                valueInputOption: 'RAW',
                requestBody: {
                    values: [summaryRow]
                }
            });
        } else {
            // Append new row
            await sheetsClient.spreadsheets.values.append({
                spreadsheetId,
                range: 'Summary!A:F',
                valueInputOption: 'RAW',
                requestBody: {
                    values: [summaryRow]
                }
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

        // Check if Bookings sheet exists, create if not
        try {
            await sheetsClient.spreadsheets.values.get({
                spreadsheetId,
                range: 'Bookings!A1'
            });
        } catch (error) {
            // Create Bookings sheet
            await sheetsClient.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{
                        addSheet: {
                            properties: {
                                title: 'Bookings',
                                gridProperties: {
                                    frozenRowCount: 1
                                }
                            }
                        }
                    }]
                }
            });

            // Add headers
            const headers = [
                'Booking ID',
                'Date & Time',
                'Restaurant Name',
                'Restaurant ID',
                'Customer Name',
                'Customer Phone',
                'Booking Date',
                'Booking Time',
                'Number of Guests',
                'Special Requests',
                'Status'
            ];

            await sheetsClient.spreadsheets.values.update({
                spreadsheetId,
                range: 'Bookings!A1:K1',
                valueInputOption: 'RAW',
                requestBody: {
                    values: [headers]
                }
            });
        }

        // Prepare booking row
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

        // Append to sheet
        await sheetsClient.spreadsheets.values.append({
            spreadsheetId,
            range: 'Bookings!A:K',
            valueInputOption: 'RAW',
            requestBody: {
                values: [bookingRow]
            }
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

// Initialize on module load
initializeGoogleSheets();

module.exports = {
    initializeGoogleSheets,
    logOrderToSheets,
    logBookingToSheets,
    getSpreadsheetUrl,
    isConfigured: () => isConfigured
};
