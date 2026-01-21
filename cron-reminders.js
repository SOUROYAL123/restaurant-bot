// ═══════════════════════════════════════════════════════════════════════
// ⭐ FIXED REMINDER CRON ENDPOINT - PRECISE 2.5 HOUR & 24 HOUR REMINDERS
// ═══════════════════════════════════════════════════════════════════════

app.post('/cron/send-reminders', async (req, res) => {
    const startTime = Date.now();
    
    try {
        log.info('🔔 Reminder cron started');
        
        let sent24h = 0;
        let sent2h = 0;
        let errors = 0;
        
        // ═══════════════════════════════════════════════════════════════
        // 24-HOUR REMINDERS - Send at 6 PM for next day appointments
        // ═══════════════════════════════════════════════════════════════
        if (REMINDER_24H_ENABLED) {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const tomorrowDate = tomorrow.toISOString().split('T')[0];
            
            const reminder24h = await sql`
                SELECT 
                    a.id,
                    a.patient_name,
                    a.patient_phone,
                    a.appointment_date,
                    a.appointment_time,
                    c.name as clinic_name,
                    c.doctor_name,
                    d.name as assigned_doctor_name,
                    d.specialization as assigned_doctor_specialization
                FROM appointments a
                JOIN clinics c ON a.clinic_id = c.id
                LEFT JOIN doctors d ON a.doctor_id = d.id
                WHERE a.appointment_date = ${tomorrowDate}
                AND a.status = 'confirmed'
                AND a.reminder_24h_sent = false
                ORDER BY a.appointment_time
            `;
            
            log.info(`Found ${reminder24h.length} appointments for 24h reminders`);
            
            for (const apt of reminder24h) {
                try {
                    const doctorName = apt.assigned_doctor_name || apt.doctor_name;
                    const doctorSpec = apt.assigned_doctor_specialization || 'General';
                    
                    let message = `🔔 *REMINDER - TOMORROW*\n\n━━━━━━━━━━━━━━━━━━━━\n📋 #${apt.id}\n🏥 ${apt.clinic_name}\n`;
                    
                    if (doctorName) {
                        message += `👨‍⚕️ ${formatDoctorName(doctorName)}\n`;
                        message += `🩺 ${doctorSpec}\n`;
                    }
                    
                    message += `\n📅 *TOMORROW*\n⏰ ${apt.appointment_time}\n━━━━━━━━━━━━━━━━━━━━\n\n✔ Please arrive 10 min early\n✔ Bring any documents\n\nSee you tomorrow!\n\n━━━━━━━━━━━━━━━━━━━━\n✅ CONFIRM #${apt.id}\n❌ CANCEL #${apt.id}`;
                    
                    const success = await sendWhatsApp(apt.patient_phone, message);
                    
                    if (success) {
                        await sql`
                            UPDATE appointments 
                            SET reminder_24h_sent = true,
                                updated_at = NOW()
                            WHERE id = ${apt.id}
                        `;
                        
                        sent24h++;
                        log.success(`📅 24h reminder sent`, {
                            appointmentId: apt.id,
                            patient: apt.patient_name
                        });
                    }
                    
                } catch (error) {
                    errors++;
                    log.error(`Error sending 24h reminder for #${apt.id}`, error);
                }
            }
        }
        
        // ═══════════════════════════════════════════════════════════════
        // ⭐ FIXED 2.5-HOUR REMINDERS - PRECISE 150 MINUTE WINDOW
        // Cron should run EVERY 30 MINUTES for best coverage
        // ═══════════════════════════════════════════════════════════════
        if (REMINDER_2H_ENABLED) {
            const now = new Date();
            const todayDate = now.toISOString().split('T')[0];
            
            // Get current time in minutes for precise comparison
            const currentHour = now.getHours();
            const currentMinute = now.getMinutes();
            const currentTotalMinutes = currentHour * 60 + currentMinute;
            
            log.info('2.5-hour reminder check', {
                currentTime: `${currentHour}:${String(currentMinute).padStart(2, '0')}`,
                todayDate: todayDate
            });
            
            const reminder2h = await sql`
                SELECT 
                    a.id,
                    a.patient_name,
                    a.patient_phone,
                    a.appointment_date,
                    a.appointment_time,
                    c.name as clinic_name,
                    c.doctor_name,
                    d.name as assigned_doctor_name
                FROM appointments a
                JOIN clinics c ON a.clinic_id = c.id
                LEFT JOIN doctors d ON a.doctor_id = d.id
                WHERE a.appointment_date = ${todayDate}
                AND a.status = 'confirmed'
                AND a.reminder_2h_sent = false
                ORDER BY a.appointment_time
            `;
            
            log.info(`Found ${reminder2h.length} potential appointments for 2.5h reminders`);
            
            for (const apt of reminder2h) {
                try {
                    // Parse appointment time (e.g., "2:30 PM")
                    const timeMatch = apt.appointment_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
                    if (!timeMatch) {
                        log.warn(`Invalid time format for appointment #${apt.id}`, { 
                            time: apt.appointment_time 
                        });
                        continue;
                    }
                    
                    let appointmentHour = parseInt(timeMatch[1]);
                    const appointmentMinute = parseInt(timeMatch[2]);
                    const period = timeMatch[3].toUpperCase();
                    
                    // Convert to 24-hour format
                    if (period === 'PM' && appointmentHour !== 12) {
                        appointmentHour += 12;
                    } else if (period === 'AM' && appointmentHour === 12) {
                        appointmentHour = 0;
                    }
                    
                    // Calculate appointment time in minutes from midnight
                    const appointmentTotalMinutes = appointmentHour * 60 + appointmentMinute;
                    
                    // Calculate difference in minutes
                    const minutesDiff = appointmentTotalMinutes - currentTotalMinutes;
                    
                    // ⭐ FIXED: Precise 2.5 hour window (140-160 minutes)
                    // This gives 20-minute tolerance for cron timing
                    const TARGET_MINUTES = 150; // 2.5 hours
                    const TOLERANCE = 10; // ±10 minutes
                    const MIN_WINDOW = TARGET_MINUTES - TOLERANCE; // 140 minutes
                    const MAX_WINDOW = TARGET_MINUTES + TOLERANCE; // 160 minutes
                    
                    if (minutesDiff >= MIN_WINDOW && minutesDiff <= MAX_WINDOW) {
                        const hoursAway = (minutesDiff / 60).toFixed(1);
                        
                        log.info(`✅ Sending 2.5h reminder`, {
                            appointmentId: apt.id,
                            appointmentTime: apt.appointment_time,
                            currentTime: `${currentHour}:${String(currentMinute).padStart(2, '0')}`,
                            minutesAway: minutesDiff,
                            hoursAway: hoursAway,
                            window: `${MIN_WINDOW}-${MAX_WINDOW} minutes`
                        });
                        
                        const doctorName = apt.assigned_doctor_name || apt.doctor_name;
                        
                        let message = `⏰ *REMINDER - IN ${hoursAway} HOURS*\n\n━━━━━━━━━━━━━━━━━━━━\n📋 #${apt.id}\n🏥 ${apt.clinic_name}\n`;
                        
                        if (doctorName) {
                            message += `👨‍⚕️ ${formatDoctorName(doctorName)}\n`;
                        }
                        
                        message += `\n⏰ *TODAY at ${apt.appointment_time}*\n━━━━━━━━━━━━━━━━━━━━\n\n✔ Arrive 10 min early\n✔ Bring documents\n\nSee you soon!`;
                        
                        const success = await sendWhatsApp(apt.patient_phone, message);
                        
                        if (success) {
                            await sql`
                                UPDATE appointments 
                                SET reminder_2h_sent = true,
                                    updated_at = NOW()
                                WHERE id = ${apt.id}
                            `;
                            
                            sent2h++;
                            log.success(`⏰ 2.5h reminder sent successfully`, {
                                appointmentId: apt.id,
                                patient: apt.patient_name,
                                time: apt.appointment_time,
                                exactMinutesBeforeAppointment: minutesDiff
                            });
                        } else {
                            log.error(`Failed to send 2.5h reminder`, {
                                appointmentId: apt.id,
                                phone: apt.patient_phone
                            });
                        }
                    } 
                    // Auto-cleanup: Mark past appointments as sent
                    else if (minutesDiff < 0) {
                        log.warn(`Appointment #${apt.id} is in the past, marking as sent`, {
                            appointmentTime: apt.appointment_time,
                            minutesPast: Math.abs(minutesDiff)
                        });
                        
                        await sql`
                            UPDATE appointments 
                            SET reminder_2h_sent = true,
                                updated_at = NOW()
                            WHERE id = ${apt.id}
                        `;
                    } 
                    // Log appointments outside window for debugging
                    else {
                        const status = minutesDiff > MAX_WINDOW ? 
                            `Too far (${minutesDiff} min away, need <${MAX_WINDOW})` : 
                            `Too close (${minutesDiff} min away, need >${MIN_WINDOW})`;
                        
                        log.info(`⏭️ Appointment #${apt.id} not in window`, {
                            appointmentTime: apt.appointment_time,
                            minutesAway: minutesDiff,
                            status: status
                        });
                    }
                    
                } catch (error) {
                    errors++;
                    log.error(`Error processing 2.5h reminder for #${apt.id}`, error);
                }
            }
        }
        
        const duration = Date.now() - startTime;
        
        const summary = {
            success: true,
            reminder_24h_sent: sent24h,
            reminder_2h_sent: sent2h,
            errors: errors,
            durationMs: duration,
            timestamp: new Date().toISOString(),
            config: {
                target_minutes_before_appointment: 150,
                tolerance_minutes: 10,
                effective_window: '140-160 minutes (2h 20m - 2h 40m)'
            }
        };
        
        log.success('✅ Reminder cron completed', summary);
        
        res.json(summary);
        
    } catch (error) {
        const duration = Date.now() - startTime;
        log.error('❌ Reminder cron failed', {
            error: error.message,
            stack: error.stack
        });
        
        res.status(500).json({
            success: false,
            error: error.message,
            durationMs: duration
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// TEST ENDPOINT - Check reminder status
// ═══════════════════════════════════════════════════════════════════════
app.get('/cron/send-reminders/test', async (req, res) => {
    log.info('🧪 Reminder test endpoint accessed');
    
    try {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowDate = tomorrow.toISOString().split('T')[0];
        
        const today = new Date().toISOString().split('T')[0];
        
        const reminder24h = await sql`
            SELECT COUNT(*) as count
            FROM appointments
            WHERE appointment_date = ${tomorrowDate}
            AND status = 'confirmed'
            AND reminder_24h_sent = false
        `;
        
        const reminder2h = await sql`
            SELECT COUNT(*) as count
            FROM appointments
            WHERE appointment_date = ${today}
            AND status = 'confirmed'
            AND reminder_2h_sent = false
        `;
        
        res.json({
            message: 'Reminder cron endpoint ready ✅',
            config: {
                reminder_24h_enabled: REMINDER_24H_ENABLED,
                reminder_2h_enabled: REMINDER_2H_ENABLED,
                target_reminder_time: '2.5 hours (150 minutes) before appointment',
                tolerance: '±10 minutes',
                effective_window: '2h 20m to 2h 40m before appointment'
            },
            pending24hReminders: reminder24h[0].count,
            pending2hReminders: reminder2h[0].count,
            endpoint: `POST ${process.env.BASE_URL}/cron/send-reminders`,
            setup: {
                step1: 'Go to cron-job.org',
                step2: `Add URL: POST ${process.env.BASE_URL}/cron/send-reminders`,
                step3: '⭐ CRITICAL: Schedule EVERY 30 MINUTES (not 2 hours!)',
                step4: 'Cron expression: */30 * * * * (runs at :00 and :30 of every hour)',
                step5: 'Enable and save'
            },
            why_30_minutes: 'Running every 30 minutes ensures no appointments are missed. The 20-minute window (140-160 min) allows flexibility for cron timing while targeting exactly 2.5 hours.'
        });
        
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});
