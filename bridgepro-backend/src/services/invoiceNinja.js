const https = require('https');
const http = require('http');

const BASE_URL = process.env.INVOICE_NINJA_URL;
const API_KEY = process.env.INVOICE_NINJA_API_KEY;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/v1${path}`, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'X-Api-Token': API_KEY,
        'Content-Type': 'application/json',
      },
    };

    const req = (isHttps ? https : http).request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function findOrCreateClient(email, name) {
  const searchRes = await request('GET', `/clients?filter=${encodeURIComponent(email)}`);
  if (searchRes.status < 400 && searchRes.body?.data?.length > 0) {
    return searchRes.body.data[0].id;
  }

  const createRes = await request('POST', '/clients', {
    name,
    contacts: [{ email }],
  });
  if (createRes.status >= 400) {
    throw new Error(`Invoice Ninja client creation failed: ${JSON.stringify(createRes.body)}`);
  }
  return createRes.body.data.id;
}

function buildBrandingHtml(providerName, logoUrl) {
  const logo = logoUrl
    ? `<img src="${logoUrl}" style="max-height:48px;max-width:140px;object-fit:contain;display:block;margin-bottom:4px">`
    : '';
  return `<table width="100%" style="border-top:1px solid #e8e8e8;margin-top:20px;padding-top:12px;font-family:sans-serif">
  <tr>
    <td style="vertical-align:bottom">${logo}<span style="font-size:11px;color:#555">${providerName}</span></td>
    <td style="text-align:right;vertical-align:bottom">
      <span style="font-size:9px;color:#bbb;line-height:1.5">
        Powered by <strong style="color:#009E60">BridgePro</strong><br>
        A3Tech &middot; Logetek
      </span>
    </td>
  </tr>
</table>`;
}

async function createInvoice({ clientEmail, clientName, amount, description, providerName, logoUrl, jobHours, jobTasks, jobNotes }) {
  const clientId = await findOrCreateClient(clientEmail, clientName);

  const publicNotes = buildBrandingHtml(providerName || clientName, logoUrl || null);

  // Build line items: main service + hours (if logged) + tasks (if any)
  const lineItems = [];

  if (jobHours) {
    const hourlyRate = jobHours > 0 && amount ? parseFloat((amount / jobHours).toFixed(2)) : 0;
    lineItems.push({
      product_key: 'Labour',
      notes: `Hours worked${jobNotes ? ': ' + jobNotes : ''}`,
      cost: hourlyRate,
      qty: jobHours,
    });
  } else {
    lineItems.push({
      product_key: 'Service',
      notes: description || '',
      cost: amount || 0,
      qty: 1,
    });
  }

  if (Array.isArray(jobTasks) && jobTasks.length > 0) {
    const taskList = jobTasks.map((t) => `${t.done ? '✓' : '○'} ${t.text}`).join('\n');
    lineItems.push({
      product_key: 'Tasks',
      notes: taskList,
      cost: 0,
      qty: 1,
    });
  }

  // Create invoice
  const invoiceRes = await request('POST', '/invoices', {
    client_id: clientId,
    line_items: lineItems,
    public_notes: publicNotes,
    auto_bill_enabled: false,
  });

  if (invoiceRes.status >= 400) {
    throw new Error(`Invoice Ninja invoice creation failed: ${JSON.stringify(invoiceRes.body)}`);
  }

  const invoice = invoiceRes.body.data;
  return {
    invoice_ninja_id: invoice.id,
    invoice_url: invoice.invitations?.[0]?.link || null,
  };
}

async function getInvoiceStatus(invoiceNinjaId) {
  const res = await request('GET', `/invoices/${invoiceNinjaId}`);
  if (res.status >= 400) {
    throw new Error(`Invoice Ninja fetch failed: ${JSON.stringify(res.body)}`);
  }
  // status_id: 1=draft, 2=sent, 3=partial, 4=paid, 5=cancelled, 6=reversed
  return {
    status_id: res.body.data.status_id,
    paid: res.body.data.status_id === 4,
    amount_paid: res.body.data.amount_paid || 0,
  };
}

async function downloadInvoicePdf(invoiceNinjaId) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/v1/invoices/${invoiceNinjaId}/download`, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'GET',
      headers: { 'X-Api-Token': API_KEY },
    };
    const chunks = [];
    const req = (isHttps ? https : http).request(options, (res) => {
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Invoice Ninja PDF download failed: ${res.statusCode}`));
        resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'application/pdf' });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { createInvoice, getInvoiceStatus, downloadInvoicePdf };
