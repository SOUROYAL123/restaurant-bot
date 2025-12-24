-- =====================================================
-- PRODUCTION UPGRADE MIGRATION
-- Features: Multi-clinic, Auto-approval, Google Sheets
-- =====================================================

-- 1. Add auto-approval/rejection settings to clinics
ALTER TABLE clinics 
ADD COLUMN IF NOT EXISTS auto_approve BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS auto_approve_after_hours INTEGER DEFAULT 24,
ADD COLUMN IF NOT EXISTS auto_reject BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS auto_reject_after_hours INTEGER DEFAULT 48,
ADD COLUMN IF NOT EXISTS google_sheet_id VARCHAR(100),
ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'Asia/Kolkata';

-- 2. Add timestamps to appointments for approval tracking
ALTER TABLE appointments
ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS auto_approved BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS auto_rejected BOOLEAN DEFAULT false;

-- 3. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_appointments_pending 
ON appointments(clinic_id, status) 
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_appointments_created 
ON appointments(created_at) 
WHERE status = 'pending';

-- 4. Update existing clinics with default settings
UPDATE clinics 
SET 
    auto_approve = true,
    auto_approve_after_hours = 2,
    auto_reject = true,
    auto_reject_after_hours = 24
WHERE auto_approve IS NULL;

-- 5. Sample clinic setup (customize for your clinics)
INSERT INTO clinics (
    name, 
    doctor_name, 
    doctor_whatsapp, 
    google_sheet_id,
    auto_approve,
    auto_approve_after_hours,
    auto_reject,
    auto_reject_after_hours,
    business_hours_start,
    business_hours_end,
    status
) VALUES 
(
    'RB Diagnostics Kolkata',
    'Dr. Sharma',
    'whatsapp:+919748006945',
    NULL, -- Add your Google Sheet ID here
    true,
    2, -- Auto-approve after 2 hours
    true,
    24, -- Auto-reject after 24 hours
    '09:00 AM',
    '06:00 PM',
    'active'
),
(
    'City Hospital Airoli',
    'Dr. Kumar',
    'whatsapp:+919876543210', -- Different doctor number
    NULL, -- Add your Google Sheet ID here
    true,
    1, -- Auto-approve after 1 hour
    true,
    12, -- Auto-reject after 12 hours
    '08:00 AM',
    '08:00 PM',
    'active'
)
ON CONFLICT (id) DO UPDATE SET
    auto_approve = EXCLUDED.auto_approve,
    auto_approve_after_hours = EXCLUDED.auto_approve_after_hours,
    auto_reject = EXCLUDED.auto_reject,
    auto_reject_after_hours = EXCLUDED.auto_reject_after_hours,
    updated_at = NOW();

-- 6. Verify setup
SELECT 
    id,
    name,
    doctor_whatsapp,
    auto_approve,
    auto_approve_after_hours,
    auto_reject,
    auto_reject_after_hours,
    google_sheet_id
FROM clinics;