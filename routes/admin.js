const express = require('express');
const router = express.Router();
const { neon } = require('@neondatabase/serverless');
const { requireApiKey } = require('../middleware/security');

const sql = neon(process.env.DATABASE_URL);

// Apply API key authentication to all admin routes
router.use(requireApiKey);

/**
 * GET /api/admin/stats
 * Overall system statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await sql`
            SELECT 
                (SELECT COUNT(*) FROM clinics WHERE status = 'active') as active_clinics,
                (SELECT COUNT(*) FROM customers) as total_customers,
                (SELECT COUNT(*) FROM appointments WHERE status = 'pending') as pending_appointments,
                (SELECT COUNT(*) FROM appointments WHERE created_at > NOW() - INTERVAL '24 hours') as appointments_24h,
                (SELECT COUNT(*) FROM appointments WHERE auto_approved = true) as total_auto_approved,
                (SELECT COUNT(*) FROM appointments WHERE auto_rejected = true) as total_auto_rejected
        `;
        
        res.json({
            success: true,
            data: stats[0],
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/admin/clinics
 * List all clinics
 */
router.get('/clinics', async (req, res) => {
    try {
        const clinics = await sql`
            SELECT 
                c.*,
                COUNT(a.id) as total_appointments,
                COUNT(a.id) FILTER (WHERE a.status = 'pending') as pending_appointments
            FROM clinics c
            LEFT JOIN appointments a ON c.id = a.clinic_id
            GROUP BY c.id
            ORDER BY c.id
        `;
        
        res.json({ success: true, data: clinics });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/admin/clinic/:id/toggle
 * Enable/disable a clinic
 */
router.post('/clinic/:id/toggle', async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await sql`
            UPDATE clinics
            SET status = CASE 
                WHEN status = 'active' THEN 'inactive'
                ELSE 'active'
            END,
            updated_at = NOW()
            WHERE id = ${id}
            RETURNING *
        `;
        
        res.json({ success: true, data: result[0] });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/admin/appointments/pending
 * Get all pending appointments
 */
router.get('/appointments/pending', async (req, res) => {
    try {
        const pending = await sql`
            SELECT 
                a.*,
                c.name as clinic_name,
                EXTRACT(EPOCH FROM (NOW() - a.created_at))/3600 as hours_pending
            FROM appointments a
            JOIN clinics c ON a.clinic_id = c.id
            WHERE a.status = 'pending'
            ORDER BY a.created_at ASC
        `;
        
        res.json({ success: true, data: pending });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/admin/appointment/:id/approve
 * Manually approve appointment
 */
router.post('/appointment/:id/approve', async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await sql`
            UPDATE appointments
            SET 
                status = 'confirmed',
                approved_at = NOW(),
                updated_at = NOW()
            WHERE id = ${id}
            RETURNING *
        `;
        
        res.json({ success: true, data: result[0] });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
