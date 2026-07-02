/**
 * reset_test_data.js
 * ─────────────────
 * Resets one or more test Contact records to a clean state for re-testing
 * the Smart Grouping / Missing Info flow.
 *
 * Usage:
 *   node scripts/reset_test_data.js                             ← resets all TEST_USERS below
 *   node scripts/reset_test_data.js taanihihi_50147             ← reset one user
 *   node scripts/reset_test_data.js user1_123 user2_456 user3_789 ← reset multiple users
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

// ─── ADD YOUR TEST USERS HERE ──────────────────────────────────────────────
const TEST_USERS = [
    'taanihihi_50147',
    // 'alextest_12345',     ← uncomment or add more handles here
    // 'jordantest_67890',
];
// ──────────────────────────────────────────────────────────────────────────

// If handles are passed as CLI args, use those instead of TEST_USERS
const cliArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const HANDLES_TO_RESET = cliArgs.length > 0 ? cliArgs : TEST_USERS;

(async () => {
    const pool = mysql.createPool({
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: { rejectUnauthorized: false }
    });

    // Get all tracked field names from AI_fields once
    const [aiFields] = await pool.execute('SELECT FIELD_NAME FROM AI_fields');
    const columns = aiFields.map(f => f.FIELD_NAME);
    const setClauses = columns.map(c => `\`${c}\` = NULL`).join(', ');

    console.log(`\n🔄 Resetting ${HANDLES_TO_RESET.length} test user(s)...\n`);

    for (const handle of HANDLES_TO_RESET) {
        console.log(`─── ${handle} ───`);

        // 1. NULL out all tracked Contact fields
        const [contactResult] = await pool.execute(
            `UPDATE Contact SET ${setClauses} WHERE Discord_Handle__c = ?`,
            [handle]
        );
        if (contactResult.affectedRows === 0) {
            console.log(`  ⚠️  No Contact record found — skipping field reset`);
        } else {
            console.log(`  ✅ Nulled ${columns.length} fields in Contact`);
        }

        // 2. Reset the 48-hour cooldown
        const [activityResult] = await pool.execute(
            'UPDATE user_activity SET last_notified = 0 WHERE username = ?',
            [handle]
        );
        if (activityResult.affectedRows === 0) {
            console.log(`  ⚠️  Not in user_activity yet — cooldown will be set on first message`);
        } else {
            console.log(`  ✅ Cooldown reset`);
        }

        // 3. Clear pending_updates queue
        await pool.execute(
            "DELETE FROM pending_updates WHERE user_id IN (SELECT id FROM (SELECT id FROM user_activity WHERE username = ?) AS t)",
            [handle]
        );
        console.log(`  ✅ Cleared pending_updates queue\n`);
    }

    console.log(`✨ Done! Use /audit_missing in Discord to trigger the test flow.\n`);
    await pool.end();
})().catch(e => console.error('❌ Error:', e.message));
