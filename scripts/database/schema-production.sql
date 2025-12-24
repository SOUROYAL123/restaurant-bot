-- =====================================================
-- PRODUCTION DATABASE SCHEMA
-- WhatsApp Multi-Clinic Bot with Auto-Approval
-- =====================================================

-- Enable UUID extension (optional, for future use)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- 1. CLINICS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS clinics (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    doctor_name VARCHAR(100) NOT NULL,
    doctor_whatsapp VARCHAR(50) NOT NULL,
    
    -- Contact Info
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    phone VARCHAR(20),
    email VARCHAR(100),
    
    -- Business Hours
    business_hours_start VARCHAR(20) DEFAULT '09:00 AM',
    business_hours_end VARCHAR(20) DEFAULT '06:00 PM',
    timezone VARCHAR(50) DEFAULT 'Asia/Kolkata',
    
    -- Auto-Approval Settings
    auto_approve BOOLEAN DEFAULT false,
    auto_approve_after_hours INTEGER DEFAULT 24,
    auto_reject BOOLEAN DEFAULT false,
    auto_reject_after_hours INTEGER DEFAULT 48,
    
    -- Google Sheets Integration
    google_sheet_id VARCHAR(100),
    
    -- Metadata
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT unique_doctor_whatsapp UNIQUE (doctor_whatsapp)
);

COMMENT ON TABLE clinics IS 'Stores clinic information with auto-approval settings';
COMMENT ON COLUMN clinics.auto_approve IS 'Enable automatic appointment approval';
COMMENT ON COLUMN clinics.auto_approve_after_hours IS 'Hours to wait before auto-approving';
COMMENT ON COLUMN clinics.auto_reject IS 'Enable automatic appointment rejection';
COMMENT ON COLUMN clinics.auto_reject_after_hours IS 'Hours to wait before auto-rejecting';

-- =====================================================
-- 2. CUSTOMERS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    
    -- Contact Info
    phone VARCHAR(20) NOT NULL,
    name VARCHAR(100),
    email VARCHAR(100),
    
    -- Preferences
    preferred_language VARCHAR(5) DEFAULT 'en' CHECK (preferred_language IN ('en', 'hi', 'bn')),
    
    -- Demographics (Optional)
    age INTEGER,
    gender VARCHAR(20),
    location VARCHAR(200),
    
    -- Engagement Tracking
    first_contact_date TIMESTAMP DEFAULT NOW(),
    last_contact_date TIMESTAMP DEFAULT NOW(),
    total_appointments INTEGER DEFAULT 0,
    total_cancelled INTEGER DEFAULT 0,
    total_completed INTEGER DEFAULT 0,
    
    -- Communication Preferences
    notifications_enabled BOOLEAN DEFAULT true,
    
    -- Metadata
    notes TEXT,
    tags VARCHAR(50)[],
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'blocked')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT unique_customer_per_clinic UNIQUE (phone, clinic_id)
);

COMMENT ON TABLE customers IS 'Customer database with engagement tracking';

-- =====================================================
-- 3. APPOINTMENTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS appointments (
    id SERIAL PRIMARY KEY,
    clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    
    -- Patient Info (denormalized for faster queries)
    patient_name VARCHAR(100) NOT NULL,
    patient_phone VARCHAR(20) NOT NULL,
    
    -- Appointment Details
    appointment_date DATE NOT NULL,
    appointment_time VARCHAR(20) NOT NULL,
    appointment_slot VARCHAR(20), -- Formatted slot like "10:00 AM"
    service VARCHAR(100),
    
    -- Status Management
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled', 'completed', 'no_show')),
    
    -- Approval Tracking
    approved_at TIMESTAMP,
    rejected_at TIMESTAMP,
    auto_approved BOOLEAN DEFAULT false,
    auto_rejected BOOLEAN DEFAULT false,
    confirmed_at TIMESTAMP,
    completed_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    
    -- Additional Info
    notes TEXT,
    cancellation_reason TEXT,
    doctor_notes TEXT,
    
    -- Reminders
    reminder_sent BOOLEAN DEFAULT false,
    reminder_sent_at TIMESTAMP,
    
    -- Feedback
    feedback_rating INTEGER CHECK (feedback_rating BETWEEN 1 AND 5),
    feedback_comment TEXT,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    -- Indexes will be created separately
    CONSTRAINT valid_appointment_time CHECK (appointment_time ~ '^[0-9]{1,2}:[0-9]{2} (AM|PM)$')
);

COMMENT ON TABLE appointments IS 'Appointment bookings with approval workflow';
COMMENT ON COLUMN appointments.auto_approved IS 'Was this auto-approved by system?';
COMMENT ON COLUMN appointments.auto_rejected IS 'Was this auto-rejected by system?';

-- =====================================================
-- 4. SESSIONS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    user_phone VARCHAR(20) NOT NULL UNIQUE,
    clinic_id INTEGER REFERENCES clinics(id) ON DELETE SET NULL,
    
    -- Session State
    stage VARCHAR(50) DEFAULT 'select_clinic',
    language VARCHAR(5) DEFAULT 'en',
    session_data JSONB DEFAULT '{}',
    
    -- Timestamps
    last_activity TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE sessions IS 'WhatsApp conversation session management';

-- =====================================================
-- 5. CUSTOMER INTERACTIONS TABLE (ANALYTICS)
-- =====================================================
CREATE TABLE IF NOT EXISTS customer_interactions (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    clinic_id INTEGER REFERENCES clinics(id) ON DELETE CASCADE,
    
    -- Interaction Details
    interaction_type VARCHAR(50) NOT NULL,
    message_direction VARCHAR(20) CHECK (message_direction IN ('inbound', 'outbound')),
    message_body TEXT,
    
    -- Session Context
    session_data JSONB,
    
    -- Timestamp
    created_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE customer_interactions IS 'Logs all customer interactions for analytics';

-- =====================================================
-- 6. PENDING MESSAGES TABLE (MESSAGE QUEUE)
-- =====================================================
CREATE TABLE IF NOT EXISTS pending_messages (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    sent_at TIMESTAMP
);

COMMENT ON TABLE pending_messages IS 'Queue for outbound WhatsApp messages';

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

-- Clinics
CREATE INDEX IF NOT EXISTS idx_clinics_status ON clinics(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_clinics_doctor_whatsapp ON clinics(doctor_whatsapp);

-- Customers
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_clinic ON customers(clinic_id);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_last_contact ON customers(last_contact_date DESC);

-- Appointments (CRITICAL for performance)
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_status ON appointments(clinic_id, status);
CREATE INDEX IF NOT EXISTS idx_appointments_customer ON appointments(customer_id);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_pending ON appointments(clinic_id, status, created_at) 
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_appointments_created ON appointments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(patient_phone);

-- Sessions
CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(user_phone);
CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_clinic ON sessions(clinic_id);

-- Interactions
CREATE INDEX IF NOT EXISTS idx_interactions_customer ON customer_interactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_interactions_clinic ON customer_interactions(clinic_id);
CREATE INDEX IF NOT EXISTS idx_interactions_created ON customer_interactions(created_at DESC);

-- Pending Messages
CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status) WHERE status = 'pending';

-- =====================================================
-- TRIGGERS FOR AUTO-UPDATE
-- =====================================================

-- Update updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_clinics_updated_at BEFORE UPDATE ON clinics
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_appointments_updated_at BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_sessions_updated_at BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- VIEWS FOR ANALYTICS
-- =====================================================

-- Clinic Performance Dashboard
CREATE OR REPLACE VIEW clinic_performance AS
SELECT 
    c.id,
    c.name,
    c.doctor_name,
    COUNT(a.id) as total_appointments,
    COUNT(a.id) FILTER (WHERE a.status = 'pending') as pending,
    COUNT(a.id) FILTER (WHERE a.status = 'confirmed') as confirmed,
    COUNT(a.id) FILTER (WHERE a.status = 'completed') as completed,
    COUNT(a.id) FILTER (WHERE a.status = 'cancelled') as cancelled,
    COUNT(a.id) FILTER (WHERE a.auto_approved = true) as auto_approved,
    COUNT(a.id) FILTER (WHERE a.auto_rejected = true) as auto_rejected,
    ROUND(AVG(a.feedback_rating), 2) as avg_rating,
    COUNT(DISTINCT a.patient_phone) as unique_patients
FROM clinics c
LEFT JOIN appointments a ON c.id = a.clinic_id
GROUP BY c.id, c.name, c.doctor_name;

-- Pending Appointments Report
CREATE OR REPLACE VIEW pending_appointments_report AS
SELECT 
    a.id,
    a.clinic_id,
    c.name as clinic_name,
    a.patient_name,
    a.patient_phone,
    a.appointment_date,
    a.appointment_time,
    a.status,
    EXTRACT(EPOCH FROM (NOW() - a.created_at))/3600 as hours_pending,
    c.auto_approve_after_hours,
    c.auto_reject_after_hours,
    CASE 
        WHEN c.auto_approve = true 
             AND EXTRACT(EPOCH FROM (NOW() - a.created_at))/3600 >= c.auto_approve_after_hours
        THEN true
        ELSE false
    END as ready_for_auto_approve,
    CASE 
        WHEN c.auto_reject = true 
             AND EXTRACT(EPOCH FROM (NOW() - a.created_at))/3600 >= c.auto_reject_after_hours
        THEN true
        ELSE false
    END as ready_for_auto_reject
FROM appointments a
JOIN clinics c ON a.clinic_id = c.id
WHERE a.status = 'pending'
ORDER BY a.created_at ASC;

-- =====================================================
-- INITIAL DATA (SAMPLE)
-- =====================================================

-- Insert default clinic (you can modify this)
INSERT INTO clinics (
    id, name, doctor_name, doctor_whatsapp,
    auto_approve, auto_approve_after_hours,
    auto_reject, auto_reject_after_hours,
    business_hours_start, business_hours_end,
    status
) VALUES (
    1,
    'Sample Clinic',
    'Dr. Sharma',
    'whatsapp:+919748006945',
    true,
    2,
    true,
    24,
    '09:00 AM',
    '06:00 PM',
    'active'
) ON CONFLICT (id) DO NOTHING;

-- =====================================================
-- VERIFICATION QUERIES
-- =====================================================

-- Check table structure
SELECT 
    table_name,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
FROM information_schema.tables t
WHERE table_schema = 'public' 
AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- Check indexes
SELECT 
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;

-- Success message
DO $$
BEGIN
    RAISE NOTICE '✅ Database schema created successfully!';
    RAISE NOTICE '📊 Tables: clinics, customers, appointments, sessions, customer_interactions, pending_messages';
    RAISE NOTICE '🔍 Views: clinic_performance, pending_appointments_report';
    RAISE NOTICE '⚡ Indexes: Optimized for multi-clinic queries';
END $$;