/**
 * MERCADO — Backend
 * Node.js + Express
 *
 * Single Render service:
 *   public/index.html -> frontend
 *   server.js         -> API
 *
 * Payment gateway: GatePay.to
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'subscribers.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const VIEWS_FILE = path.join(DATA_DIR, 'product-views.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const AI_LOG_FILE = path.join(DATA_DIR, 'ai-log.json');

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('readJSON:', file, e.message);
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function ensureJSON(file, fallback) {
  if (!fs.existsSync(file)) writeJSON(file, fallback);
}

ensureJSON(SUBSCRIBERS_FILE, []);
ensureJSON(PRODUCTS_FILE, []);
ensureJSON(REVIEWS_FILE, []);
ensureJSON(VIEWS_FILE, []);
ensureJSON(ORDERS_FILE, []);
ensureJSON(AI_LOG_FILE, []);

function cleanString(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeEmail(value) {
  return cleanString(value, 320).toLowerCase();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

function nowISO() {
  return new Date().toISOString();
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

/* =====================================================
   HEALTH / CONFIG
===================================================== */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'MERCADO',
    time: nowISO(),
    payment: 'gatepay.to'
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    paymentMethods: ['gatepay', 'bank'],
    gatepay: Boolean(process.env.GATEPAY_WALLET_ADDRESS),
    bankTransfer: Boolean(process.env.BANK_IBAN || process.env.BANK_NAME),
    publicBaseUrl: publicBaseUrl()
  });
});

/* =====================================================
   EMAIL
===================================================== */

async function sendEmail({ to, subject, html, text }) {
  if (!isEmail(to)) throw new Error('Adresse email invalide');

  if (process.env.RESEND_API_KEY) {
    const from = process.env.RESEND_FROM || 'MERCADO <onboarding@resend.dev>';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to: [to], subject, html, text })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || 'Erreur Resend');
    return data;
  }

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    return transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html
    });
  }

  throw new Error('Aucun service email configuré');
}

function verificationStore() {
  if (!global.__MERCADO_CODES) global.__MERCADO_CODES = new Map();
  return global.__MERCADO_CODES;
}

app.post('/api/email/send', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isEmail(email)) return res.status(400).json({ error: 'Email invalide' });

    const code = String(Math.floor(1000 + Math.random() * 9000));
    verificationStore().set(email, {
      code,
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    await sendEmail({
      to: email,
      subject: 'Votre code de vérification MERCADO',
      text: `Votre code MERCADO est ${code}. Il expire dans 10 minutes.`,
      html: `<p>Votre code MERCADO est :</p><h2>${code}</h2><p>Il expire dans 10 minutes.</p>`
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('email/send:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/email/verify', (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = cleanString(req.body?.code, 20);
  const item = verificationStore().get(email);

  if (!item || item.expiresAt < Date.now() || item.code !== code) {
    return res.status(400).json({ ok: false, error: 'Code invalide ou expiré' });
  }

  verificationStore().delete(email);
  res.json({ ok: true, verified: true });
});

/* =====================================================
   ADMIN AUTH
===================================================== */

function requireAdmin(req, res, next) {
  const expected = String(process.env.ADMIN_KEY || '');
  const supplied =
    req.get('x-admin-key') ||
    req.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    '';

  if (!expected || !safeEqual(supplied, expected)) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

/* =====================================================
   GATEPAY.TO — PAYMENT CREATION
===================================================== */

app.post('/api/payment/gatepay', async (req, res) => {
  try {
    const wallet = cleanString(process.env.GATEPAY_WALLET_ADDRESS, 500);
    const base = publicBaseUrl();

    if (!wallet) {
      return res.status(500).json({
        ok: false,
        error: 'GATEPAY_WALLET_ADDRESS non configuré dans Render'
      });
    }

    if (!base) {
      return res.status(500).json({
        ok: false,
        error: 'PUBLIC_BASE_URL non configuré dans Render'
      });
    }

    const total = Number(req.body?.total);
    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ ok: false, error: 'Montant invalide' });
    }

    const orderId = cleanString(
      req.body?.orderId || `MERCADO-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      120
    );

    const callbackUrl = `${base}/api/payment/gatepay/callback`;

    const payload = {
      wallet,
      amount: total.toFixed(2),
      currency: cleanString(req.body?.currency || 'EUR', 10).toUpperCase(),
      callback_url: callbackUrl
    };

    const response = await fetch('https://api.gatepay.to/pay.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }

    if (!response.ok) {
      console.error('GatePay create error:', response.status, data);
      return res.status(502).json({
        ok: false,
        error: data?.message || data?.error || 'GatePay a refusé la création du paiement'
      });
    }

    const paymentUrl =
      data?.payment_url ||
      data?.checkout_url ||
      data?.url ||
      data?.checkout ||
      data?.payment?.url ||
      data?.data?.payment_url ||
      data?.data?.checkout_url ||
      data?.data?.url ||
      null;

    if (!paymentUrl) {
      console.error('GatePay response sans checkout URL:', data);
      return res.status(502).json({
        ok: false,
        error: 'GatePay n’a pas retourné d’URL de paiement'
      });
    }

    const orders = readJSON(ORDERS_FILE, []);
    const existing = orders.find(o => o.orderId === orderId);
    const record = {
      orderId,
      total: Number(total.toFixed(2)),
      currency: payload.currency,
      paymentMethod: 'gatepay',
      paymentStatus: existing?.paymentStatus || 'pending',
      paymentUrl,
      gatepayOrderId:
        data?.order_id || data?.id || data?.data?.order_id || data?.data?.id || null,
      callbackUrl,
      createdAt: existing?.createdAt || nowISO(),
      updatedAt: nowISO()
    };

    if (existing) {
      Object.assign(existing, record);
    } else {
      orders.push(record);
    }
    writeJSON(ORDERS_FILE, orders.slice(-2000));

    res.json({
      ok: true,
      order_id: orderId,
      payment_url: paymentUrl,
      checkout_url: paymentUrl,
      gatepay_order_id: record.gatepayOrderId
    });
  } catch (e) {
    console.error('GatePay payment error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =====================================================
   GATEPAY.TO — CALLBACK / WEBHOOK
===================================================== */

function firstValue(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      return obj[key];
    }
  }
  return null;
}

function normalizePaymentStatus(value) {
  const s = String(value || '').toLowerCase().trim();
  if (['paid', 'success', 'successful', 'completed', 'complete', 'confirmed', 'confirm'].includes(s)) return 'paid';
  if (['failed', 'failure', 'cancelled', 'canceled', 'expired', 'declined'].includes(s)) return 'failed';
  if (['pending', 'processing', 'waiting', 'unpaid'].includes(s)) return 'pending';
  return null;
}

app.all('/api/payment/gatepay/callback', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const query = req.query && typeof req.query === 'object' ? req.query : {};
    const data = { ...query, ...body };

    console.log('GatePay callback:', JSON.stringify(data));

    const orderId = firstValue(data, [
      'order_id', 'orderId', 'merchant_order_id', 'merchantOrderId', 'reference', 'invoice_id', 'invoiceId'
    ]);
    const status = normalizePaymentStatus(firstValue(data, [
      'status', 'payment_status', 'paymentStatus', 'state'
    ]));
    const amountRaw = firstValue(data, ['amount', 'price', 'price_amount', 'total']);
    const amount = amountRaw == null ? null : Number(amountRaw);

    if (orderId) {
      const orders = readJSON(ORDERS_FILE, []);
      const order = orders.find(o => String(o.orderId) === String(orderId));

      if (order) {
        /*
         * We only change the local state when the callback itself contains
         * an explicit recognized status. Amount is checked when supplied.
         * The exact GatePay callback schema can change, so unknown payloads
         * are logged instead of being treated as successful payments.
         */
        const amountMatches = amount == null || !Number.isFinite(amount) ||
          Math.abs(Number(order.total) - amount) < 0.02;

        if (status && amountMatches) {
          order.paymentStatus = status;
          order.updatedAt = nowISO();
          order.gatepayCallback = data;
          writeJSON(ORDERS_FILE, orders.slice(-2000));
        } else if (!status) {
          console.warn('GatePay callback sans statut reconnu:', data);
        } else if (!amountMatches) {
          console.warn('GatePay callback montant différent:', {
            expected: order.total,
            received: amount,
            orderId
          });
        }
      } else {
        console.warn('GatePay callback: commande inconnue:', orderId);
      }
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('GatePay callback error:', e.message);
    res.status(200).json({ ok: true });
  }
});

/* =====================================================
   BANK TRANSFER
===================================================== */

app.get('/api/payment/bank-info', (req, res) => {
  res.json({
    ok: true,
    beneficiary: process.env.BANK_BENEFICIARY || '',
    bank: process.env.BANK_NAME || '',
    iban: process.env.BANK_IBAN || '',
    bic: process.env.BANK_BIC || ''
  });
});

/* =====================================================
   ORDERS
===================================================== */

function productSummary(item) {
  return {
    id: cleanString(item?.id, 100),
    name: cleanString(item?.name, 300),
    price: Number(item?.price || 0),
    qty: Math.max(1, Number(item?.qty || 1)),
    description: cleanString(item?.description, 500),
    image: cleanString(item?.image, 2000),
    sourceUrl: cleanString(item?.itemUrl || item?.sourceUrl, 2000)
  };
}

function orderText(order) {
  const lines = [
    `🛒 MERCADO — Nouvelle commande`,
    `Commande: ${order.orderId}`,
    `Paiement: ${order.paymentMethod || 'non précisé'}`,
    `Statut paiement: ${order.paymentStatus || 'pending'}`,
    `Total: ${order.total} ${order.currency || 'EUR'}`,
    '',
    `Client: ${order.customer?.name || ''}`,
    `Email: ${order.customer?.email || ''}`,
    `Téléphone: ${order.customer?.phone || ''}`,
    `Adresse: ${order.customer?.address || ''}`,
    '',
    'Produits:'
  ];

  for (const item of order.items || []) {
    lines.push(`- ${item.name} × ${item.qty} — ${item.price}`);
    if (item.sourceUrl) lines.push(`  ${item.sourceUrl}`);
  }
  return lines.join('\n');
}

async function sendAdminMessage(message) {
  /* Telegram */
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message
      })
    });
    if (r.ok) return { channel: 'telegram' };
    console.error('Telegram error:', await r.text());
  }

  /* Facebook Messenger */
  if (process.env.FB_PAGE_ACCESS_TOKEN && process.env.FB_ADMIN_PSID) {
    const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(process.env.FB_PAGE_ACCESS_TOKEN)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: process.env.FB_ADMIN_PSID },
        message: { text: message }
      })
    });
    if (r.ok) return { channel: 'messenger' };
    console.error('Messenger error:', await r.text());
  }

  /* Twilio WhatsApp */
  if (
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_FROM &&
    process.env.WHATSAPP_TO
  ) {
    const credentials = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');

    const params = new URLSearchParams({
      From: process.env.TWILIO_WHATSAPP_FROM,
      To: process.env.WHATSAPP_TO,
      Body: message
    });

    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      }
    );

    if (r.ok) return { channel: 'whatsapp' };
    console.error('Twilio error:', await r.text());
  }

  throw new Error('Aucun canal admin configuré ou tous les canaux ont échoué');
}

app.post('/api/order', async (req, res) => {
  try {
    const body = req.body || {};
    const orderId = cleanString(body.orderId || `MERCADO-${Date.now()}`, 120);
    const items = Array.isArray(body.items) ? body.items.map(productSummary) : [];
    const customer = {
      name: cleanString(body.customer?.name, 300),
      email: normalizeEmail(body.customer?.email),
      phone: cleanString(body.customer?.phone, 100),
      address: cleanString(body.customer?.address, 1000)
    };

    const total = Number(body.total || 0);
    if (!items.length) return res.status(400).json({ error: 'Commande vide' });
    if (!Number.isFinite(total) || total <= 0) return res.status(400).json({ error: 'Total invalide' });

    const paymentMethod = cleanString(body.paymentMethod || 'unknown', 50);
    const paymentStatus = paymentMethod.toLowerCase().includes('gatepay') ? 'pending' : 'pending';

    const order = {
      orderId,
      items,
      customer,
      paymentMethod,
      paymentStatus,
      total: Number(total.toFixed(2)),
      currency: cleanString(body.currency || 'EUR', 10).toUpperCase(),
      createdAt: nowISO(),
      updatedAt: nowISO()
    };

    const orders = readJSON(ORDERS_FILE, []);
    orders.push(order);
    writeJSON(ORDERS_FILE, orders.slice(-2000));

    let adminNotification = null;
    try {
      adminNotification = await sendAdminMessage(orderText(order));
    } catch (e) {
      console.error('Admin notification:', e.message);
    }

    if (customer.email && isEmail(customer.email)) {
      try {
        await sendEmail({
          to: customer.email,
          subject: `Confirmation de commande MERCADO ${orderId}`,
          text: `Merci pour votre commande ${orderId}. Total: ${order.total} ${order.currency}.`,
          html: `<h2>Merci pour votre commande</h2><p>Commande: <strong>${orderId}</strong></p><p>Total: <strong>${order.total} ${order.currency}</strong></p><p>Nous vous informerons de l'état du paiement.</p>`
        });
      } catch (e) {
        console.error('Customer email:', e.message);
      }
    }

    /* Mark viewed products as purchased so reminders are not sent. */
    const views = readJSON(VIEWS_FILE, []);
    const email = customer.email;
    const purchasedIds = new Set(items.map(i => String(i.id)));
    for (const view of views) {
      if (email && normalizeEmail(view.email) === email && purchasedIds.has(String(view.product?.id || view.productId))) {
        view.purchased = true;
        view.reminded = true;
      }
    }
    writeJSON(VIEWS_FILE, views.slice(-500));

    res.json({ ok: true, orderId, paymentStatus, adminNotification });
  } catch (e) {
    console.error('order:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/order/:orderId', (req, res) => {
  const orderId = cleanString(req.params.orderId, 120);
  const orders = readJSON(ORDERS_FILE, []);
  const order = orders.find(o => String(o.orderId) === orderId);
  if (!order) return res.status(404).json({ ok: false, error: 'Commande introuvable' });
  res.json({ ok: true, order });
});

/* =====================================================
   PRODUCT CATALOG — LOCAL
===================================================== */

app.get('/api/products', (req, res) => {
  res.json({ ok: true, products: readJSON(PRODUCTS_FILE, []) });
});

/* =====================================================
   PRODUCT AVAILABILITY SUBSCRIPTIONS
===================================================== */

app.post('/api/notify/subscribe', (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const query = cleanString(req.body?.query, 300);
    if (!isEmail(email)) return res.status(400).json({ error: 'Email invalide' });
    if (!query) return res.status(400).json({ error: 'Produit recherché manquant' });

    const list = readJSON(SUBSCRIBERS_FILE, []);
    const exists = list.some(x => normalizeEmail(x.email) === email && String(x.query).toLowerCase() === query.toLowerCase());
    if (!exists) list.push({ email, query, createdAt: nowISO() });
    writeJSON(SUBSCRIBERS_FILE, list.slice(-5000));

    res.json({ ok: true, subscribed: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/notify-broadcast', requireAdmin, async (req, res) => {
  try {
    const query = cleanString(req.body?.query, 300);
    const subject = cleanString(req.body?.subject || `Produit disponible — ${query}`, 300);
    const html = cleanString(req.body?.html || `<p>Le produit que vous recherchez est maintenant disponible.</p><p>${query}</p>`, 10000);
    const text = cleanString(req.body?.text || `Le produit que vous recherchez est maintenant disponible: ${query}`, 5000);

    const list = readJSON(SUBSCRIBERS_FILE, []);
    const targets = list.filter(x => !query || String(x.query).toLowerCase().includes(query.toLowerCase()));
    let sent = 0;

    for (const target of targets) {
      try {
        await sendEmail({ to: target.email, subject, html, text });
        sent++;
      } catch (e) {
        console.error('Broadcast email:', target.email, e.message);
      }
    }

    res.json({ ok: true, matched: targets.length, sent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =====================================================
   VIEW TRACKING + REMINDERS
===================================================== */

app.post('/api/track-view', (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const product = req.body?.product || {};
    if (!isEmail(email)) return res.status(400).json({ error: 'Email invalide' });
    if (!product?.id && !product?.name) return res.status(400).json({ error: 'Produit manquant' });

    const views = readJSON(VIEWS_FILE, []);
    views.push({
      email,
      product: productSummary(product),
      viewedAt: nowISO(),
      reminded: false,
      purchased: false
    });

    writeJSON(VIEWS_FILE, views.slice(-500));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function runViewReminders() {
  if (!process.env.RESEND_API_KEY && !(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)) return;

  const delayHours = Math.max(1, Number(process.env.REMINDER_DELAY_HOURS || 24));
  const cutoff = Date.now() - delayHours * 60 * 60 * 1000;
  const views = readJSON(VIEWS_FILE, []);
  let changed = false;

  for (const view of views) {
    if (view.reminded || view.purchased) continue;
    const viewedAt = Date.parse(view.viewedAt || '');
    if (!Number.isFinite(viewedAt) || viewedAt > cutoff || !isEmail(view.email)) continue;

    const product = view.product || {};
    const name = cleanString(product.name || 'ce produit', 300);
    const price = Number(product.price || 0);
    const sourceUrl = cleanString(product.sourceUrl || '', 2000);
    const image = cleanString(product.image || '', 2000);

    try {
      await sendEmail({
        to: normalizeEmail(view.email),
        subject: `Toujours intéressé(e) par ${name} ?`,
        text: `Vous avez récemment consulté ${name}${price ? ` au prix de ${price} EUR` : ''}.`,
        html: `<h2>Toujours intéressé(e) par ${name} ?</h2>${image ? `<img src="${image}" alt="" style="max-width:400px">` : ''}<p>${price ? `Prix: <strong>${price} EUR</strong>` : ''}</p>${sourceUrl ? `<p><a href="${sourceUrl}">Voir le produit</a></p>` : ''}`
      });
      view.reminded = true;
      view.remindedAt = nowISO();
      changed = true;
    } catch (e) {
      console.error('Reminder:', e.message);
    }
  }

  if (changed) writeJSON(VIEWS_FILE, views.slice(-500));
}

app.post('/api/admin/run-reminders', requireAdmin, async (req, res) => {
  await runViewReminders();
  res.json({ ok: true });
});

setInterval(() => {
  runViewReminders().catch(e => console.error('Reminder job:', e.message));
}, 30 * 60 * 1000);

/* =====================================================
   REVIEWS
===================================================== */

app.get('/api/reviews', (req, res) => {
  const productId = cleanString(req.query.productId, 100);
  const reviews = readJSON(REVIEWS_FILE, []);
  res.json({
    ok: true,
    reviews: productId ? reviews.filter(r => String(r.productId) === productId) : reviews
  });
});

app.post('/api/reviews', (req, res) => {
  try {
    const productId = cleanString(req.body?.productId, 100);
    const name = cleanString(req.body?.name || 'Client', 100);
    const text = cleanString(req.body?.text, 2000);
    const rating = Number(req.body?.rating);

    if (!productId || !text) return res.status(400).json({ error: 'Produit et avis requis' });
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Note invalide' });

    const reviews = readJSON(REVIEWS_FILE, []);
    const review = {
      id: crypto.randomUUID(),
      productId,
      name,
      text,
      rating: Number(rating),
      createdAt: nowISO()
    };
    reviews.push(review);
    writeJSON(REVIEWS_FILE, reviews.slice(-5000));
    res.json({ ok: true, review });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =====================================================
   EBAY CATALOG
===================================================== */

const EBAY_MARKETPLACES = {
  US: { host: 'api.ebay.com', marketplace: 'EBAY_US', currency: 'USD' },
  GB: { host: 'api.ebay.com', marketplace: 'EBAY_GB', currency: 'GBP' },
  CA: { host: 'api.ebay.com', marketplace: 'EBAY_CA', currency: 'CAD' },
  AU: { host: 'api.ebay.com', marketplace: 'EBAY_AU', currency: 'AUD' },
  DE: { host: 'api.ebay.com', marketplace: 'EBAY_DE', currency: 'EUR' },
  FR: { host: 'api.ebay.com', marketplace: 'EBAY_FR', currency: 'EUR' },
  IT: { host: 'api.ebay.com', marketplace: 'EBAY_IT', currency: 'EUR' },
  ES: { host: 'api.ebay.com', marketplace: 'EBAY_ES', currency: 'EUR' }
};

let ebayTokenCache = { token: null, expiresAt: 0 };

async function getEbayToken() {
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) return null;
  if (ebayTokenCache.token && ebayTokenCache.expiresAt > Date.now() + 60000) return ebayTokenCache.token;

  const credentials = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope'
  });

  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`
    },
    body: params
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || 'eBay OAuth error');

  ebayTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 7200) * 1000
  };
  return ebayTokenCache.token;
}

function marketplaceFor(country) {
  const c = cleanString(country || 'US', 2).toUpperCase();
  return EBAY_MARKETPLACES[c] || EBAY_MARKETPLACES.US;
}

function ebayProductFromItem(item, markup) {
  const priceValue = Number(item?.price?.value || item?.price || 0);
  return {
    id: item?.itemId || item?.legacyItemId || crypto.randomUUID(),
    name: item?.title || 'eBay product',
    category: item?.categories?.[0]?.categoryName || 'Products',
    price: Number((priceValue + markup).toFixed(2)),
    originalPrice: priceValue,
    currency: item?.price?.currency || 'USD',
    rating: Number(item?.seller?.feedbackPercentage || 0) / 20 || 0,
    sold: Number(item?.estimatedAvailabilities?.[0]?.estimatedAvailableQuantity || 0),
    image: item?.image?.imageUrl || item?.thumbnailImages?.[0]?.imageUrl || '',
    description: item?.shortDescription || item?.condition || '',
    itemUrl: item?.itemWebUrl || '',
    shipping: item?.shippingOptions?.[0]?.shippingCost?.value
      ? `Shipping ${item.shippingOptions[0].shippingCost.value} ${item.shippingOptions[0].shippingCost.currency || ''}`
      : 'Standard shipping'
  };
}

app.get('/api/catalog/search', async (req, res) => {
  try {
    const q = cleanString(req.query.q, 200);
    const country = cleanString(req.query.country || 'US', 2).toUpperCase();
    if (!q) return res.status(400).json({ error: 'Recherche vide' });

    const token = await getEbayToken();
    if (!token) {
      const products = readJSON(PRODUCTS_FILE, []);
      const filtered = products.filter(p =>
        `${p.name} ${p.category} ${p.description}`.toLowerCase().includes(q.toLowerCase())
      );
      return res.json({ ok: true, source: 'local', products: filtered });
    }

    const mp = marketplaceFor(country);
    const markup = Number(process.env.PRICE_MARKUP || 6);
    const url = new URL(`https://${mp.host}/buy/browse/v1/item_summary/search`);
    url.searchParams.set('q', q);
    url.searchParams.set('limit', '24');

    const r = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': mp.marketplace
      }
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.errors?.[0]?.message || 'eBay search error');

    res.json({
      ok: true,
      source: 'ebay',
      country,
      products: (data.itemSummaries || []).map(item => ebayProductFromItem(item, markup))
    });
  } catch (e) {
    console.error('eBay search:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/catalog/home', async (req, res) => {
  try {
    const country = cleanString(req.query.country || 'US', 2).toUpperCase();
    const q = cleanString(req.query.q || 'best sellers', 200);

    const token = await getEbayToken();
    if (!token) {
      return res.json({ ok: true, source: 'local', products: readJSON(PRODUCTS_FILE, []) });
    }

    const mp = marketplaceFor(country);
    const markup = Number(process.env.PRICE_MARKUP || 6);
    const url = new URL(`https://${mp.host}/buy/browse/v1/item_summary/search`);
    url.searchParams.set('q', q);
    url.searchParams.set('limit', '24');

    const r = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': mp.marketplace
      }
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.errors?.[0]?.message || 'eBay home error');

    res.json({
      ok: true,
      source: 'ebay',
      country,
      products: (data.itemSummaries || []).map(item => ebayProductFromItem(item, markup))
    });
  } catch (e) {
    console.error('eBay home:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/catalog/item', async (req, res) => {
  try {
    const itemId = cleanString(req.query.itemId || req.query.id, 200);
    if (!itemId) return res.status(400).json({ error: 'itemId requis' });

    const token = await getEbayToken();
    if (!token) {
      const product = readJSON(PRODUCTS_FILE, []).find(p => String(p.id) === itemId);
      if (!product) return res.status(404).json({ error: 'Produit introuvable' });
      return res.json({ ok: true, source: 'local', product });
    }

    const country = cleanString(req.query.country || 'US', 2).toUpperCase();
    const mp = marketplaceFor(country);
    const r = await fetch(`https://${mp.host}/buy/browse/v1/item/${encodeURIComponent(itemId)}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': mp.marketplace
      }
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.errors?.[0]?.message || 'eBay item error');

    res.json({ ok: true, source: 'ebay', product: ebayProductFromItem(data, Number(process.env.PRICE_MARKUP || 6)), raw: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =====================================================
   VISUAL SEARCH
===================================================== */

app.post('/api/visual-search', async (req, res) => {
  /* The frontend may send an image, but no third-party image-search API
     is configured by default. We return a safe local fallback. */
  const products = readJSON(PRODUCTS_FILE, []);
  res.json({ ok: true, source: 'local', products: products.slice(0, 12) });
});

/* =====================================================
   MERCADO AI — ANTHROPIC
===================================================== */

app.post('/api/ai', async (req, res) => {
  try {
    const question = cleanString(req.body?.question, 5000);
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-12) : [];
    const product = req.body?.product || null;
    const country = cleanString(req.body?.country || '', 100);
    const language = cleanString(req.body?.language || 'English', 50);

    if (!question) return res.status(400).json({ error: 'Question vide' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'MERCADO AI non configuré' });
    }

    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
    const productContext = product ? JSON.stringify(product).slice(0, 8000) : 'No product selected.';

    const messages = history
      .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
      .map(m => ({ role: m.role, content: cleanString(m.content, 5000) }));
    messages.push({ role: 'user', content: question });

    const system = `You are MERCADO AI, a helpful ecommerce shopping assistant.\nLanguage: ${language}.\nCustomer country: ${country || 'unknown'}.\nSelected product: ${productContext}\nHelp the customer understand products, compare options, explain checkout and answer shopping questions. Do not invent product facts that are not provided.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 900,
        system,
        messages
      })
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || 'Anthropic API error');

    const answer = (data.content || [])
      .filter(x => x.type === 'text')
      .map(x => x.text)
      .join('\n')
      .trim();

    const logs = readJSON(AI_LOG_FILE, []);
    logs.push({ question, answer, country, language, createdAt: nowISO() });
    writeJSON(AI_LOG_FILE, logs.slice(-2000));

    res.json({ ok: true, answer });
  } catch (e) {
    console.error('AI:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* =====================================================
   TRANSLATION — DEEPL / GOOGLE
===================================================== */

app.post('/api/translate', async (req, res) => {
  try {
    const target = cleanString(req.body?.target, 20);
    const texts = Array.isArray(req.body?.texts)
      ? req.body.texts.map(x => String(x ?? '')).slice(0, 100)
      : [];

    if (!target || !texts.length) return res.status(400).json({ error: 'target/texts requis' });

    if (process.env.DEEPL_API_KEY) {
      const params = new URLSearchParams();
      params.set('auth_key', process.env.DEEPL_API_KEY);
      params.set('target_lang', target.toUpperCase());
      for (const text of texts) params.append('text', text);

      const endpoint = process.env.DEEPL_API_KEY.includes(':fx')
        ? 'https://api-free.deepl.com/v2/translate'
        : 'https://api.deepl.com/v2/translate';

      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || 'DeepL error');
      return res.json({ ok: true, provider: 'deepl', texts: (data.translations || []).map(x => x.text) });
    }

    if (process.env.GOOGLE_TRANSLATE_API_KEY) {
      const r = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(process.env.GOOGLE_TRANSLATE_API_KEY)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: texts, target })
        }
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error?.message || 'Google Translate error');
      return res.json({ ok: true, provider: 'google', texts: (data.data?.translations || []).map(x => x.translatedText) });
    }

    return res.json({ ok: true, provider: 'none', texts });
  } catch (e) {
    console.error('translate:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* =====================================================
   SPA FALLBACK
===================================================== */

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  res.status(404).send('MERCADO index.html introuvable');
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Erreur serveur' });
});

app.listen(PORT, () => {
  console.log(`MERCADO running on port ${PORT}`);
  console.log(`GatePay configured: ${Boolean(process.env.GATEPAY_WALLET_ADDRESS)}`);
  console.log(`Public URL: ${publicBaseUrl() || '(not configured)'}`);
});
