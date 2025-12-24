-- Migration: Add last_activity column to sessions table
-- Date: 2025-12-24

BEGIN;

-- Add last_activity column if it doesn't exist
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS last_activity TIMESTAMP DEFAULT NOW();

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity 
ON sessions(last_activity);

-- Update existing rows to have last_activity value
UPDATE sessions 
SET last_activity = COALESCE(updated_at, created_at, NOW())
WHERE last_activity IS NULL;

COMMIT;
