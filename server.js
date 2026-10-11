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
  DASHBOARD_USER,
  DASHBOARD_PASSWORD
} = process.env;

// Fail fast if required server-only configuration is missing.
const requiredEnv = {
  PAYSTACK_SECRET_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
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

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const PORT = Number(process.env.PORT || 3000);
const MAX_AMOUNT_GHS = 50000;
const PAYSTACK_TIMEOUT_MS = 15000;
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'abandoned', 'reversed']);

// -----------------------------------------------------------------------------
// Security and middleware
// -----------------------------------------------------------------------------

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

app.use(helmet({ contentSecurityPolicy: true }));

// Capture the exact JSON bytes for Paystack's HMAC signature verification.
app.use(express.json({
  limit: '20kb',
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));

function constantTimeStringEqual(a, b) {
  // Hashing makes both inputs the same length before timingSafeEqual.
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

// Keep the original public dashboard directory and index route.
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
    // Log only diagnostic fields; never log keys or authorization headers.
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
  // Keep the provider codes used by the existing dashboard and Paystack API.
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

  // Never downgrade a previously verified success to pending/failed due to a
  // delayed webhook or a concurrent status poll. A later verified success is allowed.
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
// Routes (existing paths preserved)
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

    // A charge-initiation response is not proof that payment succeeded.
    return res.status(202).json({
      reference,
      status: 'pending',
      message: result.message || 'Payment request initiated. Complete any instructions from your mobile network.',
      displayText: result.data?.display_text || '',
      providerStatus
    });
  } catch (error) {
    console.error('Charge error:', error.message);
    if (error.paystackDetails) {
      console.error('Paystack response details:', JSON.stringify(error.paystackDetails, null, 2));
    }

    // Keep uncertain requests pending: a timeout/network error may occur after
    // Paystack received the request. Do not claim payment failed or succeeded.
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

app.get('/api/payment/:reference', statusLimit, async (req, res) => {
  try {
    const reference = String(req.params.reference || '');
    if (!/^NPM-[a-f0-9-]{36}$/i.test(reference)) {
      return res.status(400).json({ error: 'Invalid payment reference.' });
    }

    let payment = await getPayment(reference);
    if (!payment) return res.status(404).json({ error: 'Payment not found.' });

    // Re-verify pending and previously uncertain requests against Paystack.
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
  const reference = req.body?.data?.reference;

  // Ignore authenticated event types that this payment flow does not process.
  if (!['charge.success', 'charge.failed'].includes(event) || !reference) {
    return res.sendStatus(200);
  }

  try {
    // Acknowledge only after verification and database updates succeed. If the
    // work fails, a non-2xx response allows Paystack's webhook retry policy to help.
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
