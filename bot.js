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

// ------------------
// WhatsApp Webhook
// ------------------
app.post('/webhook', async (req, res) => {
  try {
    const from = req.body.From;        // whatsapp:+9180xxxxxxx
    const message = req.body.Body?.trim().toLowerCase();

    if (!from || !message) {
      return res.sendStatus(200);
    }

    // Normalize phone number
    const phone = from.replace('whatsapp:', '');

    // 1️⃣ Ensure session exists
    await ensureSession(phone);

    // 2️⃣ Fetch session
    const session = await getSession(phone);
    console.log('SESSION:', session);

    let reply = '';

    // 3️⃣ Handle flow by step
    switch (session.step) {

      case 'booking_start':
        reply =
          `👋 Welcome to the Clinic Bot\n\n` +
          `Reply with:\n` +
          `1️⃣ Book Appointment\n` +
          `2️⃣ Contact Clinic`;

        await updateSession(phone, { step: 'awaiting_action' });
        break;

      case 'awaiting_action':
        if (message === '1') {
          reply = '🏥 Please reply with clinic number:\n1️⃣ Clinic A\n2️⃣ Clinic B';
          await updateSession(phone, { step: 'awaiting_clinic' });
        } else if (message === '2') {
          reply = '📞 You can contact us at +91-XXXXXXXXXX';
          await updateSession(phone, { step: 'booking_start' });
        } else {
          reply = '❌ Invalid choice. Reply 1 or 2.';
        }
        break;

      case 'awaiting_clinic':
        if (message === '1' || message === '2') {
          reply = `✅ Clinic ${message} selected.\nBooking flow complete (demo).`;
          await updateSession(phone, {
            clinic_id: message,
            step: 'booking_start'
          });
        } else {
          reply = '❌ Invalid clinic. Reply 1 or 2.';
        }
        break;

      default:
        reply = '❌ Something went wrong. Type hi to restart.';
        await updateSession(phone, { step: 'booking_start' });
        break;
    }

    // 4️⃣ Send response back to WhatsApp (Twilio compatible XML)
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

// ------------------
// Health Check
// ------------------
app.get('/', (req, res) => {
  res.send('WhatsApp Clinic Bot Running');
});

// ------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
