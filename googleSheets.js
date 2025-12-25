/**
 * ═══════════════════════════════════════════════════════════
 * Google Sheets Logger
 * 
 * Automatically logs appointments to Google Sheets
 * Provides backup, easy sharing, and Excel export
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const { google } = require('googleapis');

// Initialize Google Sheets API
const getGoogleSheetsClient = () => {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    
    if (!email || !privateKey) {
        console.log('⚠️  Google Sheets not configured (GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY missing)');
        return null;
    }
    
    const auth = new google.auth.JWT(
        email,
        null,
        privateKey,
        ['https://www.googleapis.com/auth/spreadsheets']
    );
    
    return google.sheets({ version: 'v4', auth });
};

/**
 * Log appointment to Google Sheets
 * @param {Object} appointment - Appointment data
 * @param {string} sheetId - Google Sheet ID
 */
async function logToGoogleSheets(appointment, sheetId) {
    try {
        const sheets = getGoogleSheetsClient();
        if (!sheets) {
            return { success: false, error: 'Google Sheets not configured' };
        }
        
        // Prepare row data
        const row = [
            appointment.id,                                    // A: ID
            new Date().toISOString(),                          // B: Logged At
            appointment.clinic_name || 'Unknown',              // C: Clinic
            appointment.patient_name || 'Unknown',             // D: Patient Name
            appointment.patient_phone || 'Unknown',            // E: Phone
            appointment.appointment_date || 'N/A',             // F: Date
            appointment.appointment_time || 'N/A',             // G: Time
            appointment.status || 'pending',                   // H: Status
            appointment.doctor_name || 'N/A',                  // I: Doctor
            appointment.approved_at || '',                     // J: Approved At
            appointment.rejected_at || '',                     // K: Rejected At
            appointment.auto_processed ? 'Yes' : 'No',         // L: Auto-Processed
            appointment.reminder_sent ? 'Yes' : 'No',          // M: Reminder Sent
            appointment.created_at || '',                      // N: Created At
        ];
        
        // Append row to sheet
        const response = await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: 'Sheet1!A:N', // Adjust if you use different sheet name
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            resource: {
                values: [row]
            }
        });
        
        console.log(`✅ Logged appointment #${appointment.id} to Google Sheet`);
        
        return {
            success: true,
            updatedRange: response.data.updates.updatedRange,
            updatedRows: response.data.updates.updatedRows
        };
        
    } catch (error) {
        console.error('❌ Google Sheets logging error:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Initialize Google Sheet with headers
 * @param {string} sheetId - Google Sheet ID
 */
async function initializeSheet(sheetId) {
    try {
        const sheets = getGoogleSheetsClient();
        if (!sheets) {
            throw new Error('Google Sheets not configured');
        }
        
        // Check if headers already exist
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Sheet1!A1:N1'
        });
        
        if (response.data.values && response.data.values.length > 0) {
            console.log('✅ Sheet already initialized');
            return { success: true, message: 'Headers already exist' };
        }
        
        // Add headers
        const headers = [
            'ID',
            'Logged At',
            'Clinic',
            'Patient Name',
            'Phone',
            'Appointment Date',
            'Appointment Time',
            'Status',
            'Doctor',
            'Approved At',
            'Rejected At',
            'Auto-Processed',
            'Reminder Sent',
            'Created At'
        ];
        
        await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: 'Sheet1!A1:N1',
            valueInputOption: 'RAW',
            resource: {
                values: [headers]
            }
        });
        
        // Format header row (bold, background color)
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sheetId,
            resource: {
                requests: [
                    {
                        repeatCell: {
                            range: {
                                sheetId: 0,
                                startRowIndex: 0,
                                endRowIndex: 1
                            },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: { red: 0.2, green: 0.6, blue: 1.0 },
                                    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
                                }
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat)'
                        }
                    },
                    {
                        autoResizeDimensions: {
                            dimensions: {
                                sheetId: 0,
                                dimension: 'COLUMNS',
                                startIndex: 0,
                                endIndex: 14
                            }
                        }
                    }
                ]
            }
        });
        
        console.log('✅ Sheet initialized with headers');
        return { success: true, message: 'Headers added' };
        
    } catch (error) {
        console.error('❌ Sheet initialization error:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Get sheet statistics
 * @param {string} sheetId - Google Sheet ID
 */
async function getSheetStats(sheetId) {
    try {
        const sheets = getGoogleSheetsClient();
        if (!sheets) {
            throw new Error('Google Sheets not configured');
        }
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Sheet1!A:N'
        });
        
        const rows = response.data.values || [];
        const totalRows = rows.length - 1; // Exclude header
        
        // Count by status
        const stats = {
            total: totalRows,
            pending: 0,
            confirmed: 0,
            rejected: 0,
            auto_processed: 0,
            reminders_sent: 0
        };
        
        rows.slice(1).forEach(row => {
            const status = row[7]?.toLowerCase();
            if (status === 'pending') stats.pending++;
            if (status === 'confirmed') stats.confirmed++;
            if (status === 'rejected') stats.rejected++;
            if (row[11] === 'Yes') stats.auto_processed++;
            if (row[12] === 'Yes') stats.reminders_sent++;
        });
        
        return stats;
        
    } catch (error) {
        console.error('❌ Stats error:', error.message);
        return null;
    }
}

module.exports = {
    logToGoogleSheets,
    initializeSheet,
    getSheetStats
};
