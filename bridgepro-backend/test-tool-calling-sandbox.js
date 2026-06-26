/**
 * BridgePro Tool-Calling Anomaly Detection — Sandbox Test Script v2
 *
 * Design principle:
 *   History avg ≈ $40. Test amount = $95 = 2.375× avg.
 *   → Tx 1 (velocity=0): amount is 2.375× avg but velocity=0, rule A doesn't apply yet. Borderline.
 *   → Tx 2 (velocity=1): rule A fires (amount ≥ 2× avg AND velocity ≥ 1). Mandatory ≥40.
 *   → Tx 3 (velocity=2): same rule A.
 *
 *   Tools fire within the mandatory 40-79 band to calibrate WHERE in the band:
 *   B (disputes): dispute tool → upheld disputes → score pushed toward 65-79
 *   A (clean):    dispute tool → clean record → appointment tool → no match → score ~50-55
 *   C (appt):     dispute tool → clean record → appointment tool → match! → score reduced ~40-45
 *
 *   KEY COMPARISON: B > A > C (if tools are actually moving the verdict)
 *
 * Scenario D uses a separate singleProvider to avoid velocity pollution from A.
 *
 * Usage:
 *   node test-tool-calling-sandbox.js             # run all + auto-cleanup
 *   node test-tool-calling-sandbox.js --keep      # leave data for inspection
 *   node test-tool-calling-sandbox.js --cleanup-only
 *   node test-tool-calling-sandbox.js --scenario A   # A | B | C | D | E
 */

'use strict';
require('dotenv').config();

const { v4: uuidv4 } = require('uuid');
const jwt            = require('jsonwebtoken');
const db             = require('./src/db');

const API_BASE   = 'http://127.0.0.1:3005/api/v1';
const COUNTRY    = 'SVG';
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) { console.error('JWT_SECRET not set'); process.exit(1); }

const ARGS         = process.argv.slice(2);
const KEEP_DATA    = ARGS.includes('--keep');
const CLEANUP_ONLY = ARGS.includes('--cleanup-only');
const ONLY_SCEN    = (() => { const i = ARGS.indexOf('--scenario'); return i !== -1 ? ARGS[i + 1].toUpperCase() : null; })();

// ── Fixed test UUIDs (v2 prefix "b0" — won't collide with v1 "a0" set) ───────
const IDS = {
  cleanProvider:       'b0000000-0000-0000-0000-000000000001', // Scenario A: no disputes, no appt
  disputedProvider:    'b0000000-0000-0000-0000-000000000002', // Scenario B: upheld disputes + prior flags
  appointmentProvider: 'b0000000-0000-0000-0000-000000000003', // Scenario C: appt near now, clean disputes
  singleProvider:      'b0000000-0000-0000-0000-000000000006', // Scenario D only: isolated clean single tx
  testCustomer:        'b0000000-0000-0000-0000-000000000004', // appointment FK target
  adminUser:           'b0000000-0000-0000-0000-000000000005',
  listingClean:        'b0000000-0000-0000-0000-000000000011',
  listingDisputed:     'b0000000-0000-0000-0000-000000000012',
  listingAppt:         'b0000000-0000-0000-0000-000000000013',
  listingSingle:       'b0000000-0000-0000-0000-000000000014',
};

const createdTxIds     = [];
const seededDisputeIds = [];

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeToken(userId, role) {
  return jwt.sign(
    { id: userId, role, country_code: COUNTRY, is_partner: false },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getRiskAssessment(transactionId) {
  if (!transactionId) return null;
  const { rows } = await db.query(
    `SELECT risk_score, reasoning, category, recommended_action, model_used, tools_used
     FROM transaction_risk_assessments WHERE transaction_id = $1`,
    [transactionId]
  );
  return rows[0] || null;
}

async function logTx(token, body) {
  const res = await api('POST', '/finance/log-manual-transaction', body, token);
  if (res.data.transaction_id) createdTxIds.push(res.data.transaction_id);
  return res;
}

function formatTools(toolsUsedStr) {
  if (!toolsUsedStr) return 'none';
  try {
    const t = JSON.parse(toolsUsedStr);
    if (!t || t.length === 0) return 'none';
    return t.map(n =>
      n === 'getProviderDisputeHistory'   ? 'dispute_history' :
      n === 'checkAppointmentCorrelation' ? 'appt_check'      : n
    ).join('+');
  } catch { return toolsUsedStr; }
}

function printTx(label, res, ra) {
  const d    = res.data;
  const flag = d.is_flagged ? '🚩 FLAGGED' : '✅ CLEAN';
  const score = ra
    ? `  risk=${ra.risk_score} action=${ra.recommended_action} model=${ra.model_used} tools=[${formatTools(ra.tools_used)}]`
    : '';
  const err  = d.error ? `  ⚠️  ${d.error}` : '';
  console.log(`   ${label}: HTTP ${res.status} ${flag}${score}${err}`);
  if (ra?.reasoning) console.log(`           reasoning: "${ra.reasoning}"`);
  return d;
}

// ── Setup ─────────────────────────────────────────────────────────────────────
async function setup() {
  console.log('\n📦 Creating test users & listings...');

  await db.query(`
    INSERT INTO users (id, country_code, email, password_hash, full_name, role, is_verified, created_at)
    VALUES
      ($1,'SVG','bp_tc_clean@sandbox.local',   'x','TC Clean Provider',      'provider',true, NOW() - INTERVAL '60 days'),
      ($2,'SVG','bp_tc_disputed@sandbox.local','x','TC Disputed Provider',   'provider',true, NOW() - INTERVAL '60 days'),
      ($3,'SVG','bp_tc_appt@sandbox.local',    'x','TC Appt Provider',       'provider',true, NOW() - INTERVAL '60 days'),
      ($4,'SVG','bp_tc_single@sandbox.local',  'x','TC Single Provider',     'provider',true, NOW() - INTERVAL '60 days'),
      ($5,'SVG','bp_tc_customer@sandbox.local','x','TC Test Customer',       'customer',true, NOW() - INTERVAL '30 days'),
      ($6,'SVG','bp_tc_admin@sandbox.local',   'x','TC Admin',               'admin',   true, NOW())
    ON CONFLICT (id) DO NOTHING
  `, [IDS.cleanProvider, IDS.disputedProvider, IDS.appointmentProvider,
      IDS.singleProvider, IDS.testCustomer, IDS.adminUser]);

  await db.query(`
    INSERT INTO listings (id, country_code, user_id, business_name, category, is_active, created_at)
    VALUES
      ($1,'SVG',$2,'TC Clean Electrical',    'Electrical',true,NOW()),
      ($3,'SVG',$4,'TC Disputed Electrical', 'Electrical',true,NOW()),
      ($5,'SVG',$6,'TC Appt Electrical',     'Electrical',true,NOW()),
      ($7,'SVG',$8,'TC Single Electrical',   'Electrical',true,NOW())
    ON CONFLICT (id) DO NOTHING
  `, [IDS.listingClean,    IDS.cleanProvider,
      IDS.listingDisputed, IDS.disputedProvider,
      IDS.listingAppt,     IDS.appointmentProvider,
      IDS.listingSingle,   IDS.singleProvider]);

  // ── Historical transactions: identical for A/B/C/D providers ──────────────
  // Amounts $32-48 → avg ≈ $40. Test amount $95 = 2.375× avg.
  // Rule A (amount ≥ 2× avg AND velocity ≥ 1) fires from Tx 2 onward.
  // This puts Tx 2 and 3 in the mandatory flag zone where tools calibrate within band.
  console.log('📊 Seeding historical transactions (avg ≈ $40, so $95 = 2.4× avg)...');
  const histAmounts = [34, 38, 42, 36, 46, 40, 33, 44, 38, 43]; // avg $39.4
  for (const pid of [IDS.cleanProvider, IDS.disputedProvider, IDS.appointmentProvider, IDS.singleProvider]) {
    for (let i = 0; i < histAmounts.length; i++) {
      const ts = new Date(Date.now() - (5 + i * 5) * 86_400_000);
      ts.setHours(9 + (i % 8), 0, 0, 0);
      await db.query(
        `INSERT INTO transactions
           (id, country_code, provider_id, amount, is_verified, provider_confirmed,
            customer_confirmed, verification_method, source,
            guest_customer_name, is_flagged, review_required, created_at)
         VALUES ($1,$2,$3,$4,true,true,true,'manual_verified','manual_verified',
                 'TC Historical Customer',false,false,$5)`,
        [uuidv4(), COUNTRY, pid, histAmounts[i], ts]
      );
    }
  }
  console.log(`   ✓ 10 historical txns per provider, avg ≈ $39`);

  // ── Seed prior flagged txns for ALL three burst providers ────────────────
  // cleanProvider + appointmentProvider: 1 prior flag each
  //   → context shows prior_flagged=1, model calls dispute tool to investigate
  // disputedProvider: 2 prior flags + 3 upheld disputes
  //   → dispute tool returns bad record → score pushed up vs clean providers
  console.log('⚖️  Seeding prior flagged transactions + dispute history...');

  // 1 prior flagged tx for cleanProvider (Scenario A)
  await db.query(
    `INSERT INTO transactions
       (id, country_code, provider_id, amount, is_verified, provider_confirmed,
        customer_confirmed, verification_method, source,
        guest_customer_name, is_flagged, review_required, created_at)
     VALUES ($1,$2,$3,220,true,true,true,'manual_verified','manual_verified',
             'TC Prior Customer',true,true,NOW() - INTERVAL '25 days')`,
    [uuidv4(), COUNTRY, IDS.cleanProvider]
  );

  // 1 prior flagged tx for appointmentProvider (Scenario C)
  await db.query(
    `INSERT INTO transactions
       (id, country_code, provider_id, amount, is_verified, provider_confirmed,
        customer_confirmed, verification_method, source,
        guest_customer_name, is_flagged, review_required, created_at)
     VALUES ($1,$2,$3,210,true,true,true,'manual_verified','manual_verified',
             'TC Prior Customer',true,true,NOW() - INTERVAL '22 days')`,
    [uuidv4(), COUNTRY, IDS.appointmentProvider]
  );

  // 3 upheld disputes for disputedProvider
  for (let i = 0; i < 3; i++) {
    const did = uuidv4();
    seededDisputeIds.push(did);
    const ts = new Date(Date.now() - (10 + i * 7) * 86_400_000);
    await db.query(
      `INSERT INTO customer_dispute_flags
         (id, provider_id, country_code, reason, status, resolved_at, created_at)
       VALUES ($1,$2,'SVG',$3,'resolved',$4,$5)`,
      [did, IDS.disputedProvider,
       `Overcharge dispute ${i + 1}`,
       new Date(ts.getTime() + 3 * 86_400_000),
       ts]
    );
  }
  // 2 prior flagged txns for disputedProvider (prior_flagged=2 in context)
  for (let i = 0; i < 2; i++) {
    const ts = new Date(Date.now() - (20 + i * 5) * 86_400_000);
    await db.query(
      `INSERT INTO transactions
         (id, country_code, provider_id, amount, is_verified, provider_confirmed,
          customer_confirmed, verification_method, source,
          guest_customer_name, is_flagged, review_required, created_at)
       VALUES ($1,$2,$3,$4,true,true,true,'manual_verified','manual_verified',
               'TC Prior Suspect Customer',true,true,$5)`,
      [uuidv4(), COUNTRY, IDS.disputedProvider, 350 + i * 50, ts]
    );
  }
  console.log('   ✓ cleanProvider: 1 prior flagged tx (dispute tool fires, finds clean record)');
  console.log('   ✓ appointmentProvider: 1 prior flagged tx (dispute tool fires, finds clean → appt checked)');
  console.log('   ✓ disputedProvider: 2 prior flagged txns + 3 upheld disputes (dispute tool finds bad record)');

  // ── Seed appointment for appointmentProvider ──────────────────────────────
  console.log('📅 Seeding appointment for appointmentProvider (+30min from now)...');
  const apptTime = new Date(Date.now() + 30 * 60 * 1000);
  await db.query(
    `INSERT INTO appointments
       (country_code, customer_id, provider_id, title, appointment_at, status, created_via)
     VALUES ('SVG',$1,$2,'TC Electrical Job (sandbox)',$3,'scheduled','manual')`,
    [IDS.testCustomer, IDS.appointmentProvider, apptTime]
  );
  console.log(`   ✓ Appointment at ${apptTime.toISOString()}`);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
async function cleanup() {
  console.log('\n🧹 Cleaning up test data...');
  const pids = [IDS.cleanProvider, IDS.disputedProvider, IDS.appointmentProvider, IDS.singleProvider];
  const allUserIds = [...pids, IDS.testCustomer, IDS.adminUser];

  if (seededDisputeIds.length) {
    await db.query(
      `DELETE FROM customer_dispute_flags WHERE id = ANY($1::uuid[])`,
      [seededDisputeIds]
    ).catch(() => {});
  }
  await db.query(
    `DELETE FROM customer_dispute_flags WHERE provider_id = ANY($1::uuid[])`,
    [pids]
  ).catch(() => {});

  await db.query(
    `DELETE FROM appointments WHERE provider_id = ANY($1::uuid[]) OR customer_id = ANY($1::uuid[])`,
    [pids]
  ).catch(() => {});

  await db.query(`DELETE FROM bridge_points_log WHERE user_id = ANY($1::uuid[])`, [pids]).catch(() => {});
  if (createdTxIds.length) {
    await db.query(
      `DELETE FROM bridge_points_log WHERE transaction_id = ANY($1::uuid[])`,
      [createdTxIds]
    ).catch(() => {});
  }

  await db.query(`DELETE FROM provider_documents WHERE user_id = ANY($1::uuid[])`, [pids]).catch(() => {});
  await db.query(`DELETE FROM transactions WHERE provider_id = ANY($1::uuid[])`, [pids]).catch(() => {});
  await db.query(
    `DELETE FROM listings WHERE id = ANY($1::uuid[])`,
    [[IDS.listingClean, IDS.listingDisputed, IDS.listingAppt, IDS.listingSingle]]
  ).catch(() => {});
  await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [allUserIds]).catch(() => {});

  console.log('   ✓ All test data removed');
}

// ── Scenario: 3 rapid transactions ───────────────────────────────────────────
async function runBurstScenario(label, description, token, note) {
  console.log(`\n${'━'.repeat(54)}`);
  console.log(`SCENARIO ${label} — ${description}`);
  if (note) console.log(`  ℹ️  ${note}`);

  const results = [];
  for (let i = 1; i <= 3; i++) {
    const res = await logTx(token, {
      customerName: `TC Burst Customer ${label}${i}`,
      amount:       95,               // 2.375× avg $39 → rule A from Tx 2 onward
      description:  `TC borderline job #${i}`,
    });
    const ra = await getRiskAssessment(res.data.transaction_id);
    printTx(`Tx ${i}`, res, ra);
    results.push({ flagged: res.data.is_flagged, score: ra?.risk_score || 0, tools: ra?.tools_used || null });
    await sleep(150);
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (CLEANUP_ONLY) { await cleanup(); process.exit(0); }

  await setup();

  const tokClean  = makeToken(IDS.cleanProvider,       'provider');
  const tokDisp   = makeToken(IDS.disputedProvider,    'provider');
  const tokAppt   = makeToken(IDS.appointmentProvider, 'provider');
  const tokSingle = makeToken(IDS.singleProvider,      'provider');
  const tokAdmin  = makeToken(IDS.adminUser,            'admin');

  const scenResults = {};

  // ── SCENARIO A — baseline: clean disputes, no appointment ─────────────────
  if (!ONLY_SCEN || ONLY_SCEN === 'A') {
    scenResults.A = await runBurstScenario(
      'A', 'Borderline burst — clean dispute record, no appointment',
      tokClean,
      'Tx2+ triggers rule A → dispute tool should fire → clean → appt tool checks → no match → score ~50-55'
    );
  }

  // ── SCENARIO B — same burst, provider has upheld disputes + prior flags ────
  if (!ONLY_SCEN || ONLY_SCEN === 'B') {
    scenResults.B = await runBurstScenario(
      'B', 'Same burst — 3 upheld disputes + 2 prior flagged transactions',
      tokDisp,
      'Tx2+ triggers rule A + prior_flagged=2 → dispute tool fires → 3 upheld → score HIGHER than A (~65-79)'
    );
  }

  // ── SCENARIO C — same burst, confirmed appointment within ±4hr ────────────
  if (!ONLY_SCEN || ONLY_SCEN === 'C') {
    scenResults.C = await runBurstScenario(
      'C', 'Same burst — appointment booked +30min from now',
      tokAppt,
      'Tx2+ triggers rule A → dispute tool: clean → appt tool: match_found=true → score LOWER than A (~40-45)'
    );
  }

  // ── SCENARIO D — single low-value tx, isolated singleProvider ─────────────
  if (!ONLY_SCEN || ONLY_SCEN === 'D') {
    console.log(`\n${'━'.repeat(54)}`);
    console.log('SCENARIO D — Single low-value tx, isolated provider (no prior velocity)');
    console.log('  ℹ️  Expect: NO tool calls, auto_clear, score < 20');
    console.log('  ℹ️  Uses singleProvider (separate from A) — no velocity cross-contamination');
    const res = await logTx(tokSingle, {
      customerName: 'TC Routine Customer',
      amount:       38,               // well below avg $39 — completely unremarkable
      description:  'TC routine single job',
    });
    const ra = await getRiskAssessment(res.data.transaction_id);
    printTx('Tx', res, ra);
    scenResults.D = [{ flagged: res.data.is_flagged, score: ra?.risk_score || 0, tools: ra?.tools_used || null }];
    const pass = !res.data.is_flagged && !ra?.tools_used;
    console.log(`   PASS? ${pass ? '✅ YES — clean + no tool calls' : `⚠️  ${res.data.is_flagged ? 'unexpectedly flagged' : 'tools were called on a clear-cut case'}`}`);
  }

  // ── SCENARIO E — tool cap note ────────────────────────────────────────────
  if (!ONLY_SCEN || ONLY_SCEN === 'E') {
    console.log(`\n${'━'.repeat(54)}`);
    console.log('SCENARIO E — Tool call cap (log audit)');
    console.log('  ℹ️  Cap = MAX_ROUNDS=2. Both tools may fire in round 1 (one tool_use block each),');
    console.log('     or sequentially across rounds. A 3rd request triggers the limit path.');
    console.log('     Verify by checking server logs after A/B/C run:');
    console.log('     pm2 logs bridgepro-api --lines 200 | grep -i "limit reached"');
  }

  // ── ADMIN QUEUE ────────────────────────────────────────────────────────────
  if (!ONLY_SCEN) {
    console.log(`\n${'━'.repeat(54)}`);
    console.log('ADMIN QUEUE — GET /admin/integrations/flagged');
    const r = await api('GET', '/admin/integrations/flagged', null, tokAdmin);
    const flagged = r.data.flagged || [];
    const testIds = new Set([IDS.cleanProvider, IDS.disputedProvider, IDS.appointmentProvider, IDS.singleProvider]);
    const testFlagged = flagged.filter(f => testIds.has(f.provider_id));
    console.log(`   HTTP ${r.status} — ${testFlagged.length} flagged test transaction(s) in queue`);
    if (testFlagged.length) {
      const hasTools    = testFlagged.some(f => f.tools_used);
      const toolsList   = testFlagged.map(f => `${f.email?.replace('@sandbox.local','')}:[${formatTools(f.tools_used)}]`).join(', ');
      console.log(`   tools_used per provider: ${toolsList}`);
      console.log(`   Any tool-informed flags? ${hasTools ? '✅ YES' : '❌ NO — tools_used all null'}`);
      console.log(`   Sorted by risk_score DESC: ${
        testFlagged.every((row, i) => i === 0 || (row.risk_score || 0) <= (testFlagged[i-1].risk_score || 0)) ? '✅' : '❌'
      }`);
    } else {
      console.log('   ℹ️  No flagged test transactions (all may have been auto_clear — see key comparison)');
    }
  }

  // ── KEY COMPARISON ─────────────────────────────────────────────────────────
  console.log(`\n${'━'.repeat(54)}`);
  console.log('KEY COMPARISON — B > A > C proves tools are moving the verdict');

  if (scenResults.A && scenResults.B && scenResults.C) {
    const maxScore = arr => Math.max(...arr.map(r => r.score));
    const anyTools = arr => arr.some(r => r.tools);
    const scoreA = maxScore(scenResults.A);
    const scoreB = maxScore(scenResults.B);
    const scoreC = maxScore(scenResults.C);

    console.log(`\n   Score A (clean baseline)   : ${scoreA.toString().padStart(3)}  tools=${anyTools(scenResults.A) ? '✅' : '❌'}`);
    console.log(`   Score B (upheld disputes)  : ${scoreB.toString().padStart(3)}  tools=${anyTools(scenResults.B) ? '✅' : '❌'}`);
    console.log(`   Score C (appt match)       : ${scoreC.toString().padStart(3)}  tools=${anyTools(scenResults.C) ? '✅' : '❌'}`);

    const bGtA     = scoreB >  scoreA;
    const cLtA     = scoreC <  scoreA;
    const toolsAFired = anyTools(scenResults.A);
    const toolsBFired = anyTools(scenResults.B);
    const toolsCFired = anyTools(scenResults.C);

    console.log('');
    console.log(`   B > A (disputes raise score)?  ${bGtA      ? '✅ YES' : `❌ NO  (B=${scoreB} vs A=${scoreA})`}`);
    console.log(`   C < A (appointment lowers)?    ${cLtA      ? '✅ YES' : `❌ NO  (C=${scoreC} vs A=${scoreA})`}`);
    console.log(`   Dispute history tool called?   ${toolsBFired ? '✅ YES' : '❌ NO'}`);
    console.log(`   Appointment tool called?       ${toolsCFired ? '✅ YES' : '❌ NO'}`);
    console.log(`   Tools also called for baseline?${toolsAFired ? ' ✅ YES (expected for A too)' : ' ❌ NO (A should also call tools)'}`);

    const overallPass = bGtA && cLtA;
    console.log(`\n   OVERALL: ${overallPass
      ? '✅ PASS — tools are influencing verdicts directionally'
      : '⚠️  FAIL — see tuning hints below'}`);

    if (!overallPass) {
      console.log('\n   Tuning hints:');
      if (!toolsBFired && !toolsCFired) {
        console.log('   → No tools called at all. Check that transaction.id and provider.id are in contextMsg');
        console.log('     (required for model to populate tool arguments). Also verify the model sees rule A');
        console.log('     triggered (amount ≥ 2× avg and velocity ≥ 1) in the context before Tx 2.');
      }
      if (toolsBFired && !bGtA) console.log('   → Dispute tool called but score unchanged. Increase weight of upheld_count in system prompt.');
      if (toolsCFired && !cLtA) console.log('   → Appt tool called but score unchanged. Increase appointment score reduction from 15 to 20 pts.');
      if (!toolsBFired) console.log('   → Dispute history tool not called for B. Make sure prior_flagged_transactions shows 2 in context (check DB seeding).');
      if (!toolsCFired) console.log('   → Appt tool not called for C. Check appointment was seeded with appointmentProvider UUID and appointment_at is within ±4hr.');
    }
  } else {
    console.log('   (Run without --scenario to see full three-way comparison)');
  }

  // ── Fallback reminder ──────────────────────────────────────────────────────
  console.log(`\n${'━'.repeat(54)}`);
  console.log('FALLBACK PATH test (manual, needs server restart):');
  console.log('  1. Edit .env → ANTHROPIC_API_KEY=bad_key_test');
  console.log('  2. pm2 restart bridgepro-api');
  console.log('  3. node test-tool-calling-sandbox.js --scenario D');
  console.log('     Expect: model_used=fallback_rule, tools_used=null, risk_score=0 (single tx, velocity < 3)');
  console.log('  4. Restore key → pm2 restart bridgepro-api');

  if (!KEEP_DATA) {
    await cleanup();
  } else {
    console.log('\n⚠️  --keep: data left for inspection. Cleanup: node test-tool-calling-sandbox.js --cleanup-only');
    console.log('   Provider IDs:', IDS);
  }
}

run()
  .then(() => process.exit(0))
  .catch(err => { console.error('\n💥 Fatal:', err.message, '\n', err.stack); process.exit(1); });
