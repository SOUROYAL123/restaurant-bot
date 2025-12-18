const express = require('express');
const router = express.Router();
const db = require('../config/database');

/**
 * Analytics API for clinic dashboard
 * Mount at: app.use('/api/analytics', analyticsRouter)
 */

/**
 * GET /api/analytics/:clinicId/overview
 * Overall clinic metrics
 */
router.get('/:clinicId/overview', async (req, res) => {
    try {
        const { clinicId } = req.params;
        
        const result = await db.query(`
            SELECT 
                (SELECT COUNT(*) FROM appointments WHERE clinic_id = $1) as total_appointments,
                (SELECT COUNT(*) FROM appointments WHERE clinic_id = $1 AND status = 'confirmed') as confirmed_appointments,
                (SELECT COUNT(*) FROM appointments WHERE clinic_id = $1 AND status = 'pending') as pending_appointments,
                (SELECT COUNT(*) FROM appointments WHERE clinic_id = $1 AND status = 'cancelled') as cancelled_appointments,
                (SELECT COUNT(*) FROM customers WHERE clinic_id = $1) as total_customers,
                (SELECT COUNT(*) FROM customers WHERE clinic_id = $1 AND last_contact_date > NOW() - INTERVAL '30 days') as active_customers_30d,
                (SELECT ROUND(AVG(feedback_rating), 2) FROM appointments WHERE clinic_id = $1 AND feedback_rating IS NOT NULL) as avg_rating
        `, [clinicId]);
        
        res.json({
            success: true,
            data: result.rows[0]
        });
        
    } catch (error) {
        console.error('Analytics overview error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/analytics/:clinicId/daily
 * Daily appointment trends
 */
router.get('/:clinicId/daily', async (req, res) => {
    try {
        const { clinicId } = req.params;
        const { days = 30 } = req.query;
        
        const result = await db.query(`
            SELECT 
                DATE(appointment_date) as date,
                COUNT(*) as total_appointments,
                COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed,
                COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled
            FROM appointments
            WHERE clinic_id = $1
              AND appointment_date > CURRENT_DATE - INTERVAL '${days} days'
            GROUP BY DATE(appointment_date)
            ORDER BY date DESC
        `, [clinicId]);
        
        res.json({
            success: true,
            data: result.rows
        });
        
    } catch (error) {
        console.error('Analytics daily error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/analytics/:clinicId/peak-hours
 * Busiest time slots
 */
router.get('/:clinicId/peak-hours', async (req, res) => {
    try {
        const { clinicId } = req.params;
        
        const result = await db.query(`
            SELECT 
                appointment_time,
                COUNT(*) as bookings
            FROM appointments
            WHERE clinic_id = $1
              AND status IN ('confirmed', 'completed')
              AND appointment_date > CURRENT_DATE - INTERVAL '90 days'
            GROUP BY appointment_time
            ORDER BY bookings DESC
            LIMIT 10
        `, [clinicId]);
        
        res.json({
            success: true,
            data: result.rows
        });
        
    } catch (error) {
        console.error('Analytics peak hours error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/analytics/:clinicId/customer-retention
 * Retention metrics
 */
router.get('/:clinicId/customer-retention', async (req, res) => {
    try {
        const { clinicId } = req.params;
        
        const result = await db.query(`
            SELECT 
                COUNT(*) as total_customers,
                COUNT(CASE WHEN total_appointments = 1 THEN 1 END) as one_time_customers,
                COUNT(CASE WHEN total_appointments >= 2 THEN 1 END) as repeat_customers,
                ROUND(100.0 * COUNT(CASE WHEN total_appointments >= 2 THEN 1 END) / NULLIF(COUNT(*), 0), 2) as retention_rate,
                AVG(total_appointments) as avg_appointments_per_customer
            FROM customers
            WHERE clinic_id = $1
        `, [clinicId]);
        
        res.json({
            success: true,
            data: result.rows[0]
        });
        
    } catch (error) {
        console.error('Analytics retention error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/analytics/:clinicId/language-breakdown
 * Language preference distribution
 */
router.get('/:clinicId/language-breakdown', async (req, res) => {
    try {
        const { clinicId } = req.params;
        
        const result = await db.query(`
            SELECT 
                preferred_language as language,
                COUNT(*) as customer_count,
                ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER(), 2) as percentage
            FROM customers
            WHERE clinic_id = $1
            GROUP BY preferred_language
            ORDER BY customer_count DESC
        `, [clinicId]);
        
        res.json({
            success: true,
            data: result.rows
        });
        
    } catch (error) {
        console.error('Analytics language error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/analytics/:clinicId/top-customers
 * Most frequent customers
 */
router.get('/:clinicId/top-customers', async (req, res) => {
    try {
        const { clinicId } = req.params;
        const { limit = 10 } = req.query;
        
        const result = await db.query(`
            SELECT 
                name,
                phone_number,
                total_appointments,
                total_completed,
                total_cancelled,
                last_contact_date,
                preferred_language
            FROM customers
            WHERE clinic_id = $1
            ORDER BY total_appointments DESC
            LIMIT $2
        `, [clinicId, limit]);
        
        res.json({
            success: true,
            data: result.rows
        });
        
    } catch (error) {
        console.error('Analytics top customers error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/analytics/:clinicId/cancellation-rate
 * Cancellation metrics
 */
router.get('/:clinicId/cancellation-rate', async (req, res) => {
    try {
        const { clinicId } = req.params;
        
        const result = await db.query(`
            SELECT 
                DATE_TRUNC('month', appointment_date) as month,
                COUNT(*) as total_appointments,
                COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled,
                ROUND(100.0 * COUNT(CASE WHEN status = 'cancelled' THEN 1 END) / NULLIF(COUNT(*), 0), 2) as cancellation_rate
            FROM appointments
            WHERE clinic_id = $1
              AND appointment_date > CURRENT_DATE - INTERVAL '12 months'
            GROUP BY DATE_TRUNC('month', appointment_date)
            ORDER BY month DESC
        `, [clinicId]);
        
        res.json({
            success: true,
            data: result.rows
        });
        
    } catch (error) {
        console.error('Analytics cancellation error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
