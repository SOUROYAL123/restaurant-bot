-- CREATE THIS FILE: scripts/add-sessions-table.sql
CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    user_phone VARCHAR(20) NOT NULL UNIQUE,
    clinic_id INTEGER REFERENCES clinics(id),
    stage VARCHAR(50) DEFAULT 'initial',
    language VARCHAR(5) DEFAULT 'en',
    session_data JSONB DEFAULT '{}',
    last_activity TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(user_phone);
CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity);
