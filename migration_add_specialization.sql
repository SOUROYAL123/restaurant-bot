-- ═══════════════════════════════════════════════════════════
-- DATABASE MIGRATION: Add specialization to clinics table
-- Version: v8.0.3
-- Purpose: Show doctor specializations in clinic list
-- ═══════════════════════════════════════════════════════════

-- STEP 1: Check if column exists
-- ───────────────────────────────────────────────────────────
-- Run this first to see if you need the migration:

SELECT column_name 
FROM information_schema.columns 
WHERE table_name = 'clinics' 
AND column_name = 'specialization';

-- If returns a row → Column exists, skip to STEP 3
-- If returns empty → Continue with STEP 2

-- STEP 2: Add specialization column
-- ───────────────────────────────────────────────────────────

ALTER TABLE clinics 
ADD COLUMN IF NOT EXISTS specialization VARCHAR(100);

-- STEP 3: Update existing clinics with specializations
-- ───────────────────────────────────────────────────────────
-- Option A: Update each clinic individually

-- Zam Zam Clinic
UPDATE clinics 
SET specialization = 'Cardiology' 
WHERE id = 1;

-- City Health Center
UPDATE clinics 
SET specialization = 'General Medicine' 
WHERE id = 2;

-- Apollo Clinic
UPDATE clinics 
SET specialization = 'Pediatrics' 
WHERE id = 3;

-- Fortis Healthcare
UPDATE clinics 
SET specialization = 'Orthopedics' 
WHERE id = 4;

-- AMRI Hospital
UPDATE clinics 
SET specialization = 'Internal Medicine' 
WHERE id = 5;

-- Belle Vue Clinic
UPDATE clinics 
SET specialization = 'Dermatology' 
WHERE id = 6;

-- Peerless Hospital
UPDATE clinics 
SET specialization = 'Neurology' 
WHERE id = 7;

-- Ruby General Hospital
UPDATE clinics 
SET specialization = 'ENT' 
WHERE id = 8;

-- Medica Superspecialty
UPDATE clinics 
SET specialization = 'Cardiology' 
WHERE id = 9;

-- Woodland Hospital
UPDATE clinics 
SET specialization = 'General Surgery' 
WHERE id = 10;

-- ───────────────────────────────────────────────────────────
-- Option B: Set all to default specialization

UPDATE clinics 
SET specialization = 'General Medicine'
WHERE specialization IS NULL;

-- ───────────────────────────────────────────────────────────
-- Option C: Update by doctor name pattern

-- Update all with specific doctor names
UPDATE clinics 
SET specialization = 'Cardiology'
WHERE doctor_name LIKE '%Cardiologist%' 
   OR doctor_name LIKE '%Heart%';

UPDATE clinics 
SET specialization = 'Pediatrics'
WHERE doctor_name LIKE '%Pediatric%' 
   OR doctor_name LIKE '%Child%';

-- STEP 4: Verify the changes
-- ───────────────────────────────────────────────────────────

SELECT 
    id,
    name,
    doctor_name,
    specialization,
    status
FROM clinics
ORDER BY id;

-- Expected output:
-- id | name              | doctor_name   | specialization     | status
-- ---|-------------------|---------------|--------------------|---------
--  1 | Zam Zam Clinic    | Dr. S. Roy    | Cardiology         | active
--  2 | City Health...    | Dr. Sharma    | General Medicine   | active
--  3 | Apollo Clinic...  | Dr. Sen       | Pediatrics         | active

-- ═══════════════════════════════════════════════════════════
-- COMMON SPECIALIZATIONS (Reference)
-- ═══════════════════════════════════════════════════════════

-- Cardiology (Heart)
-- Dermatology (Skin)
-- ENT (Ear, Nose, Throat)
-- Gastroenterology (Digestive System)
-- General Medicine
-- General Surgery
-- Gynecology (Women's Health)
-- Internal Medicine
-- Nephrology (Kidney)
-- Neurology (Brain/Nervous System)
-- Oncology (Cancer)
-- Ophthalmology (Eyes)
-- Orthopedics (Bones/Joints)
-- Pediatrics (Children)
-- Psychiatry (Mental Health)
-- Pulmonology (Lungs)
-- Radiology (Imaging)
-- Urology (Urinary System)

-- ═══════════════════════════════════════════════════════════
-- ROLLBACK (if needed)
-- ═══════════════════════════════════════════════════════════

-- To remove the specialization column:
-- ALTER TABLE clinics DROP COLUMN IF EXISTS specialization;

-- ═══════════════════════════════════════════════════════════
-- NOTES
-- ═══════════════════════════════════════════════════════════

-- 1. The specialization column is optional
-- 2. If NULL, the bot will show just "Dr. Name" without specialization
-- 3. You can update specializations anytime without redeploying the bot
-- 4. This migration is safe to run multiple times (uses IF NOT EXISTS)

-- ═══════════════════════════════════════════════════════════
