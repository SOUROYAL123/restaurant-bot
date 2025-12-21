// utils/googleSheetsLogger.js
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

class GoogleSheetsLogger {
    constructor() {
        this.serviceAccountAuth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    }

    async logAppointment(clinicSheetId, appointmentData) {
        try {
            if (!clinicSheetId) {
                console.log('⚠️ No Google Sheet ID configured for this clinic');
                return false;
            }

            const doc = new GoogleSpreadsheet(clinicSheetId, this.serviceAccountAuth);
            await doc.loadInfo();

            // Get or create "Appointments" sheet
            let sheet = doc.sheetsByTitle['Appointments'];
            if (!sheet) {
                sheet = await doc.addSheet({ 
                    title: 'Appointments',
                    headerValues: [
                        'ID', 'Date', 'Time', 'Patient Name', 'Patient Phone',
                        'Status', 'Doctor', 'Created At', 'Approved At', 'Notes'
                    ]
                });
            }

            // Add row
            await sheet.addRow({
                'ID': appointmentData.id,
                'Date': appointmentData.appointment_date,
                'Time': appointmentData.appointment_time,
                'Patient Name': appointmentData.patient_name,
                'Patient Phone': appointmentData.patient_phone,
                'Status': appointmentData.status,
                'Doctor': appointmentData.doctor_name || '',
                'Created At': new Date().toLocaleString('en-IN'),
                'Approved At': appointmentData.approved_at || '',
                'Notes': appointmentData.notes || ''
            });

            console.log(`✅ Logged appointment #${appointmentData.id} to Google Sheets`);
            return true;

        } catch (error) {
            console.error('❌ Google Sheets logging error:', error.message);
            return false;
        }
    }

    async updateAppointmentStatus(clinicSheetId, appointmentId, newStatus, approvedAt = null) {
        try {
            if (!clinicSheetId) return false;

            const doc = new GoogleSpreadsheet(clinicSheetId, this.serviceAccountAuth);
            await doc.loadInfo();

            const sheet = doc.sheetsByTitle['Appointments'];
            if (!sheet) return false;

            const rows = await sheet.getRows();
            const row = rows.find(r => r.get('ID') == appointmentId);

            if (row) {
                row.set('Status', newStatus);
                if (approvedAt) {
                    row.set('Approved At', approvedAt);
                }
                await row.save();
                console.log(`✅ Updated appointment #${appointmentId} status in Google Sheets`);
                return true;
            }

            return false;

        } catch (error) {
            console.error('❌ Error updating Google Sheets:', error.message);
            return false;
        }
    }
}

module.exports = new GoogleSheetsLogger();
