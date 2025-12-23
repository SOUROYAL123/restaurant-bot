require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

const {
  ensureSession,
  getSession,
  updateSession
} = require('./utils/sessionManager');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ===============================
// WhatsApp Webhook
// ===============================
app.post('/webhook', async (req, res) => {
  try {
    const from = req.body.From;          // whatsapp:+9180xxxxxxx
    const body = req.body.Body || '';

    if (!from) {
      return res.sendStatus(200);
    }

    const message = body.trim().toLowerCase();
    const userPhone = from.replace('whatsapp:', '');

    // 1️⃣ Ensure session exists (uses user_phone column)
    await ensureSession(userPhone);

    // 2️⃣ Get session
    const session = await getSession(userPhone);
    console.log('SESSION:', session);

    let reply = '';

    // 3️⃣ Flow control
    switch (session.step) {

      case 'booking_start':
        reply =
          `👋 Welcome to the Clinic Bot\n\n` +
          `Reply with:\n` +
          `1️⃣ Book Appointment\n` +
          `2️⃣ Contact Clinic`;

        await updateSession(userPhone, { step: 'awaiting_action' });
        break;

      case 'awaiting_action':
        if (message === '1') {
          reply =
            `🏥 Please choose a clinic:\n` +
            `1️⃣ Clinic A\n` +
            `2️⃣ Clinic B`;

          await updateSession(userPhone, { step: 'awaiting_clinic' });
        } else if (message === '2') {
          reply = `📞 Please call us at +91-XXXXXXXXXX`;
          await updateSession(userPhone, { step: 'booking_start' });
        } else {
          reply = `❌ Invalid option. Reply 1 or 2.`;
        }
        break;

      case 'awaiting_clinic':
        if (message === '1' || message === '2') {
          reply = `✅ Clinic ${message} selected.\n\nBooking completed (demo).`;

          await updateSession(userPhone, {
            clinic_id: message,
            step: 'booking_start'
          });
        } else {
          reply = `❌ Invalid clinic. Reply 1 or 2.`;
        }
        break;

      default:
        reply = `❌ Something went wrong. Type hi to restart.`;
        await updateSession(userPhone, { step: 'booking_start' });
        break;
    }

    // 4️⃣ Respond to WhatsApp (Twilio XML)
    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);

  } catch (err) {
    console.error('WEBHOOK ERROR:', err);

    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Message>❌ Something went wrong. Type hi to restart.</Message>
      </Response>
    `);
  }
});

// ===============================
// Health Check
// ===============================
app.get('/', (req, res) => {
  res.send('WhatsApp Clinic Bot is running');
});

// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
