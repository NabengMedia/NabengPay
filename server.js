'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const {
  PAYSTACK_SECRET_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  INVOICE_SUPABASE_URL,
  INVOICE_SUPABASE_SERVICE_ROLE_KEY,
  DASHBOARD_USER,
  DASHBOARD_PASSWORD
} = process.env;

// Fail fast if required server-only configuration is missing.
const requiredEnv = {
  PAYSTACK_SECRET_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  INVOICE_SUPABASE_URL,
  INVOICE_SUPABASE_SERVICE_ROLE_KEY,
  DASHBOARD_USER,
  DASHBOARD_PASSWORD
};

const missingEnv = Object.entries(requiredEnv)
  .filter(([, value]) => !String(value || '').trim())
  .map(([key]) => key);

if (missingEnv.length) {
  throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
}

if (!/^sk_(test|live)_/.test(PAYSTACK_SECRET_KEY)) {
  throw new Error('PAYSTACK_SECRET_KEY must be a Paystack secret key (sk_test_... or sk_live_...).');
}

// NabengPay (MoMo collection) database
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

// Nabeng Invoice database (separate Supabase project)
const invoiceDb = createClient(INVOICE_SUPABASE_URL, INVOICE_SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const PORT = Number(process.env.PORT || 3000);
const MAX_AMOUNT_GHS = 50000;
const PAYSTACK_TIMEOUT_MS = 25000;
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'abandoned', 'reversed']);

// -----------------------------------------------------------------------------
// Security and middleware
// -----------------------------------------------------------------------------

app.disable('x-powered-by');
app.set('trust proxy', 1); // always trust the first proxy (Render)

app.use(helmet({ contentSecurityPolicy: true }));

// Capture the exact JSON bytes for Paystack's HMAC signature verification.
app.use(express.json({
  limit: '20kb',
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));

function constantTimeStringEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

// Preserve the existing dashboard Basic Auth protection and public exceptions.
app.use((req, res, next) => {
  if (req.path === '/api/paystack-webhook' || req.path === '/api/health') {
    return next();
  }

  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!match) {
    res.set('WWW-Authenticate', 'Basic realm="Nabeng MoMo Dashboard", charset="UTF-8"');
    return res.status(401).send('Login required');
  }

  let credentials;
  try {
    credentials = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return res.sendStatus(401);
  }

  const separator = credentials.indexOf(':');
  if (separator < 0) return res.sendStatus(401);

  const username = credentials.slice(0, separator);
  const password = credentials.slice(separator + 1);
  if (
    !constantTimeStringEqual(username, DASHBOARD_USER) ||
    !constantTimeStringEqual(password, DASHBOARD_PASSWORD)
  ) {
    res.set('WWW-Authenticate', 'Basic realm="Nabeng MoMo Dashboard", charset="UTF-8"');
    return res.sendStatus(401);
  }

  return next();
});

app.use(express.static('public', { index: 'index.html', dotfiles: 'deny' }));

const chargeLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many payment attempts. Please wait and try again.' }
});

const statusLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many status checks. Please wait and try again.' }
});

// -----------------------------------------------------------------------------
// Paystack API helper
// -----------------------------------------------------------------------------

async function paystack(path, method = 'GET', body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAYSTACK_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`https://api.paystack.co${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'Paystack request timed out.'
      : 'Unable to connect to Paystack. Check the server network connection.';
    const wrapped = new Error(message);
    wrapped.isNetworkError = true;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    const error = new Error(`Paystack returned an unreadable response (HTTP ${response.status}).`);
    error.paystackDetails = { httpStatus: response.status };
    throw error;
  }

  if (!response.ok || result.status !== true) {
    const error = new Error(result.message || `Paystack request failed (HTTP ${response.status}).`);
    error.paystackDetails = {
      httpStatus: response.status,
      message: result.message || null,
      dataStatus: result.data?.status || null,
      dataMessage: result.data?.message || null,
      gatewayResponse: result.data?.gateway_response || null,
      gatewayResponseCode: result.data?.gateway_response_code || null,
      code: result.data?.code || null,
      reference: result.data?.reference || null
    };
    throw error;
  }

  return result;
}

// -----------------------------------------------------------------------------
// Validation and database helpers
// -----------------------------------------------------------------------------

function normalisePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(digits)) return digits;
  if (/^233\d{9}$/.test(digits)) return `0${digits.slice(3)}`;
  return null;
}

function normaliseProvider(input) {
  const provider = String(input || '').trim().toLowerCase();
  const aliases = {
    mtn: 'mtn',
    atl: 'atl',
    airteltigo: 'atl',
    'airtel tigo': 'atl',
    'airtel-tigo': 'atl',
    vod: 'vod',
    telecel: 'vod',
    vodafone: 'vod'
  };
  return aliases[provider] || null;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function getPayment(reference) {
  const { data, error } = await db
    .from('momo_payments')
    .select('*')
    .eq('reference', reference)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function saveStatus(reference, updates) {
  const payload = { ...updates, updated_at: new Date().toISOString() };
  let query = db.from('momo_payments').update(payload).eq('reference', reference);

  if (updates.status !== 'success') query = query.neq('status', 'success');

  const { error } = await query;
  if (error) throw error;
}

// -----------------------------------------------------------------------------
// Verify a payment directly with Paystack before changing local status.
// -----------------------------------------------------------------------------

async function verifyPayment(reference) {
  const result = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
  const transaction = result.data;
  if (!transaction || typeof transaction !== 'object') {
    throw new Error('Paystack verification response did not contain transaction data.');
  }

  const localPayment = await getPayment(reference);
  if (!localPayment) throw new Error('Unknown payment reference.');

  const detailsMatch =
    transaction.reference === localPayment.reference &&
    String(transaction.currency || '').toUpperCase() === String(localPayment.currency || '').toUpperCase() &&
    Number(transaction.amount) === Number(localPayment.amount_pesewas);

  if (transaction.status === 'success' && detailsMatch) {
    await saveStatus(reference, {
      status: 'success',
      provider_status: transaction.status,
      paid_at: transaction.paid_at || new Date().toISOString()
    });
    return 'success';
  }

  if (transaction.status === 'success' && !detailsMatch) {
    console.error('Payment verification mismatch for reference:', reference);
    await saveStatus(reference, {
      status: 'verification_mismatch',
      provider_status: transaction.status
    });
    return 'verification_mismatch';
  }

  if (TERMINAL_FAILURE_STATUSES.has(transaction.status)) {
    await saveStatus(reference, {
      status: transaction.status,
      provider_status: transaction.status
    });
    return transaction.status;
  }

  await saveStatus(reference, {
    status: 'pending',
    provider_status: transaction.status || 'pending'
  });
  return 'pending';
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/charge', chargeLimit, async (req, res) => {
  let reference;

  try {
    const email = String(req.body?.email || '').trim();
    const phone = normalisePhone(req.body?.phone);
    const provider = normaliseProvider(req.body?.provider);
    const amount = Number(req.body?.amount);

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (!phone) {
      return res.status(400).json({ error: 'Enter a valid Ghana phone number, e.g. 0241234567.' });
    }
    if (!provider) {
      return res.status(400).json({ error: 'Choose MTN, Telecel/Vodafone, or AirtelTigo where enabled.' });
    }
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_AMOUNT_GHS) {
      return res.status(400).json({ error: `Amount must be between GHS 1 and GHS ${MAX_AMOUNT_GHS.toLocaleString('en-GH')}.` });
    }

    const amountPesewas = Math.round(amount * 100);
    reference = `NPM-${crypto.randomUUID()}`;

    const { error: insertError } = await db.from('momo_payments').insert({
      reference,
      customer_email: email,
      customer_phone: phone,
      provider,
      amount_pesewas: amountPesewas,
      currency: 'GHS',
      status: 'pending'
    });
    if (insertError) throw insertError;

    const result = await paystack('/charge', 'POST', {
      email,
      amount: amountPesewas,
      currency: 'GHS',
      reference,
      mobile_money: { phone, provider }
    });

    const providerStatus = result.data?.status || 'pending';
    await saveStatus(reference, { provider_status: providerStatus });

    const needsOtp = providerStatus === 'send_otp';

    return res.status(202).json({
      reference,
      status: 'pending',
      needsOtp,
      message: result.message || 'Payment request initiated. Check your phone and complete the mobile-money authorization.',
      displayText: result.data?.display_text || '',
      providerStatus,
      nextAction: providerStatus,
      customerMessage: result.data?.display_text ||
        (needsOtp
          ? 'An OTP has been sent to the customer. Enter the code below to complete the payment.'
          : 'If no prompt appears, wait briefly and check the payment status before trying again.')
    });
  } catch (error) {
    console.error('Charge initiation failed:', {
      message: error.message,
      isNetworkError: Boolean(error.isNetworkError),
      paystackDetails: error.paystackDetails || null,
      reference: reference || null
    });

    if (reference) {
      try {
        await saveStatus(reference, {
          provider_status: error.paystackDetails
            ? `request_error_${error.paystackDetails.httpStatus || 'unknown'}`
            : 'request_error_unknown'
        });
      } catch (statusError) {
        console.error('Could not update payment status:', statusError.message);
      }
    }

    return res.status(502).json({
      error: 'Payment request could not be confirmed. Check the payment status before attempting another charge.',
      reference: reference || undefined
    });
  }
});

app.post('/api/submit-otp', chargeLimit, async (req, res) => {
  try {
    const reference = String(req.body?.reference || '').trim();
    const otp = String(req.body?.otp || '').trim();

    if (!/^NPM-[a-f0-9-]{36}$/i.test(reference)) {
      return res.status(400).json({ error: 'Invalid payment reference.' });
    }
    if (!/^\d{4,8}$/.test(otp)) {
      return res.status(400).json({ error: 'Enter a valid OTP (usually 6 digits).' });
    }

    const payment = await getPayment(reference);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found.' });
    }
    if (payment.status === 'success') {
      return res.json({
        reference,
        status: 'success',
        message: 'Payment already verified.'
      });
    }

    const result = await paystack('/charge/submit_otp', 'POST', {
      otp,
      reference
    });

    const providerStatus = result.data?.status || 'pending';
    await saveStatus(reference, { provider_status: providerStatus });

    let finalStatus = 'pending';
    try {
      finalStatus = await verifyPayment(reference);
    } catch (verificationError) {
      console.warn('Post-OTP verification is not complete yet:', verificationError.message);
    }

    return res.json({
      reference,
      status: finalStatus,
      providerStatus,
      message: result.message || 'OTP submitted.',
      displayText: result.data?.display_text || ''
    });
  } catch (error) {
    console.error('Submit OTP failed:', {
      message: error.message,
      paystackDetails: error.paystackDetails || null,
      reference: req.body?.reference || null
    });

    return res.status(502).json({
      error: error.message || 'Could not submit OTP. Check the code and try again.',
      reference: req.body?.reference || undefined
    });
  }
});

const listLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many list requests. Please wait and try again.' }
});

app.get('/api/payments', listLimit, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim().toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);

    let query = db
      .from('momo_payments')
      .select('reference, customer_email, customer_phone, provider, amount_pesewas, currency, status, created_at, paid_at, provider_status')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status && ['success', 'pending', 'failed', 'abandoned', 'reversed', 'cancelled', 'verification_mismatch'].includes(status)) {
      query = query.eq('status', status);
    }

    if (q) {
      const digits = q.replace(/\D/g, '');
      if (q.toUpperCase().startsWith('NPM-') || q.includes('-')) {
        query = query.ilike('reference', `%${q}%`);
      } else if (digits.length >= 4 && digits.length === q.replace(/\s/g, '').length) {
        query = query.ilike('customer_phone', `%${digits}%`);
      } else if (q.includes('@')) {
        query = query.ilike('customer_email', `%${q}%`);
      } else {
        query = query.or(`reference.ilike.%${q}%,customer_phone.ilike.%${q}%,customer_email.ilike.%${q}%`);
      }
    }

    const { data, error } = await query;
    if (error) throw error;

    const payments = (data || []).map((row) => ({
      reference: row.reference,
      email: row.customer_email,
      phone: row.customer_phone,
      provider: row.provider,
      amount_pesewas: row.amount_pesewas,
      amount: (Number(row.amount_pesewas) / 100).toFixed(2),
      currency: row.currency || 'GHS',
      status: row.status,
      created_at: row.created_at,
      paid_at: row.paid_at || null,
      provider_status: row.provider_status || null
    }));

    return res.json({ payments, count: payments.length });
  } catch (error) {
    console.error('List payments error:', error.message);
    return res.status(500).json({ error: 'Unable to load payment history right now.' });
  }
});

app.get('/api/stats/today', listLimit, async (req, res) => {
  try {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const startIso = start.toISOString();

    const { data, error } = await db
      .from('momo_payments')
      .select('status, amount_pesewas')
      .gte('created_at', startIso);

    if (error) throw error;

    const rows = data || [];
    let successCount = 0;
    let pendingCount = 0;
    let failedCount = 0;
    let successPesewas = 0;
    let pendingPesewas = 0;

    for (const row of rows) {
      const status = String(row.status || '').toLowerCase();
      const amount = Number(row.amount_pesewas) || 0;
      if (status === 'success') {
        successCount += 1;
        successPesewas += amount;
      } else if (status === 'pending' || status === 'verification_mismatch') {
        pendingCount += 1;
        pendingPesewas += amount;
      } else {
        failedCount += 1;
      }
    }

    return res.json({
      date: startIso.slice(0, 10),
      totalRequests: rows.length,
      successCount,
      pendingCount,
      failedCount,
      successAmount: (successPesewas / 100).toFixed(2),
      pendingAmount: (pendingPesewas / 100).toFixed(2),
      currency: 'GHS'
    });
  } catch (error) {
    console.error('Today stats error:', error.message);
    return res.status(500).json({ error: 'Unable to load today\'s totals right now.' });
  }
});

app.get('/api/payment/:reference', statusLimit, async (req, res) => {
  try {
    const reference = String(req.params.reference || '');
    if (!/^NPM-[a-f0-9-]{36}$/i.test(reference)) {
      return res.status(400).json({ error: 'Invalid payment reference.' });
    }

    let payment = await getPayment(reference);
    if (!payment) return res.status(404).json({ error: 'Payment not found.' });

    if (payment.status === 'pending' || payment.status === 'verification_mismatch') {
      try {
        await verifyPayment(reference);
      } catch (verificationError) {
        console.warn('Payment verification is not complete:', verificationError.message);
      }
    }

    payment = await getPayment(reference);
    if (!payment) return res.status(404).json({ error: 'Payment not found.' });

    return res.json({
      reference: payment.reference,
      amount_pesewas: payment.amount_pesewas,
      currency: payment.currency,
      status: payment.status,
      created_at: payment.created_at,
      amount: (Number(payment.amount_pesewas) / 100).toFixed(2)
    });
  } catch (error) {
    console.error('Status error:', error.message);
    return res.status(500).json({ error: 'Unable to check payment status right now.' });
  }
});

// -----------------------------------------------------------------------------
// Paystack webhook – MoMo collection + Nabeng Invoice subscriptions
// -----------------------------------------------------------------------------
app.post('/api/paystack-webhook', async (req, res) => {
  const signature = req.get('x-paystack-signature') || '';
  if (!signature || !req.rawBody || !/^[a-f0-9]{128}$/i.test(signature)) {
    return res.sendStatus(401);
  }

  const expected = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(req.rawBody)
    .digest('hex');

  const receivedBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    return res.sendStatus(401);
  }

  const event = req.body?.event;
  const data = req.body?.data || {};
  const reference = data.reference;
  const metadata = data.metadata || {};
  const amount = Number(data.amount) || 0;

  console.log('Paystack webhook received:', {
    event,
    reference,
    amount,
    metadata
  });

  if (!['charge.success', 'charge.failed'].includes(event) || !reference) {
    return res.sendStatus(200);
  }

  try {
    // Detect Invoice subscription
    const isInvoiceByProduct =
      event === 'charge.success' &&
      metadata.product === 'nabeng_invoice_subscription';

    const isInvoiceByAmount =
      event === 'charge.success' &&
      (amount === 3000 || amount === 31000);

    let isInvoicePayment = isInvoiceByProduct;

    if (!isInvoicePayment && isInvoiceByAmount) {
      const existingMomo = await getPayment(String(reference)).catch(() => null);
      if (!existingMomo) {
        isInvoicePayment = true;
      }
    }

    if (isInvoicePayment) {
      const userId = metadata.user_id;
      const plan =
        metadata.plan === 'yearly' || amount === 31000 ? 'yearly' : 'monthly';

      if (!userId) {
        console.error('Invoice subscription missing user_id', { reference, metadata });
        return res.sendStatus(400);
      }

      const expectedAmount = plan === 'yearly' ? 31000 : 3000;
      if (amount < expectedAmount) {
        console.error('Invoice subscription amount too low', {
          reference,
          amount,
          expectedAmount
        });
        return res.sendStatus(400);
      }

      const days = plan === 'yearly' ? 365 : 30;
      const endsAt = new Date();
      endsAt.setDate(endsAt.getDate() + days);

      // Write to the Invoice Supabase project
      const { error } = await invoiceDb
        .from('invoice_profiles')
        .update({
          subscription_status: 'active',
          subscription_plan: plan,
          subscription_ends_at: endsAt.toISOString(),
          last_payment_ref: reference,
          last_payment_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId);

      if (error) {
        console.error('Failed to unlock Nabeng Invoice subscription:', error.message);
        return res.sendStatus(500);
      }

      console.log(`Nabeng Invoice unlocked for user ${userId} (${plan}) – ref ${reference}`);
      return res.sendStatus(200);
    }

    // Normal NabengPay MoMo collection
    await verifyPayment(String(reference));
    return res.sendStatus(200);
  } catch (error) {
    console.error('Webhook processing failed:', error.message);
    return res.sendStatus(500);
  }
});

// -----------------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------------

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON request body.' });
  }

  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }

  console.error('Unhandled server error:', error.message);
  return res.status(500).json({ error: 'An unexpected server error occurred.' });
});

app.listen(PORT, () => {
  console.log(`Nabeng MoMo system listening on port ${PORT}`);
});