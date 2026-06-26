const express  = require('express');
const db       = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { signDocument } = require('../utils/docSignature');

const router = express.Router();

// ── Schema bootstrap ──────────────────────────────────────────────────────────
db.query(`
  CREATE TABLE IF NOT EXISTS employees (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    full_name      VARCHAR(200) NOT NULL,
    national_id    VARCHAR(50),
    position       VARCHAR(100),
    department     VARCHAR(100),
    start_date     DATE,
    is_active      BOOLEAN DEFAULT true,
    gross_salary   NUMERIC(12,2) NOT NULL DEFAULT 0,
    pay_frequency  VARCHAR(20) DEFAULT 'monthly',
    standard_hours NUMERIC(6,2),
    created_at     TIMESTAMP DEFAULT NOW(),
    updated_at     TIMESTAMP DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_employees_provider ON employees(provider_id);
  ALTER TABLE employees ADD COLUMN IF NOT EXISTS standard_hours NUMERIC(6,2);
  ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;

  CREATE TABLE IF NOT EXISTS country_payroll_rates (
    country_code            VARCHAR(10) PRIMARY KEY,
    nis_employee            NUMERIC(6,4) NOT NULL,
    nis_employer            NUMERIC(6,4) NOT NULL,
    monthly_nis_ceiling     NUMERIC(12,2) NOT NULL,
    personal_allowance      NUMERIC(12,2) NOT NULL,
    income_tax_rate         NUMERIC(6,4) NOT NULL,
    nis_deductible_from_tax BOOLEAN NOT NULL DEFAULT false,
    notes                   TEXT,
    updated_by_email        VARCHAR(255),
    updated_at              TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS payroll_runs (
    id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_label           VARCHAR(100),
    period_start           DATE NOT NULL,
    period_end             DATE NOT NULL,
    pay_date               DATE NOT NULL,
    status                 VARCHAR(20) DEFAULT 'processed',
    total_gross            NUMERIC(12,2) DEFAULT 0,
    total_nis_employee     NUMERIC(12,2) DEFAULT 0,
    total_nis_employer     NUMERIC(12,2) DEFAULT 0,
    total_income_tax       NUMERIC(12,2) DEFAULT 0,
    total_other_deductions NUMERIC(12,2) DEFAULT 0,
    total_net              NUMERIC(12,2) DEFAULT 0,
    employee_count         INTEGER DEFAULT 0,
    country_code           VARCHAR(10) DEFAULT 'SVG',
    notes                  TEXT,
    created_at             TIMESTAMP DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_payroll_runs_provider ON payroll_runs(provider_id);
  CREATE INDEX IF NOT EXISTS idx_payroll_runs_period   ON payroll_runs(period_start);

  CREATE TABLE IF NOT EXISTS payroll_run_items (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payroll_run_id   UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    employee_id      UUID NOT NULL REFERENCES employees(id),
    provider_id      UUID NOT NULL REFERENCES users(id),
    employee_name    VARCHAR(200),
    national_id      VARCHAR(50),
    position         VARCHAR(100),
    gross_pay        NUMERIC(12,2) NOT NULL DEFAULT 0,
    nis_employee     NUMERIC(12,2) DEFAULT 0,
    nis_employer     NUMERIC(12,2) DEFAULT 0,
    income_tax       NUMERIC(12,2) DEFAULT 0,
    other_deductions NUMERIC(12,2) DEFAULT 0,
    net_pay          NUMERIC(12,2) NOT NULL DEFAULT 0,
    transaction_id   UUID,
    created_at       TIMESTAMP DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_pri_run      ON payroll_run_items(payroll_run_id);
  CREATE INDEX IF NOT EXISTS idx_pri_employee ON payroll_run_items(employee_id);

  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payroll_run_id UUID;
`).catch(err => console.error('[payroll] schema:', err.message));

db.query(`ALTER TYPE verification_method ADD VALUE IF NOT EXISTS 'payroll'`).catch(() => {});

// ── NIS / Tax rates per country ───────────────────────────────────────────────
const COUNTRY_RATES = {
  // SVG 2026: NIS 14% total (6.5% employee / 7.5% employer), ceiling $5,200/mo.
  // PAYE: 0% on first $26,000/yr; 10% flat on (gross − NIS employee − threshold).
  SVG: { nis_employee: 0.065, nis_employer: 0.075, monthly_nis_ceiling: 5200.00, personal_allowance: +(26000/12).toFixed(2), income_tax_rate: 0.10, nis_deductible_from_tax: true },
  BRB: { nis_employee: 0.100, nis_employer: 0.075, monthly_nis_ceiling: 4973.33, personal_allowance: 1875.00, income_tax_rate: 0.30, nis_deductible_from_tax: false },
  GRD: { nis_employee: 0.040, nis_employer: 0.050, monthly_nis_ceiling: 4166.67, personal_allowance: 1250.00, income_tax_rate: 0.30, nis_deductible_from_tax: false },
  SLU: { nis_employee: 0.050, nis_employer: 0.050, monthly_nis_ceiling: 4500.00, personal_allowance: 1250.00, income_tax_rate: 0.30, nis_deductible_from_tax: false },
};

function getRates(cc) { return COUNTRY_RATES[(cc || '').toUpperCase()] || COUNTRY_RATES.SVG; }

async function getDbRates(cc) {
  const key = (cc || 'SVG').toUpperCase();
  try {
    const { rows } = await db.query(
      `SELECT nis_employee, nis_employer, monthly_nis_ceiling, personal_allowance,
              income_tax_rate, nis_deductible_from_tax
       FROM country_payroll_rates WHERE country_code = $1`, [key]
    );
    if (rows.length) return {
      nis_employee:            +rows[0].nis_employee,
      nis_employer:            +rows[0].nis_employer,
      monthly_nis_ceiling:     +rows[0].monthly_nis_ceiling,
      personal_allowance:      +rows[0].personal_allowance,
      income_tax_rate:         +rows[0].income_tax_rate,
      nis_deductible_from_tax:  rows[0].nis_deductible_from_tax,
    };
  } catch {}
  return getRates(key);
}

function calcPayroll(grossPay, cc, customDeductions = 0, rates = null) {
  const r              = rates || getRates(cc);
  const nisBase        = Math.min(grossPay, r.monthly_nis_ceiling);
  const nis_employee   = +(nisBase * r.nis_employee).toFixed(2);
  const nis_employer   = +(nisBase * r.nis_employer).toFixed(2);
  const nisOffset      = r.nis_deductible_from_tax ? nis_employee : 0;
  const taxable        = Math.max(0, grossPay - nisOffset - r.personal_allowance);
  const income_tax     = +(taxable * r.income_tax_rate).toFixed(2);
  const other_deductions = +customDeductions.toFixed(2);
  const net_pay        = +(grossPay - nis_employee - income_tax - other_deductions).toFixed(2);
  return { nis_employee, nis_employer, income_tax, other_deductions, net_pay };
}

// ── Employee CRUD ─────────────────────────────────────────────────────────────

router.get('/employees', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, full_name, national_id, position, department,
              start_date, is_active, gross_salary, pay_frequency, standard_hours, created_at
       FROM employees WHERE provider_id = $1 ORDER BY is_active DESC, full_name`,
      [req.user.id]
    );
    res.json({ employees: rows });
  } catch (err) { next(err); }
});

router.post('/employees', requireAuth, async (req, res, next) => {
  try {
    const { full_name, national_id, position, department, start_date, gross_salary, pay_frequency, standard_hours } = req.body;
    if (!full_name) return res.status(400).json({ error: 'full_name is required' });
    if (!gross_salary || isNaN(+gross_salary)) return res.status(400).json({ error: 'gross_salary is required' });
    const { rows } = await db.query(
      `INSERT INTO employees (provider_id, full_name, national_id, position, department, start_date, gross_salary, pay_frequency, standard_hours)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.id, full_name.trim(), national_id || null, position || null, department || null,
       start_date || null, +gross_salary, pay_frequency || 'monthly',
       standard_hours !== undefined && standard_hours !== '' ? +standard_hours : null]
    );
    res.status(201).json({ employee: rows[0] });
  } catch (err) { next(err); }
});

router.put('/employees/:id', requireAuth, async (req, res, next) => {
  try {
    const { full_name, national_id, position, department, start_date, gross_salary, pay_frequency, standard_hours, is_active } = req.body;
    const { rows } = await db.query(
      `UPDATE employees SET
         full_name        = COALESCE($1, full_name),
         national_id      = COALESCE($2, national_id),
         position         = COALESCE($3, position),
         department       = COALESCE($4, department),
         start_date       = COALESCE($5, start_date),
         gross_salary     = COALESCE($6, gross_salary),
         pay_frequency    = COALESCE($7, pay_frequency),
         standard_hours   = COALESCE($8, standard_hours),
         is_active        = COALESCE($9, is_active),
         updated_at       = NOW()
       WHERE id = $10 AND provider_id = $11 RETURNING *`,
      [
        full_name || null, national_id || null, position || null, department || null, start_date || null,
        gross_salary !== undefined ? +gross_salary : null,
        pay_frequency || null,
        standard_hours !== undefined && standard_hours !== '' ? +standard_hours : null,
        is_active !== undefined ? is_active : null,
        req.params.id, req.user.id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    res.json({ employee: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/employees/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE employees SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND provider_id = $2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Preview (dry-run, no writes) ──────────────────────────────────────────────
router.post('/preview', requireAuth, async (req, res, next) => {
  try {
    const cc = req.countryCode || 'SVG';
    const { rows: employees } = await db.query(
      `SELECT id, full_name, national_id, position, gross_salary, pay_frequency, standard_hours
       FROM employees WHERE provider_id = $1 AND is_active = true ORDER BY full_name`,
      [req.user.id]
    );
    if (!employees.length) return res.status(400).json({ error: 'No active employees' });

    const { overrides = {} } = req.body;
    const rates = await getDbRates(cc);
    const items = employees.map(e => {
      const ov       = overrides[e.id] || {};
      const grossPay = +(ov.gross_pay !== undefined ? ov.gross_pay : e.gross_salary);
      const custom   = +(ov.other_deductions || 0);
      return { ...e, gross_pay: grossPay, ...calcPayroll(grossPay, cc, custom, rates) };
    });

    const totals = items.reduce((a, i) => ({
      total_gross:         +(a.total_gross         + i.gross_pay).toFixed(2),
      total_nis_employee:  +(a.total_nis_employee  + i.nis_employee).toFixed(2),
      total_nis_employer:  +(a.total_nis_employer  + i.nis_employer).toFixed(2),
      total_income_tax:    +(a.total_income_tax    + i.income_tax).toFixed(2),
      total_other_deductions: +(a.total_other_deductions + i.other_deductions).toFixed(2),
      total_net:           +(a.total_net           + i.net_pay).toFixed(2),
    }), { total_gross:0, total_nis_employee:0, total_nis_employer:0, total_income_tax:0, total_other_deductions:0, total_net:0 });

    res.json({ items, totals, rates, country_code: cc });
  } catch (err) { next(err); }
});

// ── Run Payroll ───────────────────────────────────────────────────────────────
router.post('/run', requireAuth, async (req, res, next) => {
  try {
    const providerId = req.user.id;
    const cc = req.countryCode || 'SVG';
    const { period_start, period_end, pay_date, notes, overrides = {} } = req.body;
    if (!period_start || !period_end || !pay_date)
      return res.status(400).json({ error: 'period_start, period_end, and pay_date are required' });

    const { rows: employees } = await db.query(
      `SELECT id, full_name, national_id, position, gross_salary, pay_frequency, standard_hours
       FROM employees WHERE provider_id = $1 AND is_active = true ORDER BY full_name`,
      [providerId]
    );
    if (!employees.length) return res.status(400).json({ error: 'No active employees to pay' });

    const rates = await getDbRates(cc);
    const items = employees.map(e => {
      const ov       = overrides[e.id] || {};
      const grossPay = +(ov.gross_pay !== undefined ? ov.gross_pay : e.gross_salary);
      const custom   = +(ov.other_deductions || 0);
      return { employee: e, gross_pay: grossPay, ...calcPayroll(grossPay, cc, custom, rates) };
    });

    const totals = items.reduce((a, i) => ({
      total_gross:         +(a.total_gross         + i.gross_pay).toFixed(2),
      total_nis_employee:  +(a.total_nis_employee  + i.nis_employee).toFixed(2),
      total_nis_employer:  +(a.total_nis_employer  + i.nis_employer).toFixed(2),
      total_income_tax:    +(a.total_income_tax    + i.income_tax).toFixed(2),
      total_other_deductions: +(a.total_other_deductions + i.other_deductions).toFixed(2),
      total_net:           +(a.total_net           + i.net_pay).toFixed(2),
    }), { total_gross:0, total_nis_employee:0, total_nis_employer:0, total_income_tax:0, total_other_deductions:0, total_net:0 });

    const periodLabel = new Date(period_start).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    const { rows: [run] } = await db.query(
      `INSERT INTO payroll_runs
         (provider_id, period_label, period_start, period_end, pay_date, notes,
          total_gross, total_nis_employee, total_nis_employer, total_income_tax,
          total_other_deductions, total_net, employee_count, country_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [providerId, periodLabel, period_start, period_end, pay_date, notes || null,
       totals.total_gross, totals.total_nis_employee, totals.total_nis_employer,
       totals.total_income_tax, totals.total_other_deductions, totals.total_net,
       employees.length, cc]
    );

    // Insert per-employee items + ledger transactions
    const runItems = [];
    for (const item of items) {
      const { rows: [tx] } = await db.query(
        `INSERT INTO transactions
           (provider_id, amount, job_notes, guest_customer_name, source,
            is_verified, verification_method, country_code, payroll_run_id)
         VALUES ($1,$2,$3,$4,'payroll',true,'payroll',$5,$6) RETURNING id`,
        [providerId, item.net_pay,
         `Payroll – ${item.employee.full_name}${item.employee.position ? ` (${item.employee.position})` : ''} – ${periodLabel}`,
         item.employee.full_name, cc, run.id]
      );

      const { rows: [pri] } = await db.query(
        `INSERT INTO payroll_run_items
           (payroll_run_id, employee_id, provider_id, employee_name, national_id,
            position, gross_pay, nis_employee, nis_employer, income_tax,
            other_deductions, net_pay, transaction_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [run.id, item.employee.id, providerId,
         item.employee.full_name, item.employee.national_id || null,
         item.employee.position || null,
         item.gross_pay, item.nis_employee, item.nis_employer,
         item.income_tax, item.other_deductions, item.net_pay, tx.id]
      );
      runItems.push(pri);
    }

    // Single transaction for total statutory liability (employer NIS + income taxes)
    const totalStatutory = +(totals.total_nis_employer + totals.total_income_tax).toFixed(2);
    if (totalStatutory > 0) {
      await db.query(
        `INSERT INTO transactions
           (provider_id, amount, job_notes, source, is_verified, verification_method, country_code, payroll_run_id)
         VALUES ($1,$2,$3,'payroll',true,'payroll',$4,$5)`,
        [providerId, totalStatutory,
         `Statutory Liability – Employer NIS & Income Tax – ${periodLabel}`, cc, run.id]
      );
    }

    await db.query(
      `UPDATE users SET verified_transaction_count = COALESCE(verified_transaction_count,0) + $1 WHERE id = $2`,
      [employees.length, providerId]
    );

    // Push to My Documents
    await db.query(
      `INSERT INTO provider_documents (user_id, type, label, download_url, meta)
       VALUES ($1, 'statutory_report', $2, $3, $4)`,
      [providerId,
       `Payroll Report – ${periodLabel}`,
       `/api/v1/payroll/report/${run.id}/pdf`,
       JSON.stringify({ run_id: run.id, period: periodLabel, employee_count: employees.length })]
    ).catch(() => {});

    res.status(201).json({
      run, items: runItems, totals,
      message: `Payroll processed for ${employees.length} employee${employees.length !== 1 ? 's' : ''}`,
    });
  } catch (err) { next(err); }
});

// ── List Runs ─────────────────────────────────────────────────────────────────
router.get('/runs', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, period_label, period_start, period_end, pay_date, status,
              total_gross, total_nis_employee, total_nis_employer, total_income_tax,
              total_net, employee_count, country_code, created_at
       FROM payroll_runs WHERE provider_id = $1 ORDER BY period_start DESC`,
      [req.user.id]
    );
    res.json({ runs: rows });
  } catch (err) { next(err); }
});

// ── Run Detail ────────────────────────────────────────────────────────────────
router.get('/runs/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows: [run] } = await db.query(
      `SELECT * FROM payroll_runs WHERE id = $1 AND provider_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const { rows: items } = await db.query(
      `SELECT * FROM payroll_run_items WHERE payroll_run_id = $1 ORDER BY employee_name`,
      [run.id]
    );
    res.json({ run, items });
  } catch (err) { next(err); }
});

// ── Cancel Run ────────────────────────────────────────────────────────────────
router.patch('/runs/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const { rows: [run] } = await db.query(
      `UPDATE payroll_runs SET status = 'cancelled', cancelled_at = NOW()
       WHERE id = $1 AND provider_id = $2 AND status != 'cancelled' RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!run) return res.status(404).json({ error: 'Run not found or already cancelled' });
    res.json({ run });
  } catch (err) { next(err); }
});

// ── Statutory Report: CSV ─────────────────────────────────────────────────────
router.get('/report/:run_id/csv', requireAuth, async (req, res, next) => {
  try {
    const { rows: [run] } = await db.query(
      `SELECT pr.*, u.full_name AS provider_name
       FROM payroll_runs pr JOIN users u ON u.id = pr.provider_id
       WHERE pr.id = $1 AND pr.provider_id = $2`,
      [req.params.run_id, req.user.id]
    );
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const { rows: items } = await db.query(
      `SELECT * FROM payroll_run_items WHERE payroll_run_id = $1 ORDER BY employee_name`,
      [run.id]
    );
    const r = await getDbRates(run.country_code);
    const employer = run.provider_name;
    const period   = run.period_label || `${run.period_start} to ${run.period_end}`;

    const hdr = [
      'Employee Name','National ID','Position',
      `Gross Pay`,`NIS Employee (${(r.nis_employee*100).toFixed(1)}%)`,
      `NIS Employer (${(r.nis_employer*100).toFixed(1)}%)`,
      `Income Tax (${(r.income_tax_rate*100).toFixed(0)}%)`,'Other Deductions','Net Pay',
    ].join(',');

    const dataRows = items.map(i => [
      `"${(i.employee_name||'').replace(/"/g,'""')}"`,
      `"${(i.national_id||'').replace(/"/g,'""')}"`,
      `"${(i.position||'').replace(/"/g,'""')}"`,
      (+i.gross_pay).toFixed(2),
      (+i.nis_employee).toFixed(2),
      (+i.nis_employer).toFixed(2),
      (+i.income_tax).toFixed(2),
      (+i.other_deductions).toFixed(2),
      (+i.net_pay).toFixed(2),
    ].join(','));

    const totalRow = [
      '"TOTALS"','','',
      (+run.total_gross).toFixed(2),
      (+run.total_nis_employee).toFixed(2),
      (+run.total_nis_employer).toFixed(2),
      (+run.total_income_tax).toFixed(2),
      (+run.total_other_deductions).toFixed(2),
      (+run.total_net).toFixed(2),
    ].join(',');

    const totalNis   = +(+run.total_nis_employee + +run.total_nis_employer).toFixed(2);
    const totalStatutory = +(totalNis + +run.total_income_tax).toFixed(2);

    const summary = [
      '', `"Employer","${employer}"`, `"Period","${period}"`,
      `"Pay Date","${run.pay_date}"`, `"Employees","${run.employee_count}"`, '',
      `"Total NIS Remittance Due (Employee + Employer)","${totalNis.toFixed(2)}"`,
      `"Total Income Tax Due","${(+run.total_income_tax).toFixed(2)}"`,
      `"TOTAL STATUTORY REMITTANCE DUE","${totalStatutory.toFixed(2)}"`,
    ];

    const csv = [hdr, ...dataRows, totalRow, ...summary].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="statutory-${run.id.slice(0,8)}.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});

// ── Statutory Report: PDF ─────────────────────────────────────────────────────
router.get('/report/:run_id/pdf', requireAuth, async (req, res, next) => {
  try {
    const { rows: [run] } = await db.query(
      `SELECT pr.*, u.full_name AS provider_name, u.email
       FROM payroll_runs pr JOIN users u ON u.id = pr.provider_id
       WHERE pr.id = $1 AND pr.provider_id = $2`,
      [req.params.run_id, req.user.id]
    );
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const { rows: items } = await db.query(
      `SELECT * FROM payroll_run_items WHERE payroll_run_id = $1 ORDER BY employee_name`,
      [run.id]
    );
    const { generateStatutoryPdf } = require('../services/payrollPdf');
    const rates = await getDbRates(run.country_code);
    const { verifyUrl: payrollVerifyUrl } = await signDocument({
      docType: 'payroll_report', docRef: run.id, providerId: run.provider_id,
      countryCode: run.country_code,
      metadata: { issued_by: run.provider_name, period: run.period_label || `${run.period_start} — ${run.period_end}`, employee_count: run.employee_count },
    });
    const buf = await generateStatutoryPdf(run, items, rates, payrollVerifyUrl);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="statutory-${run.id.slice(0,8)}.pdf"`);
    res.send(buf);
  } catch (err) { next(err); }
});

// ── Pay Slip: single employee PDF ────────────────────────────────────────────
router.get('/report/:run_id/payslip/:employee_id', requireAuth, async (req, res, next) => {
  try {
    const { rows: [run] } = await db.query(
      `SELECT pr.*, u.full_name AS provider_name
       FROM payroll_runs pr JOIN users u ON u.id = pr.provider_id
       WHERE pr.id = $1 AND pr.provider_id = $2`,
      [req.params.run_id, req.user.id]
    );
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const { rows: [item] } = await db.query(
      `SELECT * FROM payroll_run_items WHERE payroll_run_id = $1 AND employee_id = $2`,
      [run.id, req.params.employee_id]
    );
    if (!item) return res.status(404).json({ error: 'Employee not found in this run' });

    const rates = await getDbRates(run.country_code);
    const { verifyUrl: payslipVerifyUrl } = await signDocument({
      docType: 'payslip', docRef: `${run.id}-${item.employee_id}`, providerId: run.provider_id,
      countryCode: run.country_code,
      metadata: { issued_by: run.provider_name, issued_to: item.employee_name, period: run.period_label || `${run.period_start} — ${run.period_end}`, amount: item.net_pay, currency: 'XCD' },
    });
    const { generatePayslip } = require('../services/payslipPdf');
    const buf = await generatePayslip(run, item, rates, run.provider_name, payslipVerifyUrl);

    const safeName = (item.employee_name || 'employee').toLowerCase().replace(/[^a-z0-9]/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payslip-${safeName}-${run.id.slice(0,8)}.pdf"`);
    res.send(buf);
  } catch (err) { next(err); }
});

// ── Admin: List Payroll Rates ─────────────────────────────────────────────────
router.get('/rates', requireAuth, ...requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT country_code, nis_employee, nis_employer, monthly_nis_ceiling,
              personal_allowance, income_tax_rate, nis_deductible_from_tax,
              notes, updated_by_email, updated_at
       FROM country_payroll_rates ORDER BY country_code`
    );
    // Merge DB rows with hardcoded defaults so all known countries appear
    const dbMap = Object.fromEntries(rows.map(r => [r.country_code, r]));
    const result = Object.entries(COUNTRY_RATES).map(([cc, defaults]) => ({
      country_code: cc,
      nis_employee:            +(dbMap[cc]?.nis_employee ?? defaults.nis_employee),
      nis_employer:            +(dbMap[cc]?.nis_employer ?? defaults.nis_employer),
      monthly_nis_ceiling:     +(dbMap[cc]?.monthly_nis_ceiling ?? defaults.monthly_nis_ceiling),
      personal_allowance:      +(dbMap[cc]?.personal_allowance ?? defaults.personal_allowance),
      income_tax_rate:         +(dbMap[cc]?.income_tax_rate ?? defaults.income_tax_rate),
      nis_deductible_from_tax:  dbMap[cc] ? dbMap[cc].nis_deductible_from_tax : defaults.nis_deductible_from_tax,
      notes:                    dbMap[cc]?.notes || null,
      updated_by_email:         dbMap[cc]?.updated_by_email || null,
      updated_at:               dbMap[cc]?.updated_at || null,
      source:                   dbMap[cc] ? 'database' : 'default',
    }));
    res.json({ rates: result });
  } catch (err) { next(err); }
});

// ── Admin: Upsert Payroll Rates ───────────────────────────────────────────────
router.put('/rates/:cc', requireAuth, ...requireRole('admin'), async (req, res, next) => {
  try {
    const cc = req.params.cc.toUpperCase();
    const {
      nis_employee, nis_employer, monthly_nis_ceiling,
      personal_allowance, income_tax_rate, nis_deductible_from_tax, notes,
    } = req.body;
    if ([nis_employee, nis_employer, monthly_nis_ceiling, personal_allowance, income_tax_rate]
        .some(v => v === undefined || v === null || isNaN(+v)))
      return res.status(400).json({ error: 'All numeric rate fields are required' });

    const { rows: [rate] } = await db.query(
      `INSERT INTO country_payroll_rates
         (country_code, nis_employee, nis_employer, monthly_nis_ceiling,
          personal_allowance, income_tax_rate, nis_deductible_from_tax, notes,
          updated_by_email, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (country_code) DO UPDATE SET
         nis_employee            = EXCLUDED.nis_employee,
         nis_employer            = EXCLUDED.nis_employer,
         monthly_nis_ceiling     = EXCLUDED.monthly_nis_ceiling,
         personal_allowance      = EXCLUDED.personal_allowance,
         income_tax_rate         = EXCLUDED.income_tax_rate,
         nis_deductible_from_tax = EXCLUDED.nis_deductible_from_tax,
         notes                   = EXCLUDED.notes,
         updated_by_email        = EXCLUDED.updated_by_email,
         updated_at              = NOW()
       RETURNING *`,
      [cc, +nis_employee, +nis_employer, +monthly_nis_ceiling,
       +personal_allowance, +income_tax_rate,
       nis_deductible_from_tax === true || nis_deductible_from_tax === 'true',
       notes || null, req.user.email]
    );
    res.json({ rate });
  } catch (err) { next(err); }
});

module.exports = router;
