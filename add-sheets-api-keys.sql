-- ═══════════════════════════════════════════════════════════
-- GOOGLE SHEETS INTEGRATION - DATABASE MIGRATION
-- Add sheets_api_key column to clinics table
-- ═══════════════════════════════════════════════════════════

-- Step 1: Add column for Google Sheets API key
ALTER TABLE clinics 
ADD COLUMN IF NOT EXISTS sheets_api_key VARCHAR(100);

-- Step 2: Generate unique API keys for each clinic
-- Run this to generate keys (you'll need to do this manually or via script)

-- Example: Generate keys for all clinics
-- UPDATE clinics SET sheets_api_key = md5(random()::text || clock_timestamp()::text) WHERE id = 1;
-- UPDATE clinics SET sheets_api_key = md5(random()::text || clock_timestamp()::text) WHERE id = 2;
-- etc...

-- Step 3: View all clinic API keys
SELECT 
    id,
    name,
    sheets_api_key,
    CASE 
        WHEN sheets_api_key IS NULL THEN '❌ Not Generated'
        ELSE '✅ Generated'
    END as status
FROM clinics
ORDER BY id;

-- ═══════════════════════════════════════════════════════════
-- GENERATE API KEYS FOR ALL CLINICS
-- ═══════════════════════════════════════════════════════════

-- Generate unique API key for each clinic
UPDATE clinics 
SET sheets_api_key = md5(random()::text || clock_timestamp()::text || id::text)
WHERE sheets_api_key IS NULL;

-- Verify all clinics have API keys
SELECT 
    id,
    name,
    doctor_name,
    sheets_api_key
FROM clinics
ORDER BY id;

-- ═══════════════════════════════════════════════════════════
-- INDIVIDUAL CLINIC API KEY GENERATION (if needed)
-- ═══════════════════════════════════════════════════════════

-- Generate for specific clinic:
-- UPDATE clinics 
-- SET sheets_api_key = md5(random()::text || clock_timestamp()::text || id::text)
-- WHERE id = 1;

-- ═══════════════════════════════════════════════════════════
-- GET API KEY FOR SPECIFIC CLINIC
-- ═══════════════════════════════════════════════════════════

-- Get API key for Zam Zam Clinic (ID 1):
SELECT 
    id,
    name,
    'Clinic ID: ' || id as clinic_identifier,
    'API Key: ' || sheets_api_key as api_key_info,
    'URL: https://clinis-database-bot.onrender.com/api/sheets/' || id || '/appointments' as endpoint_url
FROM clinics
WHERE id = 1;

-- Get all clinic API keys with URLs:
SELECT 
    id,
    name,
    sheets_api_key,
    'https://clinis-database-bot.onrender.com/api/sheets/' || id || '/appointments' as appointments_url,
    'https://clinis-database-bot.onrender.com/api/sheets/' || id || '/stats' as stats_url,
    'https://clinis-database-bot.onrender.com/api/sheets/' || id || '/today' as today_url
FROM clinics
ORDER BY id;
