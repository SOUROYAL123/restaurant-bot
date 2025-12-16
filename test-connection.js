require('dotenv').config();
const pool = require('./db');

async function testConnection() {
  try {
    console.log('🔍 Testing database connection...');
    
    const result = await pool.query('SELECT NOW()');
    console.log('✅ Database connected successfully');
    console.log('⏰ Server time:', result.rows[0].now);
    
    const clinics = await pool.query('SELECT COUNT(*) FROM clinics');
    console.log(`📊 Total clinics: ${clinics.rows[0].count}`);
    
    const appointments = await pool.query('SELECT COUNT(*) FROM appointments');
    console.log(`📅 Total appointments: ${appointments.rows[0].count}`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    process.exit(1);
  }
}

testConnection();
```

---

## **FILE 12: `.gitignore`**
```
# Dependencies
node_modules/

# Environment variables
.env

# Logs
*.log
npm-debug.log*

# OS files
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/

# Testing
coverage/