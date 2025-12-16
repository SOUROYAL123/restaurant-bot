# WhatsApp Multi-Clinic Appointment Booking Bot

A production-ready WhatsApp bot for managing appointments across multiple clinics using Twilio, Node.js, and PostgreSQL.

## 🚀 Features

- ✅ Multi-clinic support with data segregation
- ✅ Real-time appointment booking
- ✅ Automatic doctor notifications
- ✅ Slot availability checking
- ✅ Session management
- ✅ Date validation
- ✅ PostgreSQL database with Neon
- ✅ Deployed on Render.com

## 📋 Prerequisites

- Node.js 18+
- Twilio Account (with WhatsApp sandbox)
- Neon PostgreSQL Database
- Render.com Account (for deployment)

## 🛠️ Installation

### 1. Clone Repository
```bash
git clone https://github.com/SOUROYAL123/clinis_database_bot-.git
cd clinis_database_bot-
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables

Create `.env` file:
```env
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
DATABASE_URL=postgresql://user:pass@host/db
PORT=3000
```

### 4. Setup Database

Execute `database/schema.sql` in your Neon PostgreSQL console.

### 5. Run Locally
```bash
npm run dev
```

## 🌐 Deployment (Render.com)

1. Push code to GitHub
2. Create new Web Service on Render
3. Connect GitHub repository
4. Add environment variables
5. Deploy

**Webhook URL:** `https://your-app.onrender.com/webhook`

## 📱 Usage Flow
```
1. Patient sends "hi" to WhatsApp bot
2. Bot shows list of clinics
3. Patient selects clinic by number
4. Patient enters name
5. Patient enters date (DD-MM-YYYY)
6. Bot shows available time slots
7. Patient selects slot
8. Booking confirmed
9. Doctor receives notification
```

## 🗂️ Project Structure
```
├── bot.js                      # Main application
├── db.js                       # Database connection
├── handlers/
│   ├── clinicSelection.js     # Clinic routing
│   ├── appointmentBooking.js  # Booking logic
│   └── notifications.js       # WhatsApp notifications
├── database/
│   ├── schema.sql             # Database schema
│   └── seed-data.sql          # Test data
├── .env.example               # Environment template
├── package.json
└── README.md
```

## 🔒 Data Segregation

Each clinic's data is isolated using `clinic_id`:
```sql
SELECT * FROM appointments WHERE clinic_id = 1; -- Only Clinic 1 data
```

Doctors only receive notifications for their own clinic.

## 🧪 Testing

### Test Database Connection
```bash
npm run test
```

### Test Booking Flow

Send "hi" to your Twilio WhatsApp sandbox number.

## 📊 Database Queries

### View all appointments
```sql
SELECT 
  c.name,
  a.patient_name,
  a.appointment_date,
  a.appointment_slot
FROM appointments a
JOIN clinics c ON a.clinic_id = c.id
WHERE a.status = 'confirmed'
ORDER BY a.appointment_date;
```

### Check today's appointments
```sql
SELECT * FROM appointments 
WHERE appointment_date = CURRENT_DATE 
AND status = 'confirmed';
```

## 🐛 Troubleshooting

**Issue:** Webhook not receiving messages  
**Solution:** Verify Twilio webhook URL is set correctly

**Issue:** Database connection failed  
**Solution:** Check `DATABASE_URL` in environment variables

**Issue:** Doctor not receiving notifications  
**Solution:** Verify `doctor_whatsapp` format includes `whatsapp:` prefix

## 📞 Support

For issues, contact: sourav@legacylens.com

## 📄 License

MIT License - See LICENSE file for details

## 👨‍💻 Author

**Sourav Roy**  
Legacylens Automation  
GitHub: [@SOUROYAL123](https://github.com/SOUROYAL123)