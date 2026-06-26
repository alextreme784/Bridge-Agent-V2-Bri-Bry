/**
 * BridgePro Anomaly Detection — Sandbox Test Script
 *
 * What this does:
 *   1. Creates isolated test providers + seeds historical transactions
 *   2. Generates short-lived JWTs without touching the login endpoint
 *   3. Runs 4 scenarios against the real local API
 *   4. Verifies the admin review queue surfaces reasoning/category correctly
 *   5. Cleans up every test row it created
 *
 * Usage:
 *   node test-anomaly-sandbox.js          # run + auto-cleanup
 *   node test-anomaly-sandbox.js --keep   # leave test data in DB for manual inspection
 *   node test-anomaly-sandbox.js --cleanup-only  # delete leftover test data from a previous --keep run
 *
 * Fallback path test (manual — can't automate without a server restart):
 *   1. In /var/www/bridgepro/bridgepro-backend/.env set ANTHROPIC_API_KEY=bad_key_test
 *   2. pm2 restart bridgepro-api
 *   3. node test-anomaly-sandbox.js --scenario 1
 *   4. Check output — model_used should be "fallback_rule"
 *   5. Restore real key + pm2 restart bridgepro-api
 */

'use strict';
require('dotenv').config();

const { v4: uuidv4 } = require('uuid');
const jwt            = require('jsonwebtoken');
const db             = require('./src/db');

const API_BASE  = 'http://127.0.0.1:3005/api/v1';
const COUNTRY   = 'SVG';
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) { console.error('JWT_SECRET not set'); process.exit(1); }

const ARGS        = process.argv.slice(2);
const KEEP_DATA   = ARGS.includes('--keep');
const CLEANUP_ONLY = ARGS.includes('--cleanup-only');
const ONLY_SCENARIO = (() => { const i = ARGS.indexOf('--scenario'); return i !== -1 ? parseInt(ARGS[i + 1]) : null; })();

// ── Fixed test UUIDs (deterministic — easy to find & delete) ─────────────────
const IDS = {
  providerStandard: 'a0000000-0000-0000-0000-000000000001',
  providerHvac:     'a0000000-0000-0000-0000-000000000002',
  providerNew:      'a0000000-0000-0000-0000-000000000003',
  adminUser:        'a0000000-0000-0000-0000-000000000004',
  listingStandard:  'a0000000-0000-0000-0000-000000000011',
  listingHvac:      'a0000000-0000-0000-0000-000000000012',
};

// Tracks every transaction_id created so cleanup is precise
const createdTransactionIds = [];

// ── JWT helper ────────────────────────────────────────────────────────────────
function makeToken(userId, role) {
  return jwt.sign(
    { id: userId, role, country_code: COUNTRY, is_partner: false },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// ── API helper ────────────────────────────────────────────────────────────────
async function api(method, path, body, token) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Country-Code': COUNTRY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res  = await fetch(`${API_BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ── Seed helpers ──────────────────────────────────────────────────────────────
function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000);
}

async function seedHistoricalTransactions(providerId, specs) {
  // specs: [{ daysAgo, hour, amount }]
  for (const s of specs) {
    const id  = uuidv4();
    const ts  = daysAgo(s.daysAgo);
    ts.setHours(s.hour, Math.floor(Math.random() * 60), 0, 0);
    await db.query(
      `INSERT INTO transactions
         (id, country_code, provider_id, amount, is_verified, provider_confirmed,
          customer_confirmed, verification_method, source,
          guest_customer_name, is_flagged, review_required, created_at)
       VALUES ($1,$2,$3,$4,true,true,true,'manual_verified','manual_verified',
               'Test Customer',false,false,$5)`,
      [id, COUNTRY, providerId, s.amount, ts]
    );
    createdTransactionIds.push(id);
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
async function setup() {
  console.log('\n📦 Creating test users...');

  // Insert test providers (INSERT … ON CONFLICT DO NOTHING so re-runs are safe)
  await db.query(`
    INSERT INTO users (id, country_code, email, password_hash, full_name, role, is_verified, created_at)
    VALUES
      ($1,'SVG','bp_test_standard@sandbox.local','x','Test Provider Standard','provider',true, NOW() - INTERVAL '120 days'),
      ($2,'SVG','bp_test_hvac@sandbox.local',    'x','Test Provider HVAC',    'provider',true, NOW() - INTERVAL '90 days'),
      ($3,'SVG','bp_test_new@sandbox.local',     'x','Test Provider New',     'provider',true, NOW() - INTERVAL '2 days'),
      ($4,'SVG','bp_test_admin@sandbox.local',   'x','Test Admin',            'admin',  true, NOW())
    ON CONFLICT (id) DO NOTHING
  `, [IDS.providerStandard, IDS.providerHvac, IDS.providerNew, IDS.adminUser]);

  // Insert listings with categories so the LLM sees them in context
  await db.query(`
    INSERT INTO listings
      (id, country_code, user_id, business_name, category, is_active, created_at)
    VALUES
      ($1,'SVG',$2,'Test Plumbing Co',      'Plumbing',          true, NOW()),
      ($3,'SVG',$4,'Test HVAC Emergency Co','Emergency Services', true, NOW())
    ON CONFLICT (id) DO NOTHING
  `, [IDS.listingStandard, IDS.providerStandard, IDS.listingHvac, IDS.providerHvac]);

  console.log('📊 Seeding historical transactions...');

  // Standard Plumbing provider — steady weekday business-hours pattern, avg $120
  const standardHistory = [];
  for (let d = 90; d >= 10; d -= Math.ceil(Math.random() * 5 + 2)) {
    standardHistory.push({
      daysAgo: d,
      hour:    9 + Math.floor(Math.random() * 8),  // 9am-5pm
      amount:  100 + Math.floor(Math.random() * 60), // $100-$160
    });
    if (standardHistory.length >= 18) break;
  }
  await seedHistoricalTransactions(IDS.providerStandard, standardHistory);

  // HVAC Emergency provider — mix of daytime + evening/weekend calls, avg $280
  const hvacHistory = [];
  for (let d = 88; d >= 8; d -= Math.ceil(Math.random() * 4 + 1)) {
    hvacHistory.push({
      daysAgo: d,
      hour:    [8, 10, 14, 18, 21, 23][Math.floor(Math.random() * 6)], // mixed hours
      amount:  200 + Math.floor(Math.random() * 200), // $200-$400
    });
    if (hvacHistory.length >= 20) break;
  }
  await seedHistoricalTransactions(IDS.providerHvac, hvacHistory);

  // New provider — NO historical transactions (that's the whole point of Scenario 3)

  console.log(`   ✓ ${standardHistory.length} transactions → Standard/Plumbing provider`);
  console.log(`   ✓ ${hvacHistory.length} transactions → HVAC Emergency provider`);
  console.log(`   ✓ 0 transactions → New provider`);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
async function cleanup() {
  console.log('\n🧹 Cleaning up test data...');

  const testProviderIds = [IDS.providerStandard, IDS.providerHvac, IDS.providerNew];

  // transaction_risk_assessments CASCADE-deletes with transactions
  // bridge_points_log may NOT cascade — delete explicitly
  await db.query(
    `DELETE FROM bridge_points_log WHERE user_id = ANY($1::uuid[])`,
    [testProviderIds]
  ).catch(() => {});

  await db.query(
    `DELETE FROM bridge_points_log
     WHERE transaction_id = ANY($1::uuid[])`,
    [createdTransactionIds.length ? createdTransactionIds : ['00000000-0000-0000-0000-000000000000']]
  ).catch(() => {});

  // provider_documents
  await db.query(
    `DELETE FROM provider_documents WHERE user_id = ANY($1::uuid[])`,
    [testProviderIds]
  ).catch(() => {});

  // transactions (CASCADE removes transaction_risk_assessments)
  await db.query(
    `DELETE FROM transactions WHERE provider_id = ANY($1::uuid[])`,
    [testProviderIds]
  ).catch(() => {});

  // listings
  await db.query(
    `DELETE FROM listings WHERE id = ANY($1::uuid[])`,
    [[IDS.listingStandard, IDS.listingHvac]]
  ).catch(() => {});

  // users (must be last)
  await db.query(
    `DELETE FROM users WHERE id = ANY($1::uuid[])`,
    [[...testProviderIds, IDS.adminUser]]
  ).catch(() => {});

  console.log('   ✓ All test data removed');
}

// ── Scenario runner ───────────────────────────────────────────────────────────
function printResult(label, res, extra = '') {
  const d = res.data;
  const flag  = d.is_flagged  ? '🚩 FLAGGED'  : '✅ CLEAN';
  const score = d.risk_score !== undefined ? `  risk_score=${d.risk_score}` : '';
  const msg   = d.message     ? `\n     msg: ${d.message}` : '';
  const err   = d.error       ? `\n     ⚠️  error: ${d.error}` : '';
  console.log(`   ${label}: HTTP ${res.status} ${flag}${score}${msg}${err}${extra ? '\n     ' + extra : ''}`);
  return d;
}

async function logTx(token, body) {
  const res = await api('POST', '/finance/log-manual-transaction', body, token);
  if (res.data.transaction_id) createdTransactionIds.push(res.data.transaction_id);
  return res;
}

async function getRiskAssessment(transactionId) {
  if (!transactionId) return null;
  const { rows } = await db.query(
    `SELECT risk_score, reasoning, category, recommended_action, model_used
     FROM transaction_risk_assessments WHERE transaction_id = $1`,
    [transactionId]
  );
  return rows[0] || null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (CLEANUP_ONLY) {
    await cleanup();
    process.exit(0);
  }

  await setup();

  const tokStd   = makeToken(IDS.providerStandard, 'provider');
  const tokHvac  = makeToken(IDS.providerHvac,     'provider');
  const tokNew   = makeToken(IDS.providerNew,       'provider');
  const tokAdmin = makeToken(IDS.adminUser,          'admin');

  const results = {};

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 1 — Control: single normal transaction from established provider
  // Expect: auto_clear, risk_score < 40
  // ──────────────────────────────────────────────────────────────────────────
  if (!ONLY_SCENARIO || ONLY_SCENARIO === 1) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('SCENARIO 1 — Control: single normal transaction');
    const r = await logTx(tokStd, {
      customerName: 'Normal Customer',
      amount:       125,
      description:  'Pipe repair — residential',
    });
    const d = printResult('Tx', r);
    const ra = await getRiskAssessment(d.transaction_id);
    if (ra) console.log(`   LLM: score=${ra.risk_score} action=${ra.recommended_action} category=${ra.category} model=${ra.model_used}\n   reasoning: ${ra.reasoning}`);
    results.s1 = { score: ra?.risk_score, action: ra?.recommended_action, model: ra?.model_used };
    console.log(`   PASS? ${!d.is_flagged && (ra?.risk_score || 0) < 40 ? '✅ YES — correctly clean' : '❌ NO — unexpected flag'}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 2 — Velocity burst: established Plumbing provider, atypical burst
  // Expect: flag_for_review or escalate, velocity_spike or inconsistent_with_history
  // ──────────────────────────────────────────────────────────────────────────
  if (!ONLY_SCENARIO || ONLY_SCENARIO === 2) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('SCENARIO 2 — Burst: Plumbing provider, 4 rapid transactions, 3× avg amount');
    const burst = [
      { customerName: 'Burst Customer A', amount: 380, description: 'Emergency repair burst A' },
      { customerName: 'Burst Customer B', amount: 395, description: 'Emergency repair burst B' },
      { customerName: 'Burst Customer C', amount: 410, description: 'Emergency repair burst C' },
      { customerName: 'Burst Customer D', amount: 390, description: 'Emergency repair burst D' },
    ];
    const s2results = [];
    for (const body of burst) {
      const r  = await logTx(tokStd, body);
      const d  = printResult(`  Tx (${body.amount} XCD)`, r);
      const ra = await getRiskAssessment(d.transaction_id);
      if (ra) console.log(`     score=${ra.risk_score} action=${ra.recommended_action} cat=${ra.category} model=${ra.model_used}`);
      s2results.push({ flagged: d.is_flagged, score: ra?.risk_score, action: ra?.recommended_action });
    }
    const anyFlagged = s2results.some(r => r.flagged);
    const maxScore   = Math.max(...s2results.map(r => r.score || 0));
    results.s2 = { maxScore, anyFlagged };
    console.log(`   PASS? ${anyFlagged ? `✅ YES — flagged (max score: ${maxScore})` : '❌ NO — burst not detected'}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 3 — New provider burst: just registered, no history, 3 quick txns
  // Expect: new_provider_burst category
  // ──────────────────────────────────────────────────────────────────────────
  if (!ONLY_SCENARIO || ONLY_SCENARIO === 3) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('SCENARIO 3 — New provider: 3 transactions with no prior history');
    const s3results = [];
    for (let i = 1; i <= 3; i++) {
      const r  = await logTx(tokNew, {
        customerName: `New Customer ${i}`,
        amount:       200 + i * 50,
        description:  `First jobs burst ${i}`,
      });
      const d  = printResult(`  Tx ${i}`, r);
      const ra = await getRiskAssessment(d.transaction_id);
      if (ra) console.log(`     score=${ra.risk_score} action=${ra.recommended_action} cat=${ra.category} model=${ra.model_used}`);
      s3results.push({ flagged: d.is_flagged, category: ra?.category, score: ra?.risk_score });
    }
    const gotNewProviderCat = s3results.some(r => r.category === 'new_provider_burst');
    results.s3 = { gotNewProviderCat, scores: s3results.map(r => r.score) };
    console.log(`   PASS? ${gotNewProviderCat ? '✅ YES — new_provider_burst detected' : `⚠️  category not new_provider_burst (got: ${s3results.map(r => r.category).join(', ')})`}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 4 — Same burst pattern as S2 but category = Emergency Services
  // KEY TEST: risk_score should be MEANINGFULLY LOWER than Scenario 2's max
  // This proves the LLM is reasoning about context, not just counting transactions
  // ──────────────────────────────────────────────────────────────────────────
  if (!ONLY_SCENARIO || ONLY_SCENARIO === 4) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('SCENARIO 4 — Same burst, HVAC/Emergency provider (plausible spike)');
    const s4results = [];
    for (let i = 1; i <= 4; i++) {
      const r  = await logTx(tokHvac, {
        customerName: `Emergency Customer ${i}`,
        amount:       350 + i * 20,
        description:  `AC emergency callout — refrigerant leak ${i}`,
      });
      const d  = printResult(`  Tx ${i} (HVAC)`, r);
      const ra = await getRiskAssessment(d.transaction_id);
      if (ra) console.log(`     score=${ra.risk_score} action=${ra.recommended_action} cat=${ra.category} model=${ra.model_used}`);
      s4results.push({ flagged: d.is_flagged, score: ra?.risk_score, action: ra?.recommended_action });
    }
    const maxScore = Math.max(...s4results.map(r => r.score || 0));
    results.s4 = { maxScore };

    if (results.s2) {
      const diff = results.s2.maxScore - maxScore;
      console.log(`\n   ── INTELLIGENCE CHECK ──`);
      console.log(`   Scenario 2 (Plumbing) max risk_score : ${results.s2.maxScore}`);
      console.log(`   Scenario 4 (HVAC/Emrg) max risk_score: ${maxScore}`);
      console.log(`   Difference                            : ${diff} points`);
      console.log(`   PASS? ${diff >= 10
        ? `✅ YES — HVAC scored ${diff}pts lower (category context working)`
        : diff >= 0
          ? `⚠️  MARGINAL — only ${diff}pts difference (may need prompt tuning)`
          : `❌ NO — HVAC scored HIGHER (context not influencing output)`}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ADMIN QUEUE — verify reasoning/category surface correctly, sorted by risk
  // ──────────────────────────────────────────────────────────────────────────
  if (!ONLY_SCENARIO) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('ADMIN QUEUE — GET /admin/integrations/flagged');
    const r = await api('GET', '/admin/integrations/flagged', null, tokAdmin);
    const flagged = r.data.flagged || [];
    console.log(`   HTTP ${r.status} — ${flagged.length} flagged transaction(s) in queue`);
    if (flagged.length) {
      // Check first item has the new fields
      const first = flagged[0];
      const hasReasoning   = typeof first.reasoning === 'string';
      const hasCategory    = typeof first.risk_category === 'string';
      const hasScore       = typeof first.risk_score === 'number';
      const hasAction      = typeof first.recommended_action === 'string';
      const isSortedByRisk = flagged.every((row, i) =>
        i === 0 || (row.risk_score || 0) <= (flagged[i - 1].risk_score || 0)
      );
      console.log(`   Fields present: reasoning=${hasReasoning} risk_category=${hasCategory} risk_score=${hasScore} recommended_action=${hasAction}`);
      console.log(`   Sorted by risk_score DESC: ${isSortedByRisk ? '✅' : '❌'}`);
      console.log(`   Top item: score=${first.risk_score} category=${first.risk_category} action=${first.recommended_action}`);
      console.log(`   Reasoning: "${first.reasoning?.slice(0, 120)}"`);
      console.log(`   PASS? ${hasReasoning && hasCategory && hasScore && isSortedByRisk ? '✅ YES' : '❌ Missing fields or wrong sort order'}`);
    } else {
      console.log('   ⚠️  No flagged transactions in queue — run scenarios first or check filter');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('SUMMARY');
  if (results.s1) console.log(`  S1 Control    : score=${results.s1.score} action=${results.s1.action} model=${results.s1.model}`);
  if (results.s2) console.log(`  S2 Plumbing   : maxScore=${results.s2.maxScore} anyFlagged=${results.s2.anyFlagged}`);
  if (results.s3) console.log(`  S3 NewProvider: gotCategory=${results.s3.gotNewProviderCat} scores=${results.s3.scores}`);
  if (results.s4) console.log(`  S4 HVAC/Emrg  : maxScore=${results.s4.maxScore}`);

  console.log('\n📋 Fallback path (manual test):');
  console.log('   1. Edit .env → ANTHROPIC_API_KEY=bad_key_test');
  console.log('   2. pm2 restart bridgepro-api');
  console.log('   3. node test-anomaly-sandbox.js --scenario 1');
  console.log('   4. Expect: model_used="fallback_rule" in transaction_risk_assessments');
  console.log('      (risk_score=0 + no flag for a single tx, since count < 3)');
  console.log('   5. Restore real key → pm2 restart bridgepro-api');

  if (!KEEP_DATA) {
    await cleanup();
  } else {
    console.log('\n⚠️  --keep flag set — test data left in DB for inspection');
    console.log('   To clean up later: node test-anomaly-sandbox.js --cleanup-only');
    console.log('   Test provider IDs:');
    Object.entries(IDS).forEach(([k, v]) => console.log(`     ${k}: ${v}`));
  }
}

run()
  .then(() => { process.exit(0); })
  .catch(err => { console.error('\n💥 Fatal error:', err.message); process.exit(1); });
