// bot.js

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const SessionManager = require('./utils/sessionManager');
const ClinicSelection = require('./handlers/clinicSelection');
const { handleBooking } = require('./handlers/appointmentBooking');
const { handleDoctorCommands } = require('./handlers/doctorCommands');
const { handlePatientCancellation } = require('./handlers/patientCancellation');
const PatientCommandsHandler = require('./handlers/patientCommands');
const LanguageHandler = require('./handlers/languageHandler');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// WEBHOOK
// --------------------------------------------------
app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const from = req.body.From;
    const to = req.body.To;
    const message = (req.body.Body || '').trim();

    console.log('📨 Incoming:', { from, to, message });

    if (!from || !message) {
      return res.type('text/xml').send(twiml.toString());
    }

    // 1️⃣ Find clinic by WABA number
    const clinic = await ClinicSelection.getClinicByWaba(to);
    if (!clinic) {
      twiml.message('❌ Clinic not found.');
      return res.type('text/xml').send(twiml.toString());
    }

    const clinicId = clinic.id;

    // 2️⃣ Load or create session
    let session = await SessionManager.getSession(from, clinicId);
    if (!session) {
      session = await SessionManager.createSession(from, clinicId);
    }

    console.log('📍 Current step:', session.current_step);

    // 3️⃣ Doctor commands (APPROVE / REJECT / AUTO ON/OFF)
    const doctorHandled = await handleDoctorCommands(
      from,
      clinicId,
      message,
      twiml
    );
    if (doctorHandled) {
      return res.type('text/xml').send(twiml.toString());
    }

    // 4️⃣ Patient cancellation (CANCEL 12)
    const cancelled = await handlePatientCancellation(
      from,
      clinicId,
      message,
      twiml
    );
    if (cancelled) {
      return res.type('text/xml').send(twiml.toString());
    }

    // 5️⃣ Patient commands (MY APPOINTMENTS / RESCHEDULE)
    if (PatientCommandsHandler.isPatientCommand(message)) {
      const result = await PatientCommandsHandler.handleCommand(
        from,
        clinicId,
        message
      );

      if (result?.message) {
        twiml.message(result.message);
      }

      return res.type('text/xml').send(twiml.toString());
    }

    // 6️⃣ Language selection & greeting (FIXED CALL)
    const languageHandled = await LanguageHandler.handle(
      from,
      message,
      twiml,
      clinicId
    );
    if (languageHandled) {
      return res.type('text/xml').send(twiml.toString());
    }

    // 7️⃣ Appointment booking flow
    await handleBooking(
      from,
      clinicId,
      session,
      message,
      twiml
    );

    return res.type('text/xml').send(twiml.toString());

  } catch (error) {
    console.error('❌ Webhook error:', error);
    twiml.message('❌ Something went wrong. Please type *hi* to restart.');
    return res.type('text/xml').send(twiml.toString());
  }
});

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------
app.get('/', (req, res) => {
  res.send('✅ WhatsApp Clinic Bot is running');
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
