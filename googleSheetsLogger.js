// utils/googleSheetsLogger.js
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

class GoogleSheetsLogger {
    constructor() {
        if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
            console.log('⚠️ Google Sheets credentials not configured');
            this.enabled = false;
            return;
        }

        try {
            // Clean the private key - handle both escaped and unescaped newlines
            let privateKey = process.env.GOOGLE_PRIVATE_KEY;
            
            // Remove quotes if present
            privateKey = privateKey.replace(/^["']|["']$/g, '');
            
            // Replace literal \n with actual newlines
            privateKey = privateKey.replace(/\\n/g, '\n');
            
            this.serviceAccountAuth = new JWT({
                email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
                key: privateKey,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
            
            this.enabled = true;
            console.log('✅ Google Sheets configured successfully');
            
        } catch (error) {
            console.error('❌ Google Sheets setup error:', error.message);
            console.log('⚠️ Google Sheets logging disabled');
            this.enabled = false;
        }
    }

    async logAppointment(clinicSheetId, appointmentData) {
        if (!this.enabled) {
            console.log('⚠️ Google Sheets not enabled - skipping log');
            return false;
        }

        try {
            // Your existing code...
            
        } catch (error) {
            console.error('❌ Google Sheets logging error:', error.message);
            // Don't throw - just return false so the app continues
            return false;
        }
    }

    async updateAppointmentStatus(clinicSheetId, appointmentId, newStatus, approvedAt = null) {
        if (!this.enabled) {
            return false;
        }

        try {
            // Your existing code...
            
        } catch (error) {
            console.error('❌ Error updating Google Sheets:', error.message);
            // Don't throw - just return false
            return false;
        }
    }
}

module.exports = new GoogleSheetsLogger();
