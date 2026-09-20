require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const app = express();
const PORT = process.env.PORT || 10000;
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const GATEPAY_API = "https://api.gatepay.to/pay.php";
const GATEPAY_WALLET = process.env.GATEPAY_WALLET_ADDRESS || "";
const LANGUAGE_CURRENCY = {
  en: "USD", fr: "EUR", de: "EUR", es: "EUR", it: "EUR", nl: "EUR",
  pt: "EUR", pl: "PLN", ja: "JPY", zh: "CNY", ko: "KRW", ar: "AED", ru: "RUB"
};
const USD_RATES = {
  USD: 1, EUR: 0.92, PLN: 3.65, JPY: 149, CNY: 7.10, KRW: 1350, AED: 3.67, RUB: 80
};
function currencyForLanguage(language) {
  return LANGUAGE_CURRENCY[String(language || "en").toLowerCase()] || "USD";
}
function rateForCurrency(currency) {
  return USD_RATES[currency] || 1;
}
const PRICE_MARKUP = Number.isFinite(Number(process.env.PRICE_MARKUP))
  ? Number(process.env.PRICE_MARKUP)
  : 6;
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
function file(name) {
  return path.join(DATA_DIR, name);
}
function readJSON(name, fallback) {
  try {
    const p = file(name);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    const raw = fs.readFileSync(p, "utf8");
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error("readJSON:", name, e.message);
    return fallback;
  }
}
function writeJSON(name, data) {
  fs.writeFileSync(file(name), JSON.stringify(data, null, 2));
}
const orders = readJSON("orders.json", []);
const products = readJSON("products.json", []);
const reviews = readJSON("reviews.json", []);
const subscribers = readJSON("subscribers.json", []);
const productViews = readJSON("product-views.json", []);
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "MERCADO",
    payment: "GatePay.to",
    currency: "dynamic",
    gatepayConfigured: Boolean(GATEPAY_WALLET),
    markup: PRICE_MARKUP,
    time: new Date().toISOString()
  });
});
app.get("/api/config", (req, res) => {
  res.json({
    paymentMethods: ["gatepay"],
    gatepay: Boolean(GATEPAY_WALLET),
    gatepayEndpoint: "/api/payment/gatepay",
    bankTransfer: false,
    currency: "dynamic"
  });
});
let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}
async function sendEmail({ to, subject, html, text }) {
  if (!to) return false;
  if (process.env.RESEND_API_KEY) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || "MERCADO <onboarding@resend.dev>",
          to: [to],
          subject,
          html,
          text
        })
      });
      if (r.ok) return true;
      console.error("Resend:", await r.text());
    } catch (e) {
      console.error("Resend:", e.message);
    }
  }
  if (mailTransporter) {
    try {
      await mailTransporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to,
        subject,
        html,
        text
      });
      return true;
    } catch (e) {
      console.error("SMTP:", e.message);
    }
  }
  return false;
}
const emailCodes = new Map();
app.post("/api/email/send", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Email invalide" });
  }
  const code = String(Math.floor(1000 + Math.random() * 9000));
  emailCodes.set(email, {
    code,
    expiresAt: Date.now() + 10 * 60 * 1000
  });
  const sent = await sendEmail({
    to: email,
    subject: "Votre code MERCADO",
    text: `Votre code de vérification MERCADO est ${code}. Il expire dans 10 minutes.`,
    html: `<div style="font-family:Arial"><h2>MERCADO</h2><p>Votre code :</p><h1>${code}</h1><p>Expire dans 10 minutes.</p></div>`
  });
  res.json({
    ok: true,
    sent,
    message: sent ? "Code envoyé" : "Service email non configuré"
  });
});
app.post("/api/email/verify", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const code = String(req.body.code || "").trim();
  const record = emailCodes.get(email);
  if (!record) return res.status(400).json({ verified: false, error: "Code introuvable" });
  if (Date.now() > record.expiresAt) {
    emailCodes.delete(email);
    return res.status(400).json({ verified: false, error: "Code expiré" });
  }
  if (record.code !== code) {
    return res.status(400).json({ verified: false, error: "Code incorrect" });
  }
  emailCodes.delete(email);
  res.json({ verified: true });
});
app.get("/api/products", (req, res) => res.json({ products }));
let ebayToken = null;
let ebayTokenExpires = 0;
async function getEbayToken() {
  if (ebayToken && Date.now() < ebayTokenExpires) return ebayToken;
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("EBAY_CLIENT_ID / EBAY_CLIENT_SECRET manquants");
  }
  const sandbox =
    String(process.env.EBAY_ENVIRONMENT || "production").toLowerCase() === "sandbox";
  const tokenUrl = sandbox
    ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
    : "https://api.ebay.com/identity/v1/oauth2/token";
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body:
      "grant_type=client_credentials&scope=" +
      encodeURIComponent("https://api.ebay.com/oauth/api_scope")
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    throw new Error(data.error_description || "Impossible d'obtenir le token eBay");
  }
  ebayToken = data.access_token;
  ebayTokenExpires = Date.now() + ((Number(data.expires_in) || 7200) - 120) * 1000;
  return ebayToken;
}
function ebayBase() {
  return String(process.env.EBAY_ENVIRONMENT || "production").toLowerCase() === "sandbox"
    ? "https://api.sandbox.ebay.com"
    : "https://api.ebay.com";
}
function marketplaceId(country) {
  const c = String(country || "US").toUpperCase();
  return {
    US: "EBAY_US",
    GB: "EBAY_GB",
    FR: "EBAY_FR",
    DE: "EBAY_DE",
    IT: "EBAY_IT",
    ES: "EBAY_ES",
    CA: "EBAY_CA",
    AU: "EBAY_AU"
  }[c] || "EBAY_US";
}
function mercadoPrice(basePrice) {
  return Math.max(0, Number(basePrice) || 0) + PRICE_MARKUP;
}
function normalizeEbayItems(items) {
  return items.map((x) => {
    const ebayPrice = Number(x.price?.value) || 0;
    const salePrice = mercadoPrice(ebayPrice);
    return {
      id: x.itemId,
      itemId: x.itemId,
      name: x.title || "Produit MERCADO",
      title: x.title || "Produit MERCADO",
      category: x.categories?.[0]?.categoryName || "General",
      cat: x.categories?.[0]?.categoryName || "General",
      price: Number(salePrice.toFixed(2)),
      rating: Number(x.reviews?.averageRating || x.rating || 0),
      sold: Number(x.quantitySold || 0),
      image: x.image?.imageUrl || x.thumbnailImages?.[0]?.imageUrl || "",
      imageUrl: x.image?.imageUrl || "",
      thumbnail: x.thumbnailImages?.[0]?.imageUrl || "",
      description: x.shortDescription || "",
      desc: x.shortDescription || "",
      itemUrl: x.itemWebUrl || "",
      url: x.itemWebUrl || "",
      _ebayPrice: Number(ebayPrice.toFixed(2)),
      _markup: PRICE_MARKUP
    };
  });
}
async function ebaySearch({ q, limit, offset, country }) {
  const token = await getEbayToken();
  const safeLimit = Math.min(Math.max(Number(limit) || 48, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const params = new URLSearchParams({
    q: q || "popular products",
    limit: String(safeLimit),
    offset: String(safeOffset),
    filter: "buyingOptions:{FIXED_PRICE}",
    fieldgroups: "EXTENDED",
    sort: "BEST_MATCH"
  });
  const r = await fetch(
    ebayBase() + "/buy/browse/v1/item_summary/search?" + params.toString(),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplaceId(country)
      }
    }
  );
  const data = await r.json();
  if (!r.ok) {
    const err = new Error(data?.errors?.[0]?.message || "eBay API error");
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return {
    total: Number(data.total || 0),
    offset: safeOffset,
    limit: safeLimit,
    items: normalizeEbayItems(data.itemSummaries || [])
  };
}
app.get("/api/catalog/home", async (req, res) => {
  try {
    const result = await ebaySearch({
      q: String(req.query.q || "popular products"),
      limit: req.query.limit,
      offset: req.query.offset,
      country: req.query.country
    });
    res.json(result);
  } catch (e) {
    console.error("eBay home:", e.message);
    res.status(e.status || 500).json({
      error: "Catalogue eBay indisponible",
      details: e.data || undefined
    });
  }
});
app.get("/api/catalog/search", async (req, res) => {
  try {
    const q = String(req.query.q || "popular products").trim();
    if (!q) return res.status(400).json({ error: "Recherche vide" });
    const result = await ebaySearch({
      q,
      limit: req.query.limit,
      offset: req.query.offset,
      country: req.query.country
    });
    res.json(result);
  } catch (e) {
    console.error("eBay search:", e.message);
    res.status(e.status || 500).json({
      error: "Recherche eBay indisponible",
      details: e.data || undefined
    });
  }
});
app.get("/api/catalog/item", async (req, res) => {
  try {
    const itemId = String(req.query.itemId || "").trim();
    if (!itemId) return res.status(400).json({ error: "itemId manquant" });
    const token = await getEbayToken();
    const r = await fetch(
      ebayBase() + "/buy/browse/v1/item/" + encodeURIComponent(itemId),
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    const ebayPrice = Number(data.price?.value || 0);
    res.json({
      id: data.itemId,
      title: data.title || "",
      image: data.image?.imageUrl || "",
      itemUrl: data.itemWebUrl || "",
      price: Number(mercadoPrice(ebayPrice).toFixed(2)),
      rating: Number(data.reviews?.averageRating || data.rating || 0),
      sold: Number(data.quantitySold || data.sold || 0)
    });
  } catch (e) {
    console.error("eBay item:", e.message);
    res.status(500).json({ error: "Produit indisponible" });
  }
});
function calculateOrderTotal(items, currency = "USD") {
  let total = 0;
  const rate = rateForCurrency(currency);
  for (const item of Array.isArray(items) ? items : []) {
    const qty = Math.max(1, Number(item.qty || item.quantity || 1));
    const base =
      item.basePrice != null ? Number(item.basePrice) :
      item.ebayPrice != null ? Number(item.ebayPrice) :
      item._ebayPrice != null ? Number(item._ebayPrice) :
      null;
    const displayed =
      item.price != null ? Number(item.price) : 0;
    let unitPrice;
    if (Number.isFinite(base) && base >= 0) {
      unitPrice = (base + PRICE_MARKUP) * rate;
    } else {
      unitPrice = displayed;
    }
    total += Math.max(0, unitPrice) * qty;
  }
  return Number(total.toFixed(2));
}
app.post("/api/order", async (req, res) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) {
      return res.status(400).json({ error: "Commande vide" });
    }
    const language = String(body.language || "en").toLowerCase();
    const currency = currencyForLanguage(language);
    const serverTotal = calculateOrderTotal(items, currency);
    if (!serverTotal || serverTotal <= 0) {
      return res.status(400).json({ error: "Montant de commande invalide" });
    }
    const orderId = String(body.orderId || `MRC-${Date.now()}`);
    const order = {
      id: crypto.randomUUID(),
      orderId,
      status: "pending",
      paymentStatus: "pending",
      paymentMethod: "GatePay.to",
      language,
      currency,
      total: serverTotal,
      items,
      customer: body.customer || {},
      createdAt: new Date().toISOString()
    };
    orders.push(order);
    writeJSON("orders.json", orders);
    await notifyTelegram(formatOrderMessage(order));
    if (order.customer?.email) {
      await sendEmail({
        to: order.customer.email,
        subject: `Commande MERCADO ${order.orderId}`,
        text:
          `Votre commande ${order.orderId} a été reçue. ` +
          `Montant : ${order.total.toFixed(2)} ${order.currency}. Paiement : GatePay.to.`,
        html:
          `<h2>MERCADO</h2>` +
          `<p>Commande <b>${escapeHtml(order.orderId)}</b> reçue.</p>` +
          `<p>Total : <b>${order.total.toFixed(2)} ${order.currency}</b></p>` +
          `<p>Paiement : GatePay.to</p>`
      });
    }
    res.json({
      ok: true,
      orderId: order.orderId,
      total: order.total,
      paymentMethod: "GatePay.to"
    });
  } catch (e) {
    console.error("order:", e);
    res.status(500).json({ error: "Impossible d'enregistrer la commande" });
  }
});
async function createGatePayPayment(req, res) {
  try {
    if (!GATEPAY_WALLET) {
      return res.status(500).json({
        error: "GATEPAY_WALLET_ADDRESS n'est pas configuré sur Render"
      });
    }
    const orderId = String(
      req.body.orderId ||
      req.body.order_id ||
      ""
    ).trim();
    if (!orderId) {
      return res.status(400).json({ error: "orderId manquant" });
    }
    const order = orders.find(
      (o) => String(o.orderId) === orderId
    );
    if (!order) {
      return res.status(404).json({
        error: "Commande introuvable"
      });
    }
    if (order.paymentStatus === "paid") {
      return res.status(409).json({
        error: "Cette commande est déjà payée"
      });
    }
    const amount = Number(order.total);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: "Montant de commande invalide"
      });
    }
    const payload = {
      wallet: GATEPAY_WALLET,
      amount: Number(amount.toFixed(2)),
      currency: order.currency || "USD",
      callback_url: `${PUBLIC_BASE_URL}/api/payment/gatepay/callback`,
      order_id: order.orderId
    };
    console.log("GatePay request:", {
      orderId: order.orderId,
      amount: payload.amount,
      currency: payload.currency
    });
    const response = await fetch(GATEPAY_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload)
    });
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
    if (!response.ok) {
      console.error("GatePay HTTP error:", response.status, data);
      return res.status(502).json({
        error: "GatePay.to a refusé la création du paiement",
        details:
          data?.error ||
          data?.message ||
          data?.raw ||
          null
      });
    }
    const paymentUrl =
      data.payment_url ||
      data.checkout_url ||
      data.url ||
      data.checkout ||
      data.payment?.url ||
      data.data?.payment_url ||
      data.data?.checkout_url ||
      data.data?.url;
    if (!paymentUrl) {
      console.error("GatePay response sans URL:", data);
      return res.status(502).json({
        error: "GatePay.to n'a pas retourné de lien de paiement",
        response: data
      });
    }
    order.gatepay = {
      paymentUrl,
      amount: payload.amount,
      currency: payload.currency,
      createdAt: new Date().toISOString()
    };
    writeJSON("orders.json", orders);
    res.json({
      ok: true,
      order_id: order.orderId,
      payment_url: paymentUrl,
      checkout_url: paymentUrl,
      amount: payload.amount,
      currency: payload.currency
    });
  } catch (e) {
    console.error("GatePay create:", e);
    res.status(500).json({
      error: "GatePay.to est temporairement indisponible"
    });
  }
}
app.post("/api/payment/gatepay", createGatePayPayment);
app.post("/api/payment/paygate", createGatePayPayment);
app.all("/api/payment/gatepay/callback", async (req, res) => {
  try {
    const body = {
      ...(req.query || {}),
      ...(req.body || {})
    };
    const orderId =
      body.order_id ||
      body.orderId ||
      body.merchant_order_id ||
      body.reference ||
      body.invoice_id ||
      body.payment_id ||
      body.order;
    const status = String(
      body.status ||
      body.payment_status ||
      body.state ||
      ""
    ).toLowerCase();
    console.log("GatePay callback:", body);
    const paidStatuses = [
      "paid",
      "completed",
      "complete",
      "success",
      "successful",
      "confirmed",
      "confirmed_payment"
    ];
    const failedStatuses = [
      "failed",
      "failure",
      "cancelled",
      "canceled",
      "expired",
      "declined"
    ];
    const order = orders.find(
      (o) => String(o.orderId) === String(orderId)
    );
    if (order) {
      order.gatepayCallback = body;
      order.updatedAt = new Date().toISOString();
      if (paidStatuses.includes(status)) {
        const wasPaid = order.paymentStatus === "paid";
        order.paymentStatus = "paid";
        order.status = "paid";
        if (!wasPaid) {
          await notifyTelegram(
            "✅ PAIEMENT GATEPAY CONFIRMÉ\n\n" +
            formatOrderMessage(order)
          );
          if (order.customer?.email) {
            await sendEmail({
              to: order.customer.email,
              subject: `Paiement confirmé - ${order.orderId}`,
              text:
                `Votre paiement GatePay.to pour la commande ` +
                `${order.orderId} a été confirmé.`,
              html:
                `<h2>MERCADO</h2>` +
                `<p>Votre paiement pour <b>${escapeHtml(order.orderId)}</b> est confirmé.</p>` +
                `<p>Total payé : <b>${Number(order.total).toFixed(2)} ${order.currency || "USD"}</b></p>`
            });
          }
        }
      } else if (failedStatuses.includes(status)) {
        order.paymentStatus = "failed";
        order.status = "payment_failed";
      }
      writeJSON("orders.json", orders);
    }
    res.status(200).json({
      ok: true,
      received: true
    });
  } catch (e) {
    console.error("GatePay callback:", e);
    res.status(200).json({
      ok: false,
      received: true
    });
  }
});
app.get("/api/reviews", (req, res) => {
  const productId = String(req.query.productId || "");
  res.json({
    reviews: reviews.filter(
      (r) => String(r.productId) === productId
    )
  });
});
app.post("/api/reviews", (req, res) => {
  const productId = String(req.body.productId || "");
  const text = String(req.body.text || "").trim();
  const stars = Number(req.body.stars);
  if (
    !productId ||
    !text ||
    !Number.isInteger(stars) ||
    stars < 1 ||
    stars > 5
  ) {
    return res.status(400).json({ error: "Avis invalide" });
  }
  const review = {
    id: crypto.randomUUID(),
    productId,
    name: String(req.body.name || "Client").slice(0, 80),
    initial: String(req.body.initial || "C").slice(0, 1),
    stars,
    date: req.body.date || new Date().toLocaleDateString("fr-FR"),
    text: text.slice(0, 2000),
    variant: String(req.body.variant || "").slice(0, 200)
  };
  reviews.push(review);
  writeJSON("reviews.json", reviews);
  res.json({ ok: true, review });
});
app.post("/api/notify/subscribe", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const query = String(req.body.query || "").trim();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Email invalide" });
  }
  subscribers.push({
    id: crypto.randomUUID(),
    email,
    query,
    createdAt: new Date().toISOString()
  });
  if (subscribers.length > 1000) {
    subscribers.splice(0, subscribers.length - 1000);
  }
  writeJSON("subscribers.json", subscribers);
  res.json({ ok: true });
});
app.post("/api/track-view", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const product = req.body.product || {};
  if (!email || !email.includes("@") || !product.id) {
    return res.status(400).json({ error: "Données invalides" });
  }
  productViews.push({
    id: crypto.randomUUID(),
    email,
    product,
    viewedAt: new Date().toISOString(),
    reminded: false
  });
  if (productViews.length > 500) {
    productViews.splice(0, productViews.length - 500);
  }
  writeJSON("product-views.json", productViews);
  res.json({ ok: true });
});
async function notifyTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message
        })
      }
    );
    return r.ok;
  } catch (e) {
    console.error("Telegram:", e.message);
    return false;
  }
}
function formatOrderMessage(order) {
  const lines = [
    "🛒 NOUVELLE COMMANDE MERCADO",
    "",
    `Order: ${order.orderId}`,
    "Paiement: GatePay.to",
    `Statut: ${order.paymentStatus}`,
    `Total: ${Number(order.total || 0).toFixed(2)} ${order.currency || "USD"}`,
    "",
    "CLIENT"
  ];
  const c = order.customer || {};
  lines.push(`Nom: ${c.name || ""}`);
  lines.push(`Email: ${c.email || ""}`);
  lines.push(`Téléphone: ${c.phone || ""}`);
  lines.push(`Adresse: ${c.address || ""}`);
  lines.push("");
  lines.push("PRODUITS");
  for (const item of order.items || []) {
    lines.push(
      `• ${item.name || "Produit"} × ${item.qty || 1} — ${Number(
        item.price || 0
      ).toFixed(2)} ${order.currency || "USD"}`
    );
  }
  return lines.join("\n");
}
function adminAuthorized(req) {
  const key = process.env.ADMIN_KEY;
  return Boolean(key && req.headers["x-admin-key"] === key);
}
app.get("/api/admin/orders", (req, res) => {
  if (!adminAuthorized(req)) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  res.json({ orders });
});
app.post("/api/ai", async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "AI backend non configuré" });
  }
  try {
    const question = String(req.body.question || "").trim();
    const history = Array.isArray(req.body.history) ? req.body.history.slice(-10) : [];
    const product = req.body.product || null;
    const messages = [
      {
        role: "system",
        content:
          "Tu es MERCADO AI, assistant du site e-commerce MERCADO. " +
          "Réponds clairement et utilement. Le paiement disponible est GatePay.to."
      },
      ...history,
      {
        role: "user",
        content:
          `Produit actuel:\n${JSON.stringify(product)}\n\nQuestion:\n${question}`
      }
    ];
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages,
        temperature: 0.4,
        max_tokens: 800
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: "AI indisponible" });
    res.json({
      answer:
        data.choices?.[0]?.message?.content ||
        "Je n'ai pas pu répondre."
    });
  } catch (e) {
    console.error("AI:", e.message);
    res.status(500).json({ error: "Erreur AI" });
  }
});
app.post("/api/ai-log", (req, res) => {
  res.json({ ok: true });
});
app.post("/api/translate", async (req, res) => {
  const texts = Array.isArray(req.body.texts) ? req.body.texts : [];
  const target = String(req.body.target || "en");
  if (!texts.length || !process.env.OPENAI_API_KEY) {
    return res.json({ translations: texts });
  }
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [{
          role: "user",
          content:
            `Translate each text to ${target}. Return ONLY a JSON array of translated strings.\n` +
            JSON.stringify(texts)
        }],
        temperature: 0
      })
    });
    const data = await r.json();
    const content = data.choices?.[0]?.message?.content || "";
    let translations;
    try {
      translations = JSON.parse(
        content.replace(/^```json/i, "").replace(/```$/i, "").trim()
      );
    } catch {
      translations = texts;
    }
    res.json({ translations });
  } catch {
    res.json({ translations: texts });
  }
});
app.post("/api/admin/run-reminders", async (req, res) => {
  if (!adminAuthorized(req)) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  const delayHours = Number(process.env.REMINDER_DELAY_HOURS || 24);
  const limit = Date.now() - delayHours * 60 * 60 * 1000;
  let sent = 0;
  for (const view of productViews) {
    if (view.reminded || !view.viewedAt) continue;
    if (new Date(view.viewedAt).getTime() > limit) continue;
    const product = view.product || {};
    const ok = await sendEmail({
      to: view.email,
      subject: `Toujours intéressé(e) par ${product.name || "ce produit"} ?`,
      text: `Vous avez récemment consulté ${product.name || "un produit"} sur MERCADO.`,
      html:
        `<h2>MERCADO</h2>` +
        `<p>Vous avez récemment consulté <b>${escapeHtml(product.name || "ce produit")}</b>.</p>` +
        (product.img
          ? `<img src="${escapeHtml(product.img)}" style="max-width:300px">`
          : "")
    });
    if (ok) {
      view.reminded = true;
      sent++;
    }
  }
  writeJSON("product-views.json", productViews);
  res.json({ ok: true, sent });
});
app.use(
  express.static(PUBLIC_DIR, {
    etag: false,
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  })
);
app.get("*", (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  res.status(404).send("MERCADO index.html introuvable");
});
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
app.listen(PORT, () => {
  console.log("");
  console.log("=================================");
  console.log("        MERCADO SERVER");
  console.log("=================================");
  console.log(`Port: ${PORT}`);
  console.log(`GatePay: ${GATEPAY_API}`);
  console.log(`Wallet configured: ${GATEPAY_WALLET ? "YES" : "NO"}`);
  console.log(`Currency: dynamic by customer language`);
  console.log(`Markup: $${PRICE_MARKUP}`);
  console.log(`Public URL: ${PUBLIC_BASE_URL}`);
  console.log(`eBay configured: ${process.env.EBAY_CLIENT_ID ? "YES" : "NO"}`);
  console.log("=================================");
});
