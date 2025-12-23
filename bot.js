// bot.js

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const SessionManager = require('./utils/sessionManager');

// existing handlers (AS-IS)
const { handleClinicSelection } = require('./handlers/clinicSelection');
const { handleBooking } = require('./handlers/appointmentBooking');
const { handleDoctorCommands } = require('./handlers/doctorCommands');
const { handlePatientCancellation } = require('./handlers/patientCancellation');
const PatientCommandsHandler = require('./handlers/patientCommands');
const LanguageHandler = require('./handlers/languageHandler');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// =====================================================
// WEBHOOK
// =====================================================
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

    // -------------------------------------------------
    // 1️⃣ Load or create session (UNCHANGED LOGIC)
    // -------------------------------------------------
    let session = await SessionManager.getSession(from);
    if (!session) {
      session = await SessionManager.createSession(from);
    }

    console.log('📍 Session:', {
      clinic_id: session.clinic_id,
      step: session.current_step
    });

    // -------------------------------------------------
    // 2️⃣ CLINIC SELECTION (only if clinic_id missing)
    // -------------------------------------------------
    const clinicHandled = await handleClinicSelection(
      from,
      message,
      session,
      twiml
    );

    if (clinicHandled) {
      return res.type('text/xml').send(twiml.toString());
    }

    // from here onward clinic_id MUST exist
    const clinicId = session.clinic_id;
    if (!clinicId) {
      twiml.message('❌ Clinic not selected. Type *hi* to restart.');
      return res.type('text/xml').send(twiml.toString());
    }

    // -------------------------------------------------
    // 3️⃣ DOCTOR COMMANDS (APPROVE / REJECT)
    // -------------------------------------------------
    const doctorHandled = await handleDoctorCommands(
      from,
      clinicId,
      message,
      twiml
    );
    if (doctorHandled) {
      return res.type('text/xml').send(twiml.toString());
    }

    // -------------------------------------------------
    // 4️⃣ PATIENT CANCELLATION
    // -------------------------------------------------
    const cancelled = await handlePatientCancellation(
      from,
      clinicId,
      message,
      twiml
    );
    if (cancelled) {
      return res.type('text/xml').send(twiml.toString());
    }

    // -------------------------------------------------
    // 5️⃣ PATIENT COMMANDS
    // -------------------------------------------------
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

    // -------------------------------------------------
    // 6️⃣ LANGUAGE HANDLER
    // -------------------------------------------------
    const languageHandled = await LanguageHandler.handle(
      from,
      message,
      twiml,
      clinicId
    );
    if (languageHandled) {
      return res.type('text/xml').send(twiml.toString());
    }

    // -------------------------------------------------
    // 7️⃣ BOOKING FLOW (UNCHANGED)
    // -------------------------------------------------
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
    twiml.message('❌ Something went wrong. Type *hi* to restart.');
    return res.type('text/xml').send(twiml.toString());
  }
});

// =====================================================
// HEALTH CHECK (RENDER)
// =====================================================
app.get('/', (req, res) => {
  res.send('✅ WhatsApp multi-clinic bot is running');
});

// =====================================================
// START SERVER (RENDER-SAFE)
// =====================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
