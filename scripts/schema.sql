-- Clinics table
CREATE TABLE IF NOT EXISTS clinics (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    whatsapp_number VARCHAR(20) UNIQUE NOT NULL,
    address TEXT,
    email VARCHAR(100),
    phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Customers table
CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) NOT NULL,
    name VARCHAR(100),
    clinic_id INTEGER NOT NULL,
    language_preference VARCHAR(10) DEFAULT 'en',
    last_interaction TIMESTAMP DEFAULT NOW(),
    total_appointments INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    notes TEXT,
    UNIQUE(phone_number, clinic_id),
    FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE CASCADE
);

-- Appointments table
CREATE TABLE IF NOT EXISTS appointments (
    id SERIAL PRIMARY KEY,
    clinic_id INTEGER NOT NULL,
    customer_phone VARCHAR(20) NOT NULL,
    customer_name VARCHAR(100) NOT NULL,
    appointment_date DATE NOT NULL,
    appointment_time TIME NOT NULL,
    service VARCHAR(100),
    status VARCHAR(20) DEFAULT 'pending',
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE CASCADE
);

-- Customer interactions table
CREATE TABLE IF NOT EXISTS customer_interactions (
    id SERIAL PRIMARY KEY,
    customer_phone VARCHAR(20) NOT NULL,
    clinic_id INTEGER NOT NULL,
    message_type VARCHAR(50),
    message_content TEXT,
    bot_response TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_number);
CREATE INDEX IF NOT EXISTS idx_customers_clinic ON customers(clinic_id);
CREATE INDEX IF NOT EXISTS idx_customers_last_interaction ON customers(last_interaction);

CREATE INDEX IF NOT EXISTS idx_appointments_clinic ON appointments(clinic_id);
CREATE INDEX IF NOT EXISTS idx_appointments_customer ON appointments(customer_phone, clinic_id);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_datetime ON appointments(appointment_date, appointment_time);

CREATE INDEX IF NOT EXISTS idx_interactions_customer ON customer_interactions(customer_phone, clinic_id);
CREATE INDEX IF NOT EXISTS idx_interactions_clinic ON customer_interactions(clinic_id);
CREATE INDEX IF NOT EXISTS idx_interactions_created ON customer_interactions(created_at);