const nodemailer = require('nodemailer');

const APP_NAME = process.env.APP_NAME || 'BridgePro';
const APP_URL  = process.env.APP_URL  || 'https://bridgepro.a3tech.uk';
const FROM     = process.env.SMTP_FROM || process.env.SMTP_USER || `noreply@bridgepro.app`;

function makeTransporter() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendEmail({ to, subject, html, replyTo, fromName }) {
  const transporter = makeTransporter();
  if (!transporter) {
    console.log(`[EMAIL SKIPPED — no SMTP config] To: ${to} | Subject: ${subject}`);
    return;
  }
  try {
    const fromLabel = fromName ? `"${fromName}" <${FROM}>` : `"${APP_NAME}" <${FROM}>`;
    const mail = { from: fromLabel, to, subject, html };
    if (replyTo) mail.replyTo = replyTo;
    await transporter.sendMail(mail);
  } catch (err) {
    console.error(`[EMAIL ERROR] To: ${to} | ${err.message}`);
  }
}

function wrap(body) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f4f4f4;margin:0;padding:24px">
    <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
      <div style="background:#009E60;padding:20px 24px">
        <div style="color:#fff;font-size:1.2rem;font-weight:700">${APP_NAME}</div>
      </div>
      <div style="padding:24px">${body}</div>
      <div style="padding:16px 24px;background:#f9f9f9;font-size:0.75rem;color:#999;border-top:1px solid #eee">
        &copy; ${new Date().getFullYear()} ${APP_NAME}. This is an automated message — please do not reply.
      </div>
    </div>
  </body></html>`;
}

// ── Emails ───────────────────────────────────────────────────────────────────

async function sendPasswordReset(to, name, token) {
  const link = `${APP_URL}/#/reset-password?token=${token}`;
  await sendEmail({
    to,
    subject: `Reset your ${APP_NAME} password`,
    html: wrap(`
      <p>Hi ${name},</p>
      <p>We received a request to reset your password. Click the button below — this link expires in <strong>1 hour</strong>.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${link}" style="background:#009E60;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem">Reset Password</a>
      </div>
      <p style="font-size:0.85rem;color:#666">If you didn't request this, you can safely ignore this email.</p>
    `),
  });
}

async function sendVerificationResult(to, name, approved, reason) {
  await sendEmail({
    to,
    subject: approved ? `Your ${APP_NAME} ID has been verified ✅` : `${APP_NAME} ID verification update`,
    html: wrap(approved
      ? `<p>Hi ${name},</p><p>Great news — your identity has been <strong style="color:#2e7d32">verified</strong>! Your listing now shows a Verified badge and you can earn Bridge Points from transactions.</p><p><a href="${APP_URL}/#/dashboard" style="color:#009E60;font-weight:700">Go to your dashboard →</a></p>`
      : `<p>Hi ${name},</p><p>Unfortunately we were unable to verify your ID at this time.</p>${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}<p>Please <a href="${APP_URL}/#/verify" style="color:#009E60;font-weight:700">re-submit your ID</a> with a clear, valid government-issued document.</p>`
    ),
  });
}

async function sendSuspensionNotice(to, name, reason) {
  await sendEmail({
    to,
    subject: `Your ${APP_NAME} account has been suspended`,
    html: wrap(`
      <p>Hi ${name},</p>
      <p>Your account has been <strong style="color:#c62828">suspended</strong>.</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
      <p>If you believe this is an error, please contact our support team to appeal.</p>
    `),
  });
}

async function sendWelcome(to, name) {
  await sendEmail({
    to,
    subject: `Welcome to ${APP_NAME}!`,
    html: wrap(`
      <p>Hi ${name},</p>
      <p>Welcome to <strong>${APP_NAME}</strong> — the Caribbean's trusted service marketplace.</p>
      <ul style="line-height:1.9">
        <li>Browse and hire verified local service providers</li>
        <li>Earn Bridge Points on every transaction</li>
        <li>Verify your identity to unlock full features</li>
      </ul>
      <div style="text-align:center;margin:24px 0">
        <a href="${APP_URL}" style="background:#009E60;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">Get Started</a>
      </div>
    `),
  });
}

async function sendVerificationEmail(to, name, token) {
  const link = `${APP_URL}/#/verify?token=${token}`;
  console.log(`[EMAIL VERIFY] ${to} → ${link}`);
  await sendEmail({
    to,
    subject: `Verify your ${APP_NAME} account`,
    html: wrap(`
      <p style="font-size:1rem">Hi ${name},</p>
      <p>Thanks for joining <strong>${APP_NAME}</strong>! Please verify your email address to confirm your account.</p>
      <p style="font-size:0.85rem;color:#666">This link expires in <strong>1 hour</strong>.</p>
      <div style="text-align:center;margin:28px 0">
        <a href="${link}" style="background:#009E60;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1.05rem;display:inline-block">Verify My Email</a>
      </div>
      <p style="font-size:0.82rem;color:#999">If you didn't create this account, ignore this email — no action is needed.</p>
    `),
  });
}

async function sendAdminNewUserNotification(user) {
  const adminEmail = 'emulasalexander@gmail.com';
  await sendEmail({
    to: adminEmail,
    subject: `[${APP_NAME}] New registration — ${user.full_name}`,
    html: wrap(`
      <p><strong>New user registered on ${APP_NAME}</strong></p>
      <table style="border-collapse:collapse;width:100%;font-size:0.9rem">
        <tr><td style="padding:6px 0;color:#666;width:100px">Name</td><td style="padding:6px 0;font-weight:600">${user.full_name}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Email</td><td style="padding:6px 0">${user.email}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Role</td><td style="padding:6px 0">${user.role}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Time</td><td style="padding:6px 0">${new Date().toUTCString()}</td></tr>
      </table>
    `),
  });
}

module.exports = { sendEmail, sendPasswordReset, sendVerificationResult, sendSuspensionNotice, sendWelcome, sendVerificationEmail, sendAdminNewUserNotification };
