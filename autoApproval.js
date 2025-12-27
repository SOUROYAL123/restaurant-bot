/**
 * ═══════════════════════════════════════════════════════════
 * AUTO-APPROVAL - SIMPLIFIED VERSION
 * Disabled by default - all appointments require doctor approval
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function processAutoApprovals() {
    console.log('⚠️ Auto-approval is disabled - all appointments require manual doctor approval');
    return { processed: 0, message: 'Auto-approval disabled' };
}

// Run if executed directly
if (require.main === module) {
    processAutoApprovals()
        .then(result => {
            console.log('✅ Job completed:', result);
            process.exit(0);
        })
        .catch(error => {
            console.error('❌ Job failed:', error);
            process.exit(1);
        });
}

module.exports = { processAutoApprovals };
