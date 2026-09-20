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

/* =========================
   CURRENCY
========================= */

const LANGUAGE_CURRENCY = {
  en: "USD",
  fr: "EUR",
  de: "EUR",
  es: "EUR",
  it: "EUR",
  nl: "EUR",
  pt: "EUR",
  pl: "PLN",
  ja: "JPY",
  zh: "CNY",
  ko: "KRW",
  ar: "AED",
  ru: "RUB"
};

const USD_RATES = {
  USD: 1,
  EUR: 0.92,
  PLN: 3.65,
  JPY: 149,
  CNY: 7.10,
  KRW: 1350,
  AED: 3.67,
  RUB: 80
};

function currencyForLanguage(language) {
  return LANGUAGE_CURRENCY[
    String(language || "en").toLowerCase()
  ] || "USD";
}

function rateForCurrency(currency) {
  return USD_RATES[currency] || 1;
}

const PRICE_MARKUP = Number.isFinite(Number(process.env.PRICE_MARKUP))
  ? Number(process.env.PRICE_MARKUP)
  : 6;

/* =========================
   FILES / DATA
========================= */

const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function dataFile(name) {
  return path.join(DATA_DIR, name);
}

function readJSON(name, fallback) {
  try {
    const p = dataFile(name);

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
  fs.writeFileSync(
    dataFile(name),
    JSON.stringify(data, null, 2)
  );
}

const orders = readJSON("orders.json", []);
const products = readJSON("products.json", []);
const reviews = readJSON("reviews.json", []);
const subscribers = readJSON("subscribers.json", []);
const productViews = readJSON("product-views.json", []);

app.use(cors({
  origin: process.env.CORS_ORIGIN || "*"
}));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "2mb"
}));

/* =========================
   HEALTH
========================= */

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

/* =========================
   EMAIL
========================= */

let mailTransporter = null;

if (
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(
      process.env.SMTP_SECURE || "true"
    ) === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

async function sendEmail({
  to,
  subject,
  html,
  text
}) {
  if (!to) return false;

  /* RESEND */
  if (process.env.RESEND_API_KEY) {
    try {
      const response = await fetch(
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: {
            Authorization:
              `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from:
              process.env.RESEND_FROM ||
              "MERCADO <onboarding@resend.dev>",
            to: [to],
            subject,
            html,
            text
          })
        }
      );

      if (response.ok) return true;

      console.error(
        "Resend:",
        await response.text()
      );
    } catch (e) {
      console.error("Resend:", e.message);
    }
  }

  /* SMTP */
  if (mailTransporter) {
    try {
      await mailTransporter.sendMail({
        from:
          process.env.SMTP_FROM ||
          process.env.SMTP_USER,
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

/* =========================
   EMAIL VERIFICATION
========================= */

const emailCodes = new Map();

app.post("/api/email/send", async (req, res) => {
  const email = String(
    req.body.email || ""
  ).trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return res.status(400).json({
      error: "Email invalide"
    });
  }

  const code = String(
    Math.floor(1000 + Math.random() * 9000)
  );

  emailCodes.set(email, {
    code,
    expiresAt: Date.now() + 10 * 60 * 1000
  });

  const sent = await sendEmail({
    to: email,
    subject: "Votre code MERCADO",
    text:
      `Votre code de vérification MERCADO est ${code}. ` +
      `Il expire dans 10 minutes.`,
    html:
      `<div style="font-family:Arial">` +
      `<h2>MERCADO</h2>` +
      `<p>Votre code :</p>` +
      `<h1>${code}</h1>` +
      `<p>Expire dans 10 minutes.</p>` +
      `</div>`
  });

  res.json({
    ok: true,
    sent,
    message: sent
      ? "Code envoyé"
      : "Service email non configuré"
  });
});

app.post("/api/email/verify", (req, res) => {
  const email = String(
    req.body.email || ""
  ).trim().toLowerCase();

  const code = String(
    req.body.code || ""
  ).trim();

  const record = emailCodes.get(email);

  if (!record) {
    return res.status(400).json({
      verified: false,
      error: "Code introuvable"
    });
  }

  if (Date.now() > record.expiresAt) {
    emailCodes.delete(email);

    return res.status(400).json({
      verified: false,
      error: "Code expiré"
    });
  }

  if (record.code !== code) {
    return res.status(400).json({
      verified: false,
      error: "Code incorrect"
    });
  }

  emailCodes.delete(email);

  res.json({
    verified: true
  });
});

/* =========================
   LOCAL PRODUCTS
========================= */

app.get("/api/products", (req, res) => {
  res.json({
    products
  });
});

/* =========================
   EBAY
========================= */

let ebayToken = null;
let ebayTokenExpires = 0;

async function getEbayToken() {
  if (
    ebayToken &&
    Date.now() < ebayTokenExpires
  ) {
    return ebayToken;
  }

  const clientId =
    process.env.EBAY_CLIENT_ID;

  const clientSecret =
    process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "EBAY_CLIENT_ID / EBAY_CLIENT_SECRET manquants"
    );
  }

  const credentials = Buffer
    .from(`${clientId}:${clientSecret}`)
    .toString("base64");

  const response = await fetch(
    "https://api.ebay.com/identity/v1/oauth2/token",
    {
      method: "POST",
      headers: {
        Authorization:
          `Basic ${credentials}`,
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body:
        "grant_type=client_credentials&" +
        "scope=https://api.ebay.com/oauth/api_scope"
    }
  );

  if (!response.ok) {
    throw new Error(
      `eBay OAuth ${response.status}: ` +
      `${await response.text()}`
    );
  }

  const data = await response.json();

  ebayToken = data.access_token;

  ebayTokenExpires =
    Date.now() +
    ((Number(data.expires_in) || 7200) - 60) *
      1000;

  return ebayToken;
}

function ebayHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Accept-Language": "en-US"
  };
}

function normalizeEbayItems(items) {
  return (items || []).map(item => {
    const price =
      Number(item.price?.value) || 0;

    return {
      id: item.itemId,
      itemId: item.itemId,
      title: item.title || "Product",
      name: item.title || "Product",
      image:
        item.image?.imageUrl ||
        item.thumbnailImages?.[0]?.imageUrl ||
        "",
      price: Number(
        (price + PRICE_MARKUP).toFixed(2)
      ),
      _ebayPrice: price,
      _markup: PRICE_MARKUP,
      currency:
        item.price?.currency || "USD",
      url:
        item.itemWebUrl ||
        item.itemAffiliateWebUrl ||
        "",
      condition:
        item.condition || "",
      seller:
        item.seller?.username || "",
      rating:
        Number(item.seller?.feedbackPercentage) ||
        0
    };
  });
}

/* =========================
   EBAY HOME
========================= */

app.get("/api/catalog/home", async (req, res) => {
  try {
    const token = await getEbayToken();

    const limit = Math.min(
      Number(req.query.limit) || 24,
      48
    );

    const country =
      String(
        req.query.country || "US"
      ).toUpperCase();

    const url =
      "https://api.ebay.com/buy/browse/v1/item_summary/search" +
      "?q=popular%20products" +
      `&limit=${limit}` +
      "&filter=buyingOptions%3A%7BFIXED_PRICE%7D";

    const response = await fetch(url, {
      headers: ebayHeaders(token)
    });

    if (!response.ok) {
      throw new Error(
        `eBay ${response.status}: ` +
        `${await response.text()}`
      );
    }

    const data = await response.json();

    res.json({
      ...data,
      country,
      items: normalizeEbayItems(data.itemSummaries)
    });
  } catch (e) {
    console.error("catalog/home:", e.message);

    res.status(500).json({
      error: e.message
    });
  }
});

/* =========================
   EBAY SEARCH
========================= */

app.get("/api/catalog/search", async (req, res) => {
  try {
    const token = await getEbayToken();

    const q =
      String(
        req.query.q || "popular products"
      ).trim();

    const limit = Math.min(
      Number(req.query.limit) || 24,
      48
    );

    const offset = Math.max(
      Number(req.query.offset) || 0,
      0
    );

    const url =
      "https://api.ebay.com/buy/browse/v1/item_summary/search" +
      `?q=${encodeURIComponent(q)}` +
      `&limit=${limit}` +
      `&offset=${offset}` +
      "&filter=buyingOptions%3A%7BFIXED_PRICE%7D";

    const response = await fetch(url, {
      headers: ebayHeaders(token)
    });

    if (!response.ok) {
      throw new Error(
        `eBay ${response.status}: ` +
        `${await response.text()}`
      );
    }

    const data = await response.json();

    res.json({
      ...data,
      items: normalizeEbayItems(
        data.itemSummaries
      )
    });
  } catch (e) {
    console.error("catalog/search:", e.message);

    res.status(500).json({
      error: e.message
    });
    /* =========================
   EBAY ITEM
========================= */

app.get("/api/catalog/item", async (req, res) => {
  try {
    const itemId = String(
      req.query.itemId || req.query.id || ""
    ).trim();

    if (!itemId) {
      return res.status(400).json({
        error: "itemId requis"
      });
    }

    const token = await getEbayToken();

    const url =
      "https://api.ebay.com/buy/browse/v1/item/" +
      encodeURIComponent(itemId);

    const response = await fetch(url, {
      headers: ebayHeaders(token)
    });

    if (!response.ok) {
      throw new Error(
        `eBay ${response.status}: ` +
        `${await response.text()}`
      );
    }

    const item = await response.json();

    res.json({
      ...item,
      price: Number(
        (
          Number(item.price?.value || 0) +
          PRICE_MARKUP
        ).toFixed(2)
      ),
      _ebayPrice:
        Number(item.price?.value || 0),
      _markup: PRICE_MARKUP
    });
  } catch (e) {
    console.error("catalog/item:", e.message);

    res.status(500).json({
      error: e.message
    });
  }
});

/* =========================
   ORDER HELPERS
========================= */

function findOrder(orderId) {
  return orders.find(
    o => String(o.orderId) === String(orderId)
  );
}

function calculateOrderTotal(order, language) {
  if (!order) return 0;

  const currency =
    currencyForLanguage(language);

  let total = 0;

  for (const item of order.items || []) {
    const qty = Math.max(
      Number(item.qty) || 1,
      1
    );

    let price =
      Number(item.price) || 0;

    /*
      Le frontend peut envoyer le prix
      eBay déjà augmenté de $6.
      Pour les produits eBay, on conserve
      ce prix affiché.
    */
    total += price * qty;
  }

  return Number(total.toFixed(2));
}

/* =========================
   CREATE ORDER
========================= */

app.post("/api/order", async (req, res) => {
  try {
    const body = req.body || {};

    const orderId =
      String(
        body.orderId ||
        `MERCADO-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`
      );

    const customer = body.customer || {};

    const language =
      String(
        customer.language ||
        body.language ||
        "en"
      ).toLowerCase();

    const currency =
      currencyForLanguage(language);

    if (
      !Array.isArray(body.items) ||
      !body.items.length
    ) {
      return res.status(400).json({
        error: "Aucun produit dans la commande"
      });
    }

    const order = {
      orderId,
      createdAt: new Date().toISOString(),
      status: "pending",
      paymentMethod:
        body.paymentMethod || "gatepay",
      language,
      currency,
      customer: {
        name:
          String(customer.name || "").trim(),
        email:
          String(customer.email || "")
            .trim()
            .toLowerCase(),
        phone:
          String(customer.phone || "").trim(),
        country:
          String(customer.country || "").trim(),
        address:
          String(customer.address || "").trim(),
        city:
          String(customer.city || "").trim(),
        zip:
          String(
            customer.zip ||
            customer.postalCode ||
            ""
          ).trim()
      },
      items: body.items.map(item => ({
        id:
          item.id ||
          item.itemId ||
          "",
        name:
          item.name ||
          item.title ||
          "Product",
        price:
          Number(item.price) || 0,
        qty:
          Math.max(
            Number(item.qty) || 1,
            1
          ),
        image:
          item.image || "",
        url:
          item.url ||
          item.sourceUrl ||
          ""
      }))
    };

    order.total =
      calculateOrderTotal(
        order,
        language
      );

    orders.push(order);

    writeJSON("orders.json", orders);

    /*
      Notification Telegram.
    */
    await notifyTelegram(order);

    /*
      Confirmation email.
    */
    if (order.customer.email) {
      await sendEmail({
        to: order.customer.email,
        subject:
          `MERCADO - Commande ${order.orderId}`,
        text:
          `Merci pour votre commande ${order.orderId}. ` +
          `Total: ${order.total} ${order.currency}.`,
        html:
          `<div style="font-family:Arial">` +
          `<h2>MERCADO</h2>` +
          `<p>Merci pour votre commande.</p>` +
          `<p><b>Commande:</b> ${order.orderId}</p>` +
          `<p><b>Total:</b> ${order.total} ${order.currency}</p>` +
          `</div>`
      });
    }

    res.json({
      ok: true,
      orderId: order.orderId,
      total: order.total,
      currency: order.currency
    });
  } catch (e) {
    console.error("order:", e.message);

    res.status(500).json({
      error: e.message
    });
  }
});

/* =========================
   TELEGRAM
========================= */

async function notifyTelegram(order) {
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN;

  const chatId =
    process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    return false;
  }

  let message =
    `🛒 *NOUVELLE COMMANDE MERCADO*\n\n` +
    `*ID:* ${order.orderId}\n` +
    `*Paiement:* ${order.paymentMethod}\n` +
    `*Total:* ${order.total} ${order.currency}\n\n` +
    `👤 *Client*\n` +
    `Nom: ${order.customer.name || "-"}\n` +
    `Email: ${order.customer.email || "-"}\n` +
    `Téléphone: ${order.customer.phone || "-"}\n` +
    `Pays: ${order.customer.country || "-"}\n` +
    `Adresse: ${order.customer.address || "-"}\n` +
    `Ville: ${order.customer.city || "-"}\n` +
    `ZIP: ${order.customer.zip || "-"}\n\n` +
    `📦 *Produits*\n`;

  for (const item of order.items || []) {
    message +=
      `• ${item.name}\n` +
      `  ${item.qty} × ${item.price} ${order.currency}\n`;

    if (item.url) {
      message += `  ${item.url}\n`;
    }
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "Markdown",
          disable_web_page_preview: false
        })
      }
    );

    return response.ok;
  } catch (e) {
    console.error(
      "Telegram:",
      e.message
    );

    return false;
  }
}

/* =========================
   GATEPAY
========================= */

async function createGatePayPayment(req, res) {
  try {
    if (!GATEPAY_WALLET) {
      return res.status(500).json({
        error:
          "GATEPAY_WALLET_ADDRESS non configurée"
      });
    }

    const orderId =
      String(
        req.body?.orderId ||
        req.query?.orderId ||
        ""
      ).trim();

    if (!orderId) {
      return res.status(400).json({
        error: "orderId requis"
      });
    }

    const order =
      findOrder(orderId);

    if (!order) {
      return res.status(404).json({
        error: "Commande introuvable"
      });
    }

    const language =
      String(
        order.language ||
        order.customer?.
        /* =========================
   REVIEWS
========================= */

app.get("/api/reviews", (req, res) => {
  const productId = String(
    req.query.productId ||
    req.query.product ||
    ""
  ).trim();

  if (!productId) {
    return res.json({
      reviews
    });
  }

  res.json({
    reviews: reviews.filter(
      r =>
        String(
          r.productId ||
          r.product ||
          ""
        ) === productId
    )
  });
});

app.post("/api/reviews", (req, res) => {
  try {
    const body = req.body || {};

    const review = {
      id:
        crypto.randomBytes(8)
          .toString("hex"),
      productId:
        String(
          body.productId ||
          body.product ||
          ""
        ).trim(),
      name:
        String(
          body.name || "Customer"
        ).trim(),
      email:
        String(
          body.email || ""
        ).trim().toLowerCase(),
      rating: Math.min(
        Math.max(
          Number(body.rating) || 5,
          1
        ),
        5
      ),
      text:
        String(
          body.text ||
          body.comment ||
          ""
        ).trim(),
      createdAt:
        new Date().toISOString()
    };

    if (!review.productId) {
      return res.status(400).json({
        error: "productId requis"
      });
    }

    if (!review.text) {
      return res.status(400).json({
        error: "Avis vide"
      });
    }

    reviews.push(review);

    /*
      Limite pour éviter un fichier
      reviews.json trop volumineux.
    */
    if (reviews.length > 5000) {
      reviews.splice(
        0,
        reviews.length - 5000
      );
    }

    writeJSON(
      "reviews.json",
      reviews
    );

    res.json({
      ok: true,
      review
    });
  } catch (e) {
    console.error(
      "reviews:",
      e.message
    );

    res.status(500).json({
      error: e.message
    });
  }
});

/* =========================
   AVAILABILITY NOTIFICATION
========================= */

app.post(
  "/api/notify/subscribe",
  (req, res) => {
    try {
      const email = String(
        req.body.email || ""
      ).trim().toLowerCase();

      const query = String(
        req.body.query || ""
      ).trim();

      if (
        !email ||
        !email.includes("@")
      ) {
        return res.status(400).json({
          error: "Email invalide"
        });
      }

      const exists =
        subscribers.some(
          s =>
            s.email === email &&
            s.query === query
        );

      if (!exists) {
        subscribers.push({
          email,
          query,
          createdAt:
            new Date().toISOString()
        });

        if (
          subscribers.length > 5000
        ) {
          subscribers.splice(
            0,
            subscribers.length - 5000
          );
        }

        writeJSON(
          "subscribers.json",
          subscribers
        );
      }

      res.json({
        ok: true
      });
    } catch (e) {
      console.error(
        "subscribe:",
        e.message
      );

      res.status(500).json({
        error: e.message
      });
    }
  }
);

/* =========================
   PRODUCT VIEW TRACKING
========================= */

app.post(
  "/api/track-view",
  (req, res) => {
    try {
      const body = req.body || {};

      const email = String(
        body.email || ""
      ).trim().toLowerCase();

      const product =
        body.product || {};

      if (
        !email ||
        !email.includes("@")
      ) {
        return res.status(400).json({
          error: "Email invalide"
        });
      }

      const entry = {
        id:
          crypto.randomBytes(8)
            .toString("hex"),
        email,
        product: {
          id:
            product.id ||
            product.itemId ||
            "",
          name:
            product.name ||
            product.title ||
            "Product",
          price:
            Number(product.price) || 0,
          image:
            product.image || "",
          url:
            product.url || ""
        },
        viewedAt:
          new Date().toISOString(),
        reminded: false
      };

      productViews.push(entry);

      if (
        productViews.length > 500
      ) {
        productViews.splice(
          0,
          productViews.length - 500
        );
      }

      writeJSON(
        "product-views.json",
        productViews
      );

      res.json({
        ok: true
      });
    } catch (e) {
      console.error(
        "track-view:",
        e.message
      );

      res.status(500).json({
        error: e.message
      });
    }
  }
);

/* =========================
   AI
========================= */

app.post("/api/ai", async (req, res) => {
  try {
    const apiKey =
      process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        error:
          "OPENAI_API_KEY non configurée"
      });
    }

    const body = req.body || {};

    const question =
      String(
        body.question || ""
      ).trim();

    if (!question) {
      return res.status(400).json({
        error: "Question requise"
      });
    }

    const history =
      Array.isArray(body.history)
        ? body.history.slice(-10)
        : [];

    const product =
      body.product || null;

    const language =
      String(
        body.language || "en"
      );

    const system =
      `You are MERCADO shopping assistant. ` +
      `Help customers understand products, ` +
      `prices and shopping information. ` +
      `Answer in ${language}. ` +
      `Do not invent product specifications.`;

    const messages = [
      {
        role: "system",
        content: system
      },
      ...history
        .filter(
          x =>
            x &&
            (x.role === "user" ||
              x.role === "assistant")
        )
        .map(x => ({
          role: x.role,
          content: String(
            x.content || ""
          )
        })),
      {
        role: "user",
        content:
          product
            ? `Product context:\n${JSON.stringify(
                product
              )}\n\nQuestion:\n${question}`
            : question
      }
    ];

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${apiKey}`,
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          model:
            process.env.OPENAI_MODEL ||
            "gpt-4o-mini",
          messages,
          temperature: 0.3,
          max_tokens: 700
        })
      }
    );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error?.message ||
        `OpenAI ${response.status}`
      );
    }

    const answer =
      data.choices?.[0]?.message?.content ||
      "";

    res.json({
      ok: true,
      answer
    });
  } catch (e) {
    console.error(
      "AI:",
      e.message
    );

    res.status(500).json({
      error: e.message
    });
  }
});

/* =========================
   AI LOG
========================= */

app.post(
  "/api/ai-log",
  (req, res) => {
    try {
      const file =
        dataFile("ai-log.json");

      let logs = [];

      if (fs.existsSync(file)) {
        try {
          logs = JSON.parse(
            fs.readFileSync(
              file,
              "utf8"
            )
          );
        } catch {
          logs = [];
        }
      }

      logs.push({
        ...req.body,
        createdAt:
          new Date().toISOString()
      });

      if (logs.length > 2000) {
        logs = logs.slice(-2000);
      }

      fs.writeFileSync(
        file,
        JSON.stringify(
          logs,
          null,
          2
        )
      );

      res.json({
        ok: true
      });
    } catch (e) {
      console.error(
        "ai-log:",
        e.message
      );

      res.status(500).json({
        error: e.message
      });
    }
  }
);

/* =========================
   TRANSLATION
========================= */

app.post(
  "/api/translate",
  async (req, res) => {
    try {
      const apiKey =
        process.env.OPENAI_API_KEY;

      if (!apiKey) {
        return res.status(503).json({
          error:
            "OPENAI_API_KEY non configurée"
        });
      }

      const target =
        String(
          req.body.target || "en"
        );

      const texts =
        Array.isArray(req.body.texts)
          ? req.body.texts
          : [];

      if (!texts.length) {
        return res.json({
          translations: []
        });
      }

      const prompt =
        `Translate the following texts to language ${target}. ` +
        `Return ONLY a JSON array of translated strings, ` +
        `in exactly the same order.\n\n` +
        JSON.stringify(texts);

      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization:
              `Bearer ${apiKey}`,
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            model:
              process.env.OPENAI_MODEL ||
              "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content:
                  "You are a translation API."
              },
              {
                role: "user",
                content: prompt
              }
            ],
            temperature: 0,
            max_tokens: 3000
          })
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error?.message ||
          `OpenAI ${response.status}`
        );
      }

      const content =
        data.choices?.[0]?.message?.content ||
        "[]";

      let translations;

      try {
        translations =
          JSON.parse(content);
      } catch {
        const cleaned =
          content
            .replace(/^```json/i, "")
            .replace(/^```/, "")
            .replace(/```$/, "")
            .trim();

        translations =
          JSON.parse(cleaned);
      }

      if (
        !Array.isArray(
          translations
        )
      ) {
        throw new Error(
          "Réponse de traduction invalide"
        );
      }

      res.json({
        translations
      });
    } catch (e) {
      console.error(
        "translate:",
        e.message
      );

      res.status(500).json({
        error: e.message
      });
    }
  }
);

/* =========================
   ADMIN AUTH
========================= */

function adminAuthorized(req) {
  const key =
    process.env.ADMIN_KEY;

  if (!key) return false;

  const supplied =
    req.headers["x-admin-key"] ||
    req.headers["authorization"] ||
    "";

  return String(
    supplied
  ).replace(/^Bearer\s+/i, "") === key;
}

/* =========================
   ADMIN ORDERS
========================= */

app.get(
  "/api/admin/orders",
  (req, res) => {
    if (!adminAuthorized(req)) {
      return res.status(401).json({
        error: "Non autorisé"
      });
    }

    res.json({
      orders
    });
  }
);

/* =========================
   ADMIN NOTIFICATION
========================= */

app.post(
  "/api/admin/notify-broadcast",
  async (req, res) => {
    if (!adminAuthorized(req)) {
      return res.status(401).json({
        error: "Non autorisé"
      });
    }

    const message = String(
      req.body.message || ""
    ).trim();

    if (!message) {
      return res.status(400).json({
        error: "Message requis"
      });
    }

    const botToken =
      process.env.TELEGRAM_BOT_TOKEN;

    const
    
  }
});
/* =========================
   ADMIN RUN REMINDERS
========================= */

async function runReminders() {
  const delayHours =
    Number(
      process.env.REMINDER_DELAY_HOURS || 24
    );

  const cutoff =
    Date.now() -
    delayHours * 60 * 60 * 1000;

  let sentCount = 0;

  for (const view of productViews) {
    if (view.reminded) continue;

    const viewedAt =
      new Date(view.viewedAt).getTime();

    if (
      !viewedAt ||
      viewedAt > cutoff
    ) {
      continue;
    }

    if (
      !view.email ||
      !view.product
    ) {
      view.reminded = true;
      continue;
    }

    const product =
      view.product;

    const sent =
      await sendEmail({
        to: view.email,
        subject:
          `Toujours intéressé(e) par ${product.name} ?`,
        text:
          `Vous avez récemment consulté ` +
          `${product.name} sur MERCADO.\n\n` +
          `Prix: ${product.price}\n` +
          `${product.url || ""}`,
        html:
          `<div style="font-family:Arial">` +
          `<h2>MERCADO</h2>` +
          `<p>Vous avez récemment consulté :</p>` +
          `<h3>${escapeHtml(
            product.name
          )}</h3>` +
          `<p>Prix : ${escapeHtml(
            String(product.price)
          )}</p>` +
          (
            product.image
              ? `<img src="${escapeHtml(
                  product.image
                )}" ` +
                `style="max-width:300px">`
              : ""
          ) +
          (
            product.url
              ? `<p><a href="${escapeHtml(
                  product.url
                )}">Voir le produit</a></p>`
              : ""
          ) +
          `</div>`
      });

    /*
      On marque comme traité uniquement
      lorsque l'envoi a réussi.
    */
    if (sent) {
      view.reminded = true;
      sentCount++;
    }
  }

  writeJSON(
    "product-views.json",
    productViews
  );

  return sentCount;
}

app.post(
  "/api/admin/run-reminders",
  async (req, res) => {
    if (!adminAuthorized(req)) {
      return res.status(401).json({
        error: "Non autorisé"
      });
    }

    try {
      const sent =
        await runReminders();

      res.json({
        ok: true,
        sent
      });
    } catch (e) {
      console.error(
        "run-reminders:",
        e.message
      );

      res.status(500).json({
        error: e.message
      });
    }
  }
);

/* =========================
   HTML ESCAPE
========================= */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* =========================
   AUTOMATIC REMINDERS
========================= */

setInterval(
  async () => {
    try {
      if (
        !process.env.RESEND_API_KEY &&
        !mailTransporter
      ) {
        return;
      }

      await runReminders();
    } catch (e) {
      console.error(
        "Automatic reminders:",
        e.message
      );
    }
  },
  30 * 60 * 1000
);

/* =========================
   CUSTOMER PURCHASE TRACKING
========================= */

function markPurchasedProducts(order) {
  if (!order || !Array.isArray(order.items)) {
    return;
  }

  for (const view of productViews) {
    const viewedId =
      String(
        view.product?.id || ""
      );

    if (!view.email) continue;

    if (
      String(
        order.customer?.email || ""
      ).toLowerCase() !==
      String(view.email).toLowerCase()
    ) {
      continue;
    }

    const purchased =
      order.items.some(item =>
        String(
          item.id || ""
        ) === viewedId
      );

    if (purchased) {
      view.reminded = true;
    }
  }

  writeJSON(
    "product-views.json",
    productViews
  );
}

/* =========================
   PAYMENT STATUS
========================= */

app.get(
  "/api/payment/status",
  (req, res) => {
    const orderId = String(
      req.query.orderId || ""
    ).trim();

    if (!orderId) {
      return res.status(400).json({
        error: "orderId requis"
      });
    }

    const order =
      findOrder(orderId);

    if (!order) {
      return res.status(404).json({
        error: "Commande introuvable"
      });
    }

    res.json({
      ok: true,
      orderId: order.orderId,
      status:
        order.status || "pending",
      payment:
        order.payment || null,
      paidAt:
        order.paidAt || null
    });
  }
);

/* =========================
   UPDATE PAYMENT ORDER
========================= */

app.post(
  "/api/payment/confirm",
  async (req, res) => {
    if (!adminAuthorized(req)) {
      return res.status(401).json({
        error: "Non autorisé"
      });
    }

    const orderId = String(
      req.body.orderId || ""
    ).trim();

    const order =
      findOrder(orderId);

    if (!order) {
      return res.status(404).json({
        error: "Commande introuvable"
      });
    }

    order.status = "paid";
    order.paidAt =
      new Date().toISOString();

    writeJSON(
      "orders.json",
      orders
    );

    markPurchasedProducts(order);

    res.json({
      ok: true,
      orderId,
      status: order.status
    });
  }
);

/* =========================
   CUSTOMER INFORMATION
========================= */

app.get(
  "/api/order/:orderId",
  (req, res) => {
    const order =
      findOrder(
        req.params.orderId
      );

    if (!order) {
      return res.status(404).json({
        error: "Commande introuvable"
      });
    }

    /*
      Ne pas exposer les informations
      sensibles du client publiquement.
    */
    res.json({
      ok: true,
      orderId: order.orderId,
      status:
        order.status || "pending",
      total: order.total,
      currency: order.currency,
      paymentMethod:
        order.paymentMethod,
      createdAt:
        order.createdAt,
      items: order.items
    });
  }
);

/* =========================
   ERROR HANDLER
========================= */

app.use(
  (err, req, res, next) => {
    console.error(
      "SERVER ERROR:",
      err
    );

    if (res.headersSent) {
      return next(err);
    }

    res.status(500).json({
      error:
        "Erreur interne du serveur"
    });
  }
);

/* =========================
   STATIC FRONTEND
========================= */

if (fs.existsSync(PUBLIC_DIR)) {
  app.use(
    express.static(
      PUBLIC_DIR,
      {
        etag: false,
        maxAge: 0,
        setHeaders: (res) => {
          res.setHeader(
            "Cache-Control",
            "no-store, no-cache, " +
            "must-revalidate, proxy-revalidate"
          );

          res.setHeader(
            "Pragma",
            "no-cache"
          );

          res.setHeader(
            "Expires",
            "0"
          );
        }
      }
    )
  );
}

/* =========================
   SPA FALLBACK
========================= */

app.get(
  "*",
  (req, res) => {
    if (
      req.path.startsWith("/api/")
    ) {
      return res.status(404).json({
        error: "API route not found"
      });
    }

    const indexFile =
      path.join(
        PUBLIC_DIR,
        "index.html"
      );

    if (fs.existsSync(indexFile)) {
      return res.sendFile(
        indexFile
      );
    }

    res.status(404).send(
      "MERCADO frontend not found"
    );
  }
);
    /* =========================
   START SERVER
========================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `MERCADO server running on port ${PORT}`
  );

  console.log(
    `Public URL: ${PUBLIC_BASE_URL}`
  );

  console.log(
    `Payment: GatePay.to`
  );

  console.log(
    `GatePay configured: ${Boolean(
      GATEPAY_WALLET
    )}`
  );

  console.log(
    `Price markup: +${PRICE_MARKUP}`
  );
});
    
