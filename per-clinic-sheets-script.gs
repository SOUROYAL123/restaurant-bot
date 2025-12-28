/**
 * ═══════════════════════════════════════════════════════════
 * GOOGLE SHEETS INTEGRATION - PER CLINIC VERSION
 * 
 * Each clinic gets their own Google Sheet with their own API key
 * 
 * Setup Instructions:
 * 1. Create new Google Sheet for each clinic
 * 2. Extensions → Apps Script
 * 3. Copy this code
 * 4. Update CLINIC_ID and API_KEY (get from database)
 * 5. Save and run onOpen
 * 6. Refresh sheet and use menu
 * ═══════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════
// CONFIGURATION - UPDATE THESE FOR EACH CLINIC!
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  CLINIC_ID: 1, // CHANGE THIS: Get from database
  API_KEY: 'YOUR_CLINIC_API_KEY_HERE', // CHANGE THIS: Get from database
  API_URL: 'https://clinis-database-bot.onrender.com/api/sheets'
};

// ═══════════════════════════════════════════════════════════
// MENU SETUP
// ═══════════════════════════════════════════════════════════
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🏥 Clinic Dashboard')
    .addItem('🔄 Refresh All', 'refreshAll')
    .addSeparator()
    .addItem('📅 Today\'s Appointments', 'getTodayAppointments')
    .addItem('📋 All Appointments', 'getAllAppointments')
    .addItem('📈 Statistics', 'getStatistics')
    .addItem('ℹ️ Clinic Info', 'getClinicInfo')
    .addSeparator()
    .addItem('📆 Get Date Range...', 'getDateRange')
    .addSeparator()
    .addItem('⏰ Auto-Refresh (Every Hour)', 'setupAutoRefresh')
    .addItem('⏸️ Stop Auto-Refresh', 'stopAutoRefresh')
    .addToUi();
}

// ═══════════════════════════════════════════════════════════
// API HELPER
// ═══════════════════════════════════════════════════════════
function callAPI(endpoint, params = {}) {
  try {
    let url = `${CONFIG.API_URL}/${CONFIG.CLINIC_ID}/${endpoint}`;
    
    if (Object.keys(params).length > 0) {
      const queryString = Object.keys(params)
        .map(key => `${key}=${encodeURIComponent(params[key])}`)
        .join('&');
      url += `?${queryString}`;
    }
    
    const options = {
      method: 'GET',
      headers: {
        'X-API-Key': CONFIG.API_KEY
      },
      muteHttpExceptions: true
    };
    
    const response = UrlFetchApp.fetch(url, options);
    const data = JSON.parse(response.getContentText());
    
    if (!data.success) {
      throw new Error(data.error || 'API request failed');
    }
    
    return data;
    
  } catch (error) {
    SpreadsheetApp.getUi().alert('❌ Error: ' + error.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// WRITE DATA TO SHEET
// ═══════════════════════════════════════════════════════════
function writeToSheet(sheetName, data, headerColor = '#4285F4') {
  if (!data || data.length === 0) {
    SpreadsheetApp.getUi().alert('No data found');
    return;
  }
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }
  
  sheet.clear();
  
  const headers = Object.keys(data[0]);
  
  // Write headers
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground(headerColor)
    .setFontColor('#FFFFFF')
    .setHorizontalAlignment('center');
  
  // Write data
  const rows = data.map(row => headers.map(header => row[header] || ''));
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  
  // Format
  sheet.autoResizeColumns(1, headers.length);
  sheet.setFrozenRows(1);
  
  // Add filters
  sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).createFilter();
  
  // Add timestamp
  const lastRow = sheet.getLastRow() + 2;
  sheet.getRange(lastRow, 1)
    .setValue(`Last updated: ${new Date().toLocaleString('en-IN')}`)
    .setFontStyle('italic')
    .setFontColor('#666666');
  
  // Color code status column if it exists
  const statusColIndex = headers.indexOf('Status');
  if (statusColIndex !== -1 && rows.length > 0) {
    const statusRange = sheet.getRange(2, statusColIndex + 1, rows.length, 1);
    statusRange.createTextFinder('CONFIRMED').matchEntireCell(true).replaceAllWith('CONFIRMED')
      .setBackground('#34A853').setFontColor('#FFFFFF');
    statusRange.createTextFinder('PENDING').matchEntireCell(true).replaceAllWith('PENDING')
      .setBackground('#FBBC04').setFontColor('#000000');
    statusRange.createTextFinder('REJECTED').matchEntireCell(true).replaceAllWith('REJECTED')
      .setBackground('#EA4335').setFontColor('#FFFFFF');
    statusRange.createTextFinder('CANCELLED').matchEntireCell(true).replaceAllWith('CANCELLED')
      .setBackground('#999999').setFontColor('#FFFFFF');
  }
}

// ═══════════════════════════════════════════════════════════
// TODAY'S APPOINTMENTS
// ═══════════════════════════════════════════════════════════
function getTodayAppointments() {
  const result = callAPI('today');
  if (result && result.data) {
    writeToSheet('Today', result.data, '#EA4335');
    SpreadsheetApp.getUi().alert(`✅ Today: ${result.count} appointment(s)`);
  }
}

// ═══════════════════════════════════════════════════════════
// ALL APPOINTMENTS
// ═══════════════════════════════════════════════════════════
function getAllAppointments() {
  const result = callAPI('appointments');
  if (result && result.data) {
    writeToSheet('All Appointments', result.data, '#4285F4');
    SpreadsheetApp.getUi().alert(`✅ Total: ${result.count} appointment(s)`);
  }
}

// ═══════════════════════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════════════════════
function getStatistics() {
  const result = callAPI('stats');
  if (result && result.data) {
    writeToSheet('Statistics', result.data, '#FBBC04');
    SpreadsheetApp.getUi().alert('✅ Statistics refreshed!');
  }
}

// ═══════════════════════════════════════════════════════════
// CLINIC INFO
// ═══════════════════════════════════════════════════════════
function getClinicInfo() {
  const result = callAPI('info');
  if (result && result.data) {
    writeToSheet('Clinic Info', result.data, '#34A853');
    SpreadsheetApp.getUi().alert('✅ Clinic info loaded!');
  }
}

// ═══════════════════════════════════════════════════════════
// DATE RANGE
// ═══════════════════════════════════════════════════════════
function getDateRange() {
  const ui = SpreadsheetApp.getUi();
  
  const startResponse = ui.prompt(
    'Start Date',
    'Enter start date (YYYY-MM-DD):',
    ui.ButtonSet.OK_CANCEL
  );
  
  if (startResponse.getSelectedButton() !== ui.Button.OK) return;
  const start = startResponse.getResponseText();
  
  const endResponse = ui.prompt(
    'End Date',
    'Enter end date (YYYY-MM-DD):',
    ui.ButtonSet.OK_CANCEL
  );
  
  if (endResponse.getSelectedButton() !== ui.Button.OK) return;
  const end = endResponse.getResponseText();
  
  const result = callAPI('range', { start, end });
  if (result && result.data) {
    writeToSheet('Date Range', result.data, '#9C27B0');
    ui.alert(`✅ Found ${result.count} appointments from ${start} to ${end}`);
  }
}

// ═══════════════════════════════════════════════════════════
// REFRESH ALL
// ═══════════════════════════════════════════════════════════
function refreshAll() {
  getTodayAppointments();
  getAllAppointments();
  getStatistics();
  getClinicInfo();
  SpreadsheetApp.getUi().alert('✅ All data refreshed!');
}

// ═══════════════════════════════════════════════════════════
// AUTO-REFRESH
// ═══════════════════════════════════════════════════════════
function setupAutoRefresh() {
  stopAutoRefresh();
  
  ScriptApp.newTrigger('refreshAll')
    .timeBased()
    .everyHours(1)
    .create();
  
  SpreadsheetApp.getUi().alert('✅ Auto-refresh enabled! Updates every hour.');
}

function stopAutoRefresh() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'refreshAll') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  SpreadsheetApp.getUi().alert('⏸️ Auto-refresh stopped.');
}

// ═══════════════════════════════════════════════════════════
// CUSTOM FUNCTIONS FOR CELLS
// ═══════════════════════════════════════════════════════════

/**
 * Get total appointments count
 * Usage: =CLINIC_TOTAL_APPOINTMENTS()
 */
function CLINIC_TOTAL_APPOINTMENTS() {
  const result = callAPI('stats');
  if (result && result.data) {
    const total = result.data.find(item => item.Metric === 'Total Appointments');
    return total ? total.Value : 0;
  }
  return 0;
}

/**
 * Get pending appointments count
 * Usage: =CLINIC_PENDING()
 */
function CLINIC_PENDING() {
  const result = callAPI('stats');
  if (result && result.data) {
    const pending = result.data.find(item => item.Metric === 'Pending');
    return pending ? pending.Value : 0;
  }
  return 0;
}

/**
 * Get today's appointments count
 * Usage: =CLINIC_TODAY()
 */
function CLINIC_TODAY() {
  const result = callAPI('stats');
  if (result && result.data) {
    const today = result.data.find(item => item.Metric === 'Today');
    return today ? today.Value : 0;
  }
  return 0;
}
