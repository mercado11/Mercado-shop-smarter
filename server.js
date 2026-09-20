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
const GATEPAY_CURRENCY = process.env.GATEPAY_CURRENCY || "EUR";

/*
  IMPORTANT:
  PRICE_MARKUP is applied ONLY on the server.
  The customer sees only the final price.
*/
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

/* =========================================================
   HEALTH / CONFIG
========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "MERCADO",
    payment: "GatePay.to",
    currency: GATEPAY_CURRENCY,
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
    currency: GATEPAY_CURRENCY
  });
});

/* =========================================================
   EMAIL
========================================================= */

let mailTransporter = null;

if (
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
) {
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
          from:
            process.env.RESEND_FROM ||
            "MERCADO <onboarding@resend.dev>",
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

/* =========================================================
   EMAIL VERIFICATION
========================================================= */

const emailCodes = new Map();

app.post("/api/email/send", async (req, res) => {
  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();

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
  const email = String(req.body.email || "")
    .trim()
    .toLowerCase();

  const code = String(req.body.code || "").trim();

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

/* =========================================================
   LOCAL PRODUCTS
========================================================= */

app.get("/api/products", (req, res) => {
  res.json({
    products
  });
});

/* =========================================================
   EBAY
========================================================= */

let ebayToken = null;
let ebayTokenExpires = 0;

async function getEbayToken() {
  if (
    ebayToken &&
    Date.now() < ebayTokenExpires
  ) {
    return ebayToken;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "EBAY_CLIENT_ID / EBAY_CLIENT_SECRET manquants"
    );
  }

  const sandbox =
    String(
      process.env.EBAY_ENVIRONMENT || "production"
    ).toLowerCase() === "sandbox";

  const tokenUrl = sandbox
    ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
    : "https://api.ebay.com/identity/v1/oauth2/token";

  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type":
        "application/x-www-form-urlencoded"
    },
    body:
      "grant_type=client_credentials&scope=" +
      encodeURIComponent(
        "https://api.ebay.com/oauth/api_scope"
      )
  });

  const data = await r.json();

  if (!r.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
      "Impossible d'obtenir le token eBay"
    );
  }

  ebayToken = data.access_token;

  ebayTokenExpires =
    Date.now() +
    ((Number(data.expires_in) || 7200) - 120) *
      1000;

  return ebayToken;
}

function ebayBase() {
  return String(
    process.env.EBAY_ENVIRONMENT ||
    "production"
  ).toLowerCase() === "sandbox"
    ? "https://api.sandbox.ebay.com"
    : "https://api.ebay.com";
}

function marketplaceId(country) {
  const c = String(country || "US").toUpperCase();

  return (
    {
      US: "EBAY_US",
      GB: "EBAY_GB",
      FR: "EBAY_FR",
      DE: "EBAY_DE",
      IT: "EBAY_IT",
      ES: "EBAY_ES",
      CA: "EBAY_CA",
      AU: "EBAY_AU"
    }[c] || "EBAY_US"
  );
}

/*
  eBay base price -> MERCADO customer price.
*/
function mercadoPrice(basePrice) {
  return (
    Math.max(0, Number(basePrice) || 0) +
    PRICE_MARKUP
  );
}

function normalizeEbayItems(items) {
  return items.map((x) => {
    const ebayPrice =
      Number(x.price?.value) || 0;

    const salePrice =
      mercadoPrice(ebayPrice);

    return {
      id: x.itemId,
      itemId: x.itemId,

      name:
        x.title ||
        "Produit MERCADO",

      title:
        x.title ||
        "Produit MERCADO",

      category:
        x.categories?.[0]?.categoryName ||
        "General",

      cat:
        x.categories?.[0]?.categoryName ||
        "General",

      price:
        Number(salePrice.toFixed(2)),

      rating:
        Number(
          x.reviews?.averageRating ||
          x.rating ||
          0
        ),

      sold:
        Number(x.quantitySold || 0),

      image:
        x.image?.imageUrl ||
        x.thumbnailImages?.[0]?.imageUrl ||
        "",

      imageUrl:
        x.image?.imageUrl || "",

      thumbnail:
        x.thumbnailImages?.[0]?.imageUrl ||
        "",

      description:
        x.shortDescription || "",

      desc:
        x.shortDescription || "",

      itemUrl:
        x.itemWebUrl || "",

      url:
        x.itemWebUrl || "",

      _ebayPrice:
        Number(ebayPrice.toFixed(2)),

      _markup:
        PRICE_MARKUP
    };
  });
}

async function ebaySearch({
  q,
  limit,
  offset,
  country
}) {
  const token = await getEbayToken();

  const safeLimit = Math.min(
    Math.max(Number(limit) || 48, 1),
    100
  );

  const safeOffset =
    Math.max(Number(offset) || 0, 0);

  const params = new URLSearchParams({
    q: q || "popular products",
    limit: String(safeLimit),
    offset: String(safeOffset),
    filter:
      "buyingOptions:{FIXED_PRICE}",
    fieldgroups: "EXTENDED",
    sort: "BEST_MATCH"
  });

  const r = await fetch(
    ebayBase() +
      "/buy/browse/v1/item_summary/search?" +
      params.toString(),
    {
      headers: {
        Authorization:
          `Bearer ${token}`,

        "X-EBAY-C-MARKETPLACE-ID":
          marketplaceId(country)
      }
    }
  );

  const data = await r.json();

  if (!r.ok) {
    const err = new Error(
      data?.errors?.[0]?.message ||
      "Erreur eBay"
    );

    err.status = r.status;

    throw err;
  }

  return {
    total:
      Number(data.total) || 0,

    next:
      data.next || null,

    items:
      normalizeEbayItems(
        data.itemSummaries || []
      )
  };
}

/* =========================================================
   CATALOG
========================================================= */

app.get("/api/catalog/home", async (req, res) => {
  try {
    const result = await ebaySearch({
      q: "popular products",
      limit: req.query.limit || 48,
      offset: req.query.offset || 0,
      country: req.query.country || "US"
    });

    res.json(result);
  } catch (e) {
    console.error("catalog/home:", e.message);

    res.status(e.status || 500).json({
      error: e.message
    });
  }
});

app.get("/api/catalog/search", async (req, res) => {
  try {
    const q =
      String(req.query.q || "").trim() ||
      "popular products";

    const result = await ebaySearch({
      q,
      limit: req.query.limit || 48,
      offset: req.query.offset || 0,
      country: req.query.country || "US"
    });

    res.json(result);
  } catch (e) {
    console.error("catalog/search:", e.message);

    res.status(e.status || 500).json({
      error: e.message
    });
  }
});

/* =========================================================
   ORDER
========================================================= */

function createOrderRecord(input) {
  const orderId =
    String(
      input.orderId ||
      `MERCADO-${Date.now()}-${crypto
        .randomBytes(3)
        .toString("hex")}`
    ).slice(0, 120);

  const total =
    Number(input.total) || 0;

  return {
    orderId,

    visitorId:
      String(input.visitorId || "").slice(0, 200),

    items:
      Array.isArray(input.items)
        ? input.items
        : [],

    customer:
      input.customer || {},

    paymentMethod:
      input.paymentMethod ||
      "GatePay.to",

    total:
      Number(total.toFixed(2)),

    paymentStatus:
      input.paymentStatus ||
      "pending",

    createdAt:
      new Date().toISOString(),

    updatedAt:
      new Date().toISOString()
  };
}

app.post("/api/order", async (req, res) => {
  try {
    const order =
      createOrderRecord(req.body || {});

    const existing =
      orders.find(
        (x) => x.orderId === order.orderId
      );

    if (existing) {
      Object.assign(existing, order);
    } else {
      orders.push(order);
    }

    if (orders.length > 2000) {
      orders.splice(
        0,
        orders.length - 2000
      );
    }

    writeJSON(
      "orders.json",
      orders
    );

    res.json({
      ok: true,
      order
    });
  } catch (e) {
    console.error("order:", e.message);

    res.status(500).json({
      error: "Impossible d'enregistrer la commande"
    });
  }
});

/* =========================================================
   GATEPAY.TO
========================================================= */

app.post("/api/payment/gatepay", async (req, res) => {
  try {
    const wallet =
      String(
        process.env.GATEPAY_WALLET_ADDRESS ||
        GATEPAY_WALLET
      ).trim();

    if (!wallet) {
      return res.status(500).json({
        ok: false,
        error:
          "GATEPAY_WALLET_ADDRESS non configuré dans Render"
      });
    }

    const total =
      Number(req.body?.amount ?? req.body?.total);

    if (
      !Number.isFinite(total) ||
      total <= 0
    ) {
      return res.status(400).json({
        ok: false,
        error: "Montant invalide"
      });
    }

    const email =
      String(
        req.body?.email ||
        req.body?.customer?.email ||
        ""
      )
        .trim()
        .toLowerCase();

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        ok: false,
        error:
          "Email client obligatoire"
      });
    }

    const orderId =
      String(
        req.body?.orderId ||
        `MERCADO-${Date.now()}-${crypto
          .randomBytes(3)
          .toString("hex")}`
      ).slice(0, 120);

    const currency =
      String(
        req.body?.currency ||
        GATEPAY_CURRENCY ||
        "EUR"
      )
        .trim()
        .toUpperCase();

    const callbackUrl =
      `${PUBLIC_BASE_URL}/api/payment/gatepay/callback`;

    const payload = {
      wallet,
      amount:
        Number(total.toFixed(2)),
      currency,
      email,
      order_id: orderId,
      callback_url: callbackUrl
    };

    console.log(
      "Creating GatePay payment:",
      {
        orderId,
        amount: payload.amount,
        currency: payload.currency,
        email
      }
    );

    const response = await fetch(
      GATEPAY_API,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Accept:
            "application/json"
        },

        body:
          JSON.stringify(payload)
      }
    );

    const raw =
      await response.text();

    let data = {};

    try {
      data =
        raw
          ? JSON.parse(raw)
          : {};
    } catch {
      data = {
        raw
      };
    }

    if (!response.ok) {
      console.error(
        "GatePay create error:",
        response.status,
        data
      );

      return res.status(502).json({
        ok: false,
        error:
          data?.message ||
          data?.error ||
          "GatePay a refusé la création du paiement"
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
      console.error(
        "GatePay response sans checkout URL:",
        data
      );

      return res.status(502).json({
        ok: false,
        error:
          "GatePay n’a pas retourné d’URL de paiement"
      });
    }

    const existing =
      orders.find(
        (o) =>
          o.orderId === orderId
      );

    const record = {
      ...(existing || {}),

      orderId,

      total:
        Number(total.toFixed(2)),

      currency,

      paymentMethod:
        "GatePay.to",

      paymentStatus:
        existing?.paymentStatus ||
        "pending",

      paymentUrl,

      gatepayOrderId:
        data?.order_id ||
        data?.id ||
        data?.data?.order_id ||
        data?.data?.id ||
        null,

      customer:
        req.body?.customer ||
        existing?.customer ||
        {
          email
        },

      callbackUrl,

      createdAt:
        existing?.createdAt ||
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString()
    };

    if (existing) {
      Object.assign(
        existing,
        record
      );
    } else {
      orders.push(record);
    }

    if (orders.length > 2000) {
      orders.splice(
        0,
        orders.length - 2000
      );
    }

    writeJSON(
      "orders.json",
      orders
    );

    res.json({
      ok: true,

      order_id:
        orderId,

      payment_url:
        paymentUrl,

      checkout_url:
        paymentUrl,

      gatepay_order_id:
        record.gatepayOrderId
    });
  } catch (e) {
    console.error(
      "GatePay payment error:",
      e.message
    );

    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

/* =========================================================
   GATEPAY CALLBACK
========================================================= */

app.all(
  "/api/payment/gatepay/callback",
  (req, res) => {
    try {
      const body =
        req.body &&
        typeof req.body === "object"
          ? req.body
          : {};

      const query =
        req.query &&
        typeof req.query === "object"
          ? req.query
          : {};

      const data = {
        ...query,
        ...body
      };

      console.log(
        "GatePay callback:",
        JSON.stringify(data)
      );

      const orderId =
        String(
          data.order_id ||
          data.orderId ||
          data.reference ||
          ""
        ).trim();

      if (orderId) {
        const order =
          orders.find(
            (o) =>
              o.orderId === orderId
          );

        if (order) {
          const status =
            String(
              data.status ||
              data.payment_status ||
              data.paymentStatus ||
              ""
            ).toLowerCase();

          if (
            status === "paid" ||
            status === "completed" ||
            status === "success" ||
            status === "successful"
          ) {
            order.paymentStatus =
              "paid";
          } else if (
            status === "failed" ||
            status === "cancelled" ||
            status === "canceled" ||
            status === "expired"
          ) {
            order.paymentStatus =
              status === "expired"
                ? "expired"
                : "failed";
          }

          order.updatedAt =
            new Date().toISOString();

          order.gatepayCallback =
            data;

          writeJSON(
            "orders.json",
            orders
          );
        }
      }

      res.status(200).json({
        ok: true
      });
    } catch (e) {
      console.error(
        "GatePay callback:",
        e.message
      );

      res.status(200).json({
        ok: true
      });
    }
  }
);

/* =========================================================
   REVIEWS
========================================================= */

app.get("/api/reviews", (req, res) => {
  const productId =
    String(
      req.query.productId || ""
    ).trim();

  if (!productId) {
    return res.json({
      reviews
    });
  }

  res.json({
    reviews:
      reviews.filter(
        (r) =>
          String(r.productId) ===
          productId
      )
  });
});

app.post("/api/reviews", (req, res) => {
  const productId =
    String(
      req.body.productId || ""
    ).trim();

  const text =
    String(
      req.body.text || ""
    ).trim();

  const stars =
    Number(req.body.stars);

  if (
    !productId ||
    !text ||
    !Number.isInteger(stars) ||
    stars < 1 ||
    stars > 5
  ) {
    return res.status(400).json({
      error: "Avis invalide"
    });
  }

  const review = {
    id: crypto.randomUUID(),

    productId,

    name:
      String(
        req.body.name ||
        "Client"
      ).slice(0, 80),

    initial:
      String(
        req.body.initial ||
        "C"
      ).slice(0, 1),

    stars,

    date:
      req.body.date ||
      new Date().toLocaleDateString(
        "fr-FR"
      ),

    text:
      text.slice(0, 2000),

    variant:
      String(
        req.body.variant || ""
      ).slice(0, 200)
  };

  reviews.push(review);

  writeJSON(
    "reviews.json",
    reviews
  );

  res.json({
    ok: true,
    review
  });
});

/* =========================================================
   NOTIFICATIONS
========================================================= */

app.post(
  "/api/notify/subscribe",
  (req, res) => {
    const email =
      String(
        req.body.email || ""
      )
        .trim()
        .toLowerCase();

    const query =
      String(
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

    subscribers.push({
      id: crypto.randomUUID(),
      email,
      query,
      createdAt:
        new Date().toISOString()
    });

    if (subscribers.length > 1000) {
      subscribers.splice(
        0,
        subscribers.length - 1000
      );
    }

    writeJSON(
      "subscribers.json",
      subscribers
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   PRODUCT VIEWS
========================================================= */

app.post(
  "/api/track-view",
  (req, res) => {
    const email =
      String(
        req.body.email || ""
      )
        .trim()
        .toLowerCase();

    const product =
      req.body.product || {};

    if (
      !email ||
      !email.includes("@") ||
      !product.id
    ) {
      return res.status(400).json({
        error: "Données invalides"
      });
    }

    productViews.push({
      id: crypto.randomUUID(),

      email,

      product,

      viewedAt:
        new Date().toISOString(),

      reminded: false
    });

    if (productViews.length > 500) {
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
  }
);

/* =========================================================
   TELEGRAM
========================================================= */

async function notifyTelegram(message) {
  const token =
    process.env.TELEGRAM_BOT_TOKEN;

  const chatId =
    process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return false;
  }

  try {
    const r = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            chat_id: chatId,
            text: message
          })
      }
    );

    return r.ok;
  } catch (e) {
    console.error(
      "Telegram:",
      e.message
    );

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
    `Total: €${Number(
      order.total || 0
    ).toFixed(2)}`,
    "",
    "CLIENT"
  ];

  const c =
    order.customer || {};

  lines.push(
    `Nom: ${c.name || ""}`
  );

  lines.push(
    `Email: ${c.email || ""}`
  );

  lines.push(
    `Téléphone: ${c.phone || ""}`
  );

  lines.push(
    `Adresse: ${c.address || ""}`
  );

  lines.push("");

  lines.push(
    "PRODUITS"
  );

  for (
    const item of order.items || []
  ) {
    lines.push(
      `• ${item.name || "Produit"} × ${
        item.qty || 1
      } — €${Number(
        item.price || 0
      ).toFixed(2)}`
    );
  }

  return lines.join("\n");
}

/* =========================================================
   ADMIN
========================================================= */

function adminAuthorized(req) {
  const key =
    process.env.ADMIN_KEY;

  return Boolean(
    key &&
    req.headers["x-admin-key"] ===
      key
  );
}

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

/* =========================================================
   AI
========================================================= */

app.post(
  "/api/ai",
  async (req, res) => {
    const apiKey =
      process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        error:
          "AI backend non configuré"
      });
    }

    try {
      const question =
        String(
          req.body.question || ""
        ).trim();

      const history =
        Array.isArray(
          req.body.history
        )
          ? req.body.history.slice(-10)
          : [];

      const product =
        req.body.product ||
        null;

      const messages = [
        {
          role: "system",
          content:
            "Tu es MERCADO AI, assistant du site e-commerce MERCADO. " +
            "Réponds clairement et utilement. " +
            "Le paiement disponible est GatePay.to."
        },

        ...history,

        {
          role: "user",
          content:
            `Produit actuel:\n${JSON.stringify(
              product
            )}\n\nQuestion:\n${question}`
        }
      ];

      const r = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${apiKey}`,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              model:
                process.env.OPENAI_MODEL ||
                "gpt-4o-mini",

              messages,

              temperature: 0.4,

              max_tokens: 800
            })
        }
      );

      const data =
        await r.json();

      if (!r.ok) {
        return res.status(502).json({
          error:
            "AI indisponible"
        });
      }

      res.json({
        answer:
          data.choices?.[0]?.message
            ?.content ||
          "Je n'ai pas pu répondre."
      });
    } catch (e) {
      console.error(
        "AI:",
        e.message
      );

      res.status(500).json({
        error: "Erreur AI"
      });
    }
  }
);

app.post(
  "/api/ai-log",
  (req, res) => {
    res.json({
      ok: true
    });
  }
);

/* =========================================================
   TRANSLATE
========================================================= */

app.post(
  "/api/translate",
  async (req, res) => {
    const texts =
      Array.isArray(
        req.body.texts
      )
        ? req.body.texts
        : [];

    const target =
      String(
        req.body.target ||
        "en"
      );

    if (
      !texts.length ||
      !process.env.OPENAI_API_KEY
    ) {
      return res.json({
        translations: texts
      });
    }

    try {
      const r = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${process.env.OPENAI_API_KEY}`,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              model:
                process.env.OPENAI_MODEL ||
                "gpt-4o-mini",

              messages: [
                {
                  role: "user",

                  content:
                    `Translate each text to ${target}. ` +
                    `Return ONLY a JSON array of translated strings.\n` +
                    JSON.stringify(texts)
                }
              ],

              temperature: 0
            })
        }
      );

      const data =
        await r.json();

      const content =
        data.choices?.[0]?.message
          ?.content || "";

      let translations;

      try {
        translations =
          JSON.parse(
            content
              .replace(
                /^```json/i,
                ""
              )
              .replace(
                /```$/,
                ""
              )
              .trim()
          );
      } catch {
        translations = texts;
      }

      res.json({
        translations
      });
    } catch {
      res.json({
        translations: texts
      });
    }
  }
);

/* =========================================================
   ADMIN REMINDERS
========================================================= */

app.post(
  "/api/admin/run-reminders",
  async (req, res) => {
    if (!adminAuthorized(req)) {
      return res.status(401).json({
        error: "Non autorisé"
      });
    }

    const delayHours =
      Number(
        process.env.REMINDER_DELAY_HOURS ||
        24
      );

    const limit =
      Date.now() -
      delayHours *
        60 *
        60 *
        1000;

    let sent = 0;

    for (
      const view of productViews
    ) {
      if (
        view.reminded ||
        !view.viewedAt
      ) {
        continue;
      }

      if (
        new Date(
          view.viewedAt
        ).getTime() > limit
      ) {
        continue;
      }

      const product =
        view.product || {};

      const ok =
        await sendEmail({
          to: view.email,

          subject:
            `Toujours intéressé(e) par ${
              product.name ||
              "ce produit"
            } ?`,

          text:
            `Vous avez récemment consulté ${
              product.name ||
              "un produit"
            } sur MERCADO.`,

          html:
            `<h2>MERCADO</h2>` +
            `<p>Vous avez récemment consulté <b>${escapeHtml(
              product.name ||
                "ce produit"
            )}</b>.</p>` +
            (product.img
              ? `<img src="${escapeHtml(
                  product.img
                )}" style="max-width:300px">`
              : "")
        });

      if (ok) {
        view.reminded = true;
        sent++;
      }
    }

    writeJSON(
      "product-views.json",
      productViews
    );

    res.json({
      ok: true,
      sent
    });
  }
);

/* =========================================================
   STATIC FRONTEND
========================================================= */

app.use(
  express.static(
    PUBLIC_DIR,
    {
      etag: false,
      maxAge: 0,

      setHeaders: (res) => {
        res.setHeader(
          "Cache-Control",
          "no-cache, no-store, must-revalidate"
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

app.get(
  "*",
  (req, res) => {
    const indexPath =
      path.join(
        PUBLIC_DIR,
        "index.html"
      );

    if (
      fs.existsSync(indexPath)
    ) {
      return res.sendFile(
        indexPath
      );
    }

    res
      .status(404)
      .send(
        "MERCADO index.html introuvable"
      );
  }
);

/* =========================================================
   HELPERS / START
========================================================= */

function escapeHtml(value) {
  return String(
    value ?? ""
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}

app.listen(
  PORT,
  () => {
    console.log("");
    console.log(
      "================================="
    );
    console.log(
      "        MERCADO SERVER"
    );
    console.log(
      "================================="
    );
    console.log(
      `Port: ${PORT}`
    );
    console.log(
      `GatePay: ${GATEPAY_API}`
    );
    console.log(
      `Wallet configured: ${
        GATEPAY_WALLET
          ? "YES"
          : "NO"
      }`
    );
    console.log(
      `Currency: ${GATEPAY_CURRENCY}`
    );
    console.log(
      `Markup: $${PRICE_MARKUP}`
    );
    console.log(
      `Public URL: ${PUBLIC_BASE_URL}`
    );
    console.log(
      `eBay configured: ${
        process.env.EBAY_CLIENT_ID
          ? "YES"
          : "NO"
      }`
    );
    console.log(
      "================================="
    );
  }
);
