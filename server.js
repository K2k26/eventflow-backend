const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

const bookings = [];

app.get('/', (req, res) => {
  res.json({ status: 'Eventflow API running', version: '1.0.0' });
});

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { eventName, eventLocation, eventEmoji, price = 45 } = req.body;
    if (!eventName) return res.status(400).json({ error: 'eventName is required' });
    const ticketPrice = Math.round(price * 100);
    const serviceFee = Math.round(5 * 100);
    const totalAmount = ticketPrice + serviceFee;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount,
      currency: process.env.CURRENCY || 'gbp',
      automatic_payment_methods: { enabled: true },
      metadata: { eventName, eventLocation: eventLocation || '', eventEmoji: eventEmoji || '🎫' },
    });
    res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id, amount: totalAmount });
  } catch (err) {
    console.error('PaymentIntent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const booking = { id: pi.id, eventName: pi.metadata.eventName, amount: pi.amount, status: 'confirmed', createdAt: new Date().toISOString() };
    bookings.push(booking);
    console.log('Booking confirmed:', booking.eventName);
  }
  res.json({ received: true });
});

app.get('/bookings', (req, res) => res.json(bookings));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎫 Eventflow API running on http://localhost:${PORT}`);
  console.log(`   Stripe mode: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE 🔴' : 'TEST 🟡'}`);
  console.log(`   Webhook secret: ${process.env.STRIPE_WEBHOOK_SECRET ? 'set ✓' : 'not set ⚠️'}\n`);
});
