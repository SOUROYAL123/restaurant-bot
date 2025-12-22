// bot.js

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

const { sendMessage } = require('./utils/sendMessage');
const AppointmentBooking = require('./handlers/appointmentBooking');

// --------------------
// BASIC APP SETUP
// --------------------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// --------------------
// IN-MEMORY SESSION STORE
// (replace with Redis later)
// --------------------
const sessions = {};

// --------------------
// MOCK DB FUNCTION
// Replace with your real DB query
// --------------------
async function getClinicByWaba(wabaNumber) {
  // You already have this in DB – mocked here
  return {
    id: 1,
    name: 'Dr Sharma Clinic',
    doctor_name: 'Dr Sourav Roy',
    doctor_whatsapp: 'whatsapp:+919748006945',
    status: 'active',
    auto_approve: false
  };
}

// --------------------
// WEBHOOK
// --------------------
app.post('/webhook', async (req, res) => {
  try {
    const from = req.body.From || req.body.from;
    const to = req.body.To || req.body.to;
    const body = (req.body.Body || req.body.body || '').trim();

    console.log('=== DEBUG INFO ===');
    console.log('From:', from);
    console.log('To:', to);
    console.log('Body:', body);
    console.log('==================');

    if (!from || !to || !body) {
      res.sendStatus(200);
      return;
    }

    // --------------------
    // SESSION INIT
    // --------------------
    if (!sessions[from]) {
      sessions[from] = {
        stage: 'main_menu'
      };
    }

    const session = sessions[from];

    // --------------------
    // CLINIC LOOKUP
    // --------------------
    const clinic = await getClinicByWaba(to);

    if (!clinic) {
      await sendMessage(from, '❌ Clinic not found.');
      res.sendStatus(200);
      return;
    }

    console.log(`✅ Clinic found: ${clinic.name} (ID: ${clinic.id})`);

    // --------------------
    // MAIN MENU
    // --------------------
    if (session.stage === 'main_menu') {
      if (body === '1') {
        session.stage = 'booking_start';

        await AppointmentBooking.handleBooking({
          userPhone: from,
          clinic,
          message: body,
          stage: session.stage,
          sendMessage
        });

        res.sendStatus(200);
        return;
      }

      await sendMessage(
        from,
        '👋 Welcome to ' + clinic.name + '\n\n1️⃣ Book Appointment'
      );
      res.sendStatus(200);
      return;
    }

    // --------------------
    // BOOKING FLOW
    // --------------------
    if (session.stage === 'booking_start') {
      session.stage = 'select_date';

      await AppointmentBooking.handleBooking({
        userPhone: from,
        clinic,
        message: body,
        stage: session.stage,
        sendMessage
      });

      res.sendStatus(200);
      return;
    }

    if (session.stage === 'select_date') {
      session.stage = 'confirmed';

      await AppointmentBooking.handleBooking({
        userPhone: from,
        clinic,
        message: body,
        stage: session.stage,
        sendMessage
      });

      res.sendStatus(200);
      return;
    }

    // --------------------
    // FALLBACK
    // --------------------
    await sendMessage(from, '❌ Invalid input. Please start again.');
    session.stage = 'main_menu';

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.sendStatus(200);
  }
});

// --------------------
// HEALTH CHECK
// --------------------
app.get('/', (req, res) => {
  res.send('✅ WhatsApp Clinic Bot is running');
});

// --------------------
// START SERVER
// --------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Webhook: /webhook`);
});
