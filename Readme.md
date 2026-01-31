# 🍽️ Multi-Restaurant WhatsApp Ordering Bot

[![Node.js](https://img.shields.io/badge/Node.js-18.x-green.svg)](https://nodejs.org/)
[![Twilio](https://img.shields.io/badge/Twilio-WhatsApp%20API-blue.svg)](https://www.twilio.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon-orange.svg)](https://neon.tech/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Complete WhatsApp-based ordering and table booking system for multiple restaurants using Twilio Business API, Razorpay payments, and Google Sheets integration.

## 📸 Screenshots

```
Customer: ZAMZAM

Bot: 🍽️ Welcome to *Zam Zam Restaurant*!

     Please select a service:
     
     1️⃣ Order Delivery
     2️⃣ Book a Table
     
     Reply with *1* or *2*
```

## 🌟 Features

### Core Features
- 📱 **WhatsApp Business API** - Twilio integration for reliable messaging
- 🏪 **Multi-Restaurant Support** - Manage multiple restaurants from one system
- 🍕 **Food Ordering** - Complete ordering system with cart management
- 🪑 **Table Booking** - Interactive booking system with date/time selection
- 💳 **Payment Integration** - Razorpay for online payments + COD support
- 🔐 **OTP Verification** - Secure customer authentication
- 📊 **Google Sheets Logging** - Automatic order logging to Google Sheets

### Advanced Features
- 👥 **Customer Reliability Tracking** - Fraud prevention system
- 🔔 **Owner Notifications** - Instant SMS notifications to restaurant owners
- 📈 **Session Management** - Intelligent session handling with timeouts
- 💾 **Database Caching** - Optimized performance with smart caching
- 🛡️ **Security** - Rate limiting, input validation, webhook verification

## 🏗️ Tech Stack

**Backend:**
- Node.js (v18+)
- Express.js
- PostgreSQL (Neon)

**APIs & Services:**
- Twilio WhatsApp Business API
- Razorpay Payment Gateway
- Google Sheets API
- Google Apps Script

**Deployment:**
- Railway / Render compatible
- Docker support (optional)

## 📦 Installation

### Prerequisites
- Node.js 18 or higher
- PostgreSQL database (Neon recommended)
- Twilio account with WhatsApp Business API
- Razorpay account (optional, for payments)
- Google Service Account (optional, for Sheets)

### 1. Clone Repository

```bash
git clone https://github.com/SOUROYAL123/restaurant-whatsapp-bot.git
cd restaurant-whatsapp-bot
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Database
DATABASE_URL="postgresql://user:pass@host.neon.tech/db?sslmode=require"

# Twilio
TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
TWILIO_AUTH_TOKEN="your_auth_token"
WABA_NUMBER="whatsapp:+1234567890"

# Razorpay (Optional)
RAZORPAY_KEY_ID="rzp_test_xxxxx"
RAZORPAY_KEY_SECRET="your_secret"

# Google Sheets (Optional)
GOOGLE_APPS_SCRIPT_URL="https://script.google.com/..."
```

### 4. Database Setup

Run the schema:

```bash
psql $DATABASE_URL -f database/schema-complete.sql
```

Verify setup:

```bash
node test-db.js
```

Fix schema if needed:

```bash
node fix-schema.js
```

### 5. Run Diagnostics

```bash
node diagnose.js
```

Should show all checks passing ✅

### 6. Start Server

```bash
node server.js
```

## 🚀 Deployment

### Local Development (ngrok)

**Terminal 1:**
```bash
node server.js
```

**Terminal 2:**
```bash
ngrok http 3000
```

Copy the ngrok HTTPS URL and configure Twilio webhook.

### Production (Railway)

1. Push code to GitHub
2. Create new project on Railway
3. Connect GitHub repository
4. Add environment variables from `.env`
5. Deploy automatically
6. Update Twilio webhook with Railway URL

### Production (Render)

1. Connect GitHub repository
2. Select "Web Service"
3. Add environment variables
4. Deploy
5. Update Twilio webhook with Render URL

## ⚙️ Configuration

### Twilio Webhook Setup

1. Go to [Twilio Console](https://console.twilio.com/us1/develop/sms/settings/whatsapp-sandbox)
2. Find "WHEN A MESSAGE COMES IN"
3. Enter: `https://your-domain.com/webhook` (POST)
4. Save configuration

### Restaurant Triggers

Configure restaurant keywords in the database or use defaults:

- `ZAMZAM` → Zam Zam Restaurant
- `SPICEGARDEN` → Spice Garden  
- `CURRYHOUSE` → Curry House
- `BIRYANIEXPRESS` → Biryani Express

## 📱 Usage

### For Customers

**Start Ordering:**
```
Send: ZAMZAM
```

**Bot Response:**
```
🍽️ Welcome to *Zam Zam Restaurant*!

Please select a service:
1️⃣ Order Delivery
2️⃣ Book a Table

Reply with *1* or *2*
```

**Order Flow:**
1. Select service (1 or 2)
2. Enter phone number
3. Verify OTP
4. Browse menu and add items
5. Confirm order details
6. Choose payment method
7. Complete payment or await delivery

**Booking Flow:**
1. Select booking service (2)
2. Enter phone number
3. Verify OTP
4. Select date
5. Select time
6. Enter number of guests
7. Confirm booking

### For Restaurant Owners

Owners receive instant notifications:
- New orders
- Table bookings
- Customer details
- Order items
- Payment status

## 🛠️ Troubleshooting

### Run Diagnostics
```bash
node diagnose.js
```

### Check Database
```bash
node test-db.js
```

### Test Server Health
```bash
curl http://localhost:3000/health
```

### View Active Sessions
```bash
curl http://localhost:3000/test-session/919876543210
```

### Clear All Sessions
```bash
curl -X POST http://localhost:3000/admin/clear-sessions \
  -H "x-api-key: YOUR_ADMIN_API_KEY"
```

## 📊 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/webhook` | POST | Twilio webhook |
| `/payment/webhook` | POST | Razorpay webhook |
| `/payment/callback` | GET | Payment success page |
| `/restaurants` | GET | List all restaurants |
| `/test-session/:phone` | GET | Check session |
| `/admin/clear-sessions` | POST | Clear all sessions |
| `/reload-cache` | POST | Reload restaurant cache |

## 🗂️ Project Structure

```
restaurant-whatsapp-bot/
├── server.js                 # Main server file
├── diagnose.js              # Diagnostic tool
├── test-db.js               # Database test
├── fix-schema.js            # Schema fix utility
├── .env                     # Environment variables (not in git)
├── .env.example             # Environment template
├── .gitignore               # Git ignore file
├── package.json             # Dependencies
├── features/
│   ├── config.js           # Feature flags
│   ├── payment.js          # Payment integration
│   └── loyalty.js          # Loyalty points
├── apps-script-logger.js    # Google Sheets logger
└── database/
    └── schema-complete.sql  # Database schema
```

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 👤 Author

**Sourav Roy**
- Business: Legacylens Automation
- Location: Kolkata, West Bengal, India
- GitHub: [@SOUROYAL123](https://github.com/SOUROYAL123)

## 🙏 Acknowledgments

- [Twilio](https://www.twilio.com/) for WhatsApp Business API
- [Razorpay](https://razorpay.com/) for payment gateway
- [Neon](https://neon.tech/) for PostgreSQL hosting
- [Railway](https://railway.app/) / [Render](https://render.com/) for deployment

## 📞 Support

For issues and questions:
- Check [TROUBLESHOOTING_GUIDE.md](TROUBLESHOOTING_GUIDE.md)
- Run `node diagnose.js`
- Open an issue on GitHub

## 🔐 Security

Please report security vulnerabilities to the repository owner privately.

**Never commit:**
- `.env` file
- API keys or secrets
- Database passwords
- Service account credentials

## 📈 Roadmap

- [ ] Admin dashboard
- [ ] Multi-language support
- [ ] Customer loyalty program
- [ ] Analytics dashboard
- [ ] Mobile app integration
- [ ] AI-powered recommendations

## ⭐ Star This Repository

If you find this project useful, please consider giving it a star!

---

Made with ❤️ by [Legacylens Automation](https://github.com/SOUROYAL123)