const express = require('express');
const router = express.Router();
const db = require('../config/database');

/**
 * Doctor Dashboard - Web view
 */
router.get('/doctor/dashboard/:clinicId', async (req, res) => {
    try {
        const { clinicId } = req.params;
        
        // Get clinic info
        const clinic = await db.query(
            `SELECT * FROM clinics WHERE id = $1`,
            [clinicId]
        );
        
        if (clinic.rows.length === 0) {
            return res.status(404).send('Clinic not found');
        }
        
        // Get pending appointments
        const pending = await db.query(
            `SELECT a.*, c.name as customer_name, c.phone
             FROM appointments a
             LEFT JOIN customers c ON a.customer_id = c.id
             WHERE a.clinic_id = $1 AND a.status = 'pending'
             ORDER BY a.appointment_date, a.appointment_slot`,
            [clinicId]
        );
        
        // Get today's appointments
        const today = await db.query(
            `SELECT a.*, c.name as customer_name, c.phone
             FROM appointments a
             LEFT JOIN customers c ON a.customer_id = c.id
             WHERE a.clinic_id = $1 
             AND a.appointment_date = CURRENT_DATE
             AND a.status IN ('pending', 'confirmed')
             ORDER BY a.appointment_slot`,
            [clinicId]
        );
        
        // Get statistics
        const stats = await db.query(
            `SELECT 
                COUNT(*) FILTER (WHERE status = 'pending') as pending,
                COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed,
                COUNT(*) FILTER (WHERE status = 'completed') as completed,
                COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled
             FROM appointments WHERE clinic_id = $1`,
            [clinicId]
        );
        
        // Render HTML
        const html = generateDashboardHTML(
            clinic.rows[0],
            pending.rows,
            today.rows,
            stats.rows[0]
        );
        
        res.send(html);
        
    } catch (error) {
        console.error('Dashboard error:', error.message);
        res.status(500).send('Error loading dashboard');
    }
});

/**
 * API: Approve appointment
 */
router.post('/api/doctor/approve/:appointmentId', async (req, res) => {
    try {
        const { appointmentId } = req.params;
        
        await db.query(
            `UPDATE appointments 
             SET status = 'confirmed', confirmed_at = NOW()
             WHERE id = $1`,
            [appointmentId]
        );
        
        res.json({ success: true, message: 'Appointment approved' });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * API: Reject appointment
 */
router.post('/api/doctor/reject/:appointmentId', async (req, res) => {
    try {
        const { appointmentId } = req.params;
        
        await db.query(
            `UPDATE appointments 
             SET status = 'rejected'
             WHERE id = $1`,
            [appointmentId]
        );
        
        res.json({ success: true, message: 'Appointment rejected' });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Generate Dashboard HTML
 */
function generateDashboardHTML(clinic, pending, today, stats) {
    return `
<!DOCTYPE html>
<html>
<head>
    <title>${clinic.name} - Doctor Dashboard</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f5f5;
            padding: 20px;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 10px;
            margin-bottom: 20px;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .stat-card h3 { color: #666; font-size: 14px; margin-bottom: 10px; }
        .stat-card .number { font-size: 32px; font-weight: bold; color: #667eea; }
        .section {
            background: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .section h2 { margin-bottom: 20px; color: #333; }
        .appointment {
            border: 1px solid #e0e0e0;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 15px;
        }
        .appointment.pending { border-left: 4px solid #ffa726; }
        .appointment.confirmed { border-left: 4px solid #66bb6a; }
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-weight: bold;
            margin-right: 10px;
        }
        .btn-approve { background: #66bb6a; color: white; }
        .btn-reject { background: #ef5350; color: white; }
        .btn:hover { opacity: 0.9; }
        .empty { text-align: center; color: #999; padding: 40px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🩺 ${clinic.name}</h1>
            <p>Dr. ${clinic.doctor_name}</p>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <h3>⏳ Pending</h3>
                <div class="number">${stats.pending}</div>
            </div>
            <div class="stat-card">
                <h3>✅ Confirmed</h3>
                <div class="number">${stats.confirmed}</div>
            </div>
            <div class="stat-card">
                <h3>✔️ Completed</h3>
                <div class="number">${stats.completed}</div>
            </div>
            <div class="stat-card">
                <h3>❌ Cancelled</h3>
                <div class="number">${stats.cancelled}</div>
            </div>
        </div>
        
        <div class="section">
            <h2>⏳ Pending Approvals (${pending.length})</h2>
            ${pending.length === 0 ? '<div class="empty">✨ All caught up!</div>' : ''}
            ${pending.map(appt => `
                <div class="appointment pending">
                    <strong>📋 #${appt.id}</strong> | 
                    👤 ${appt.patient_name} | 
                    📞 ${appt.patient_phone}<br>
                    📅 ${new Date(appt.appointment_date).toLocaleDateString('en-IN')} | 
                    🕒 ${appt.appointment_slot}
                    <br><br>
                    <button class="btn btn-approve" onclick="approveAppointment(${appt.id})">
                        ✅ Approve
                    </button>
                    <button class="btn btn-reject" onclick="rejectAppointment(${appt.id})">
                        ❌ Reject
                    </button>
                </div>
            `).join('')}
        </div>
        
        <div class="section">
            <h2>📅 Today's Schedule (${today.length})</h2>
            ${today.length === 0 ? '<div class="empty">No appointments today</div>' : ''}
            ${today.map(appt => `
                <div class="appointment ${appt.status}">
                    ${appt.status === 'confirmed' ? '✅' : '⏳'} 
                    <strong>${appt.appointment_slot}</strong> | 
                    ${appt.patient_name} (#${appt.id}) | 
                    ${appt.patient_phone}
                </div>
            `).join('')}
        </div>
    </div>
    
    <script>
        function approveAppointment(id) {
            if (!confirm('Approve appointment #' + id + '?')) return;
            
            fetch('/api/doctor/approve/' + id, { method: 'POST' })
                .then(r => r.json())
                .then(data => {
                    alert(data.message);
                    location.reload();
                })
                .catch(err => alert('Error: ' + err.message));
        }
        
        function rejectAppointment(id) {
            if (!confirm('Reject appointment #' + id + '?')) return;
            
            fetch('/api/doctor/reject/' + id, { method: 'POST' })
                .then(r => r.json())
                .then(data => {
                    alert(data.message);
                    location.reload();
                })
                .catch(err => alert('Error: ' + err.message));
        }
    </script>
</body>
</html>
    `;
}

module.exports = router;
