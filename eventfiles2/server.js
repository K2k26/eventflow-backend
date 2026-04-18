const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── MIDDLEWARE ────────────────────────────────────────────────
// Webhook needs raw body — must come BEFORE express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// ── IN-MEMORY BOOKINGS STORE ──────────────────────────────────
// Replace with a real database (Supabase, Postgres, MongoDB etc.)
const bookings = [];

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Eventflow API running', version: '1.0.0' });
});

// ── CREATE PAYMENT INTENT ─────────────────────────────────────
// Called by the frontend when a user clicks "Buy tickets"
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { eventName, eventLocation, eventEmoji, price = 45 } = req.body;

    if (!eventName) {
      return res.status(400).json({ error: 'eventName is required' });
    }

    // Amount in pence/cents (Stripe uses smallest currency unit)
    const ticketPrice = Math.round(price * 100);
    const serviceFee  = Math.round(5 * 100);
    const totalAmount = ticketPrice + serviceFee;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount,
      currency: process.env.CURRENCY || 'gbp',
      automatic_payment_methods: { enabled: true },
      metadata: {
        eventName,
        eventLocation: eventLocation || '',
        eventEmoji:    eventEmoji    || '🎫',
        ticketPrice:   ticketPrice.toString(),
        serviceFee:    serviceFee.toString(),
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: totalAmount,
    });
  } catch (err) {
    console.error('PaymentIntent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE WEBHOOK ────────────────────────────────────────────
// Stripe calls this endpoint after a payment succeeds or fails.
// IMPORTANT: always fulfil orders here, not in the frontend callback —
// the frontend can be tampered with, the webhook cannot.
app.post('/webhook', async (req, res) => {
  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {

    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      const booking = {
        id:            pi.id,
        eventName:     pi.metadata.eventName,
        eventLocation: pi.metadata.eventLocation,
        eventEmoji:    pi.metadata.eventEmoji,
        amount:        pi.amount,
        currency:      pi.currency,
        status:        'confirmed',
        createdAt:     new Date().toISOString(),
      };

      // Save booking (swap this line for a real DB insert)
      bookings.push(booking);
      console.log('✅ Booking confirmed:', booking.eventName, `(${pi.id})`);

      // Send confirmation email
      await sendConfirmationEmail(booking, pi.receipt_email);
      break;
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      console.log('❌ Payment failed:', pi.id, pi.last_payment_error?.message);
      break;
    }

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

// ── GET BOOKINGS ──────────────────────────────────────────────
// Returns all bookings for a given email (replace with DB query)
app.get('/bookings', (req, res) => {
  const { email } = req.query;
  const results = email
    ? bookings.filter(b => b.email === email)
    : bookings;
  res.json(results);
});

// ── EMAIL HELPER ──────────────────────────────────────────────
async function sendConfirmationEmail(booking, toEmail) {
  if (!process.env.SMTP_HOST || !toEmail) return;

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const amount = (booking.amount / 100).toFixed(2);

  await transporter.sendMail({
    from:    `Eventflow <${process.env.SMTP_USER}>`,
    to:      toEmail,
    subject: `Booking confirmed — ${booking.eventName}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
        <h1 style="font-size:24px;font-weight:400;margin-bottom:8px;">
          ${booking.eventEmoji} You're going!
        </h1>
        <p style="color:#666;margin-bottom:24px;">Your booking is confirmed.</p>
        <div style="background:#f7f7f5;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
          <p style="font-weight:500;margin:0 0 4px;">${booking.eventName}</p>
          <p style="color:#888;font-size:14px;margin:0 0 12px;">${booking.eventLocation}</p>
          <p style="font-size:14px;color:#444;margin:0;">
            Total paid: <strong>£${amount}</strong>
          </p>
        </div>
        <p style="font-size:13px;color:#aaa;">Booking ID: ${booking.id}</p>
      </div>
    `,
  });

  console.log('📧 Confirmation email sent to', toEmail);
}

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎫 Eventflow API running on http://localhost:${PORT}`);
  console.log(`   Stripe mode: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE 🔴' : 'TEST 🟡'}`);
  console.log(`   Webhook secret: ${process.env.STRIPE_WEBHOOK_SECRET ? 'set ✓' : 'not set ⚠️'}\n`);
});
