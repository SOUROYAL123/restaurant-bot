const express = require('express');
const router = express.Router();
const db = require('../config/database');

/**
 * Minimal Analytics API
 * GET /api/analytics/:clinicId/overview
 */
router.get('/:clinicId/overview', async (req, res) => {
    try {
        const { clinicId } = req.params;
        
        const result = await db.query(`
            SELECT 
                COUNT(*) as total_appointments
            FROM appointments 
            WHERE clinic_id = $1
        `, [clinicId]);
        
        res.json({
            success: true,
            data: {
                clinic_id: clinicId,
                total_appointments: result.rows[0]?.total_appointments || 0,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Health check for analytics
 */
router.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        service: 'analytics',
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
