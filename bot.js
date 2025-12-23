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
    const from = req.body.From;
    const body = req.body.Body || '';

    if (!from) {
      return res.sendStatus(200);
    }

    const message = body.trim().toLowerCase();
    const userPhone = from.replace('whatsapp:', '');

    // 🔐 Always ensure session row exists
    await ensureSession(userPhone);

    // 🔍 Fetch session
    let session = await getSession(userPhone);
    console.log('SESSION:', session);

    // 🛑 HARD SAFETY GUARD (prevents all crashes)
    if (!session || !session.step) {
      console.log('⚠️ Resetting invalid session');

      await updateSession(userPhone, { step: 'booking_start' });

      res.set('Content-Type', 'text/xml');
      return res.send(`
        <Response>
          <Message>👋 Welcome! Please type hi.</Message>
        </Response>
      `);
    }

    let reply = '';

    // ===============================
    // FLOW CONTROL
    // ===============================
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
        console.log('⚠️ Unknown step, resetting:', session.step);
        await updateSession(userPhone, { step: 'booking_start' });
        reply = `👋 Session reset. Please type hi.`;
        break;
    }

    // ===============================
    // SEND RESPONSE
    // ===============================
    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);

  } catch (err) {
    // 🔥 LAST LINE OF DEFENSE
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
