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
  return (
    LANGUAGE_CURRENCY[String(language || "en").toLowerCase()] ||
    "USD"
  );
}

function rateForCurrency(currency) {
  return USD_RATES[currency] || 1;
}

const PRICE_MARKUP = Number.isFinite(Number(process.env.PRICE_MARKUP))
  ? Number(process.env.PRICE_MARKUP)
  : 6;

const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

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
  fs.writeFileSync(
    file(name),
    JSON.stringify(data, null, 2)
  );
}

const orders = readJSON("orders.json", []);
const products = readJSON("products.json", []);
const reviews = readJSON("reviews.json", []);
const subscribers = readJSON("subscribers.json", []);
const productViews = readJSON("product-views.json", []);

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*"
  })
);

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb"
  })
);

/* =========================================================
   HEALTH / CONFIG
========================================================= */

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
    secure:
      String(process.env.SMTP_SECURE || "true") === "true",
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

  if (process.env.RESEND_API_KEY) {
    try {
      const r = await fetch(
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

      if (r.ok) return true;

      console.error(
        "Resend:",
        await r.text()
      );
    } catch (e) {
      console.error(
        "Resend:",
        e.message
      );
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
      console.error(
        "SMTP:",
        e.message
      );
    }
  }

  return false;
}

/* =========================================================
   EMAIL VERIFICATION
========================================================= */

const emailCodes = new Map();

app.post(
  "/api/email/send",
  async (req, res) => {
    const email = String(
      req.body.email || ""
    )
      .trim()
      .toLowerCase();

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        error: "Email invalide"
      });
    }

    const code = String(
      Math.floor(
        1000 + Math.random() * 9000
      )
    );

    emailCodes.set(email, {
      code,
      expiresAt:
        Date.now() +
        10 * 60 * 1000
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
  }
);

app.post(
  "/api/email/verify",
  (req, res) => {
    const email = String(
      req.body.email || ""
    )
      .trim()
      .toLowerCase();

    const code = String(
      req.body.code || ""
    ).trim();

    const record =
      emailCodes.get(email);

    if (!record) {
      return res.status(400).json({
        verified: false,
        error: "Code introuvable"
      });
    }

    if (
      Date.now() >
      record.expiresAt
    ) {
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
  }
);

/* =========================================================
   LOCAL PRODUCTS
========================================================= */

app.get(
  "/api/products",
  (req, res) => {
    res.json({
      products
    });
  }
);

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

  const clientId =
    process.env.EBAY_CLIENT_ID;

  const clientSecret =
    process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "EBAY_CLIENT_ID / EBAY_CLIENT_SECRET manquants"
    );
  }

  const sandbox =
    String(
      process.env.EBAY_ENVIRONMENT ||
      "production"
    ).toLowerCase() ===
    "sandbox";

  const tokenUrl = sandbox
    ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
    : "https://api.ebay.com/identity/v1/oauth2/token";

  const credentials =
    Buffer.from(
      `${clientId}:${clientSecret}`
    ).toString("base64");

  const r = await fetch(
    tokenUrl,
    {
      method: "POST",
      headers: {
        Authorization:
          `Basic ${credentials}`,
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body:
        "grant_type=client_credentials&scope=" +
        encodeURIComponent(
          "https://api.ebay.com/oauth/api_scope"
        )
    }
  );

  const data = await r.json();

  if (
    !r.ok ||
    !data.access_token
  ) {
    throw new Error(
      data.error_description ||
      "Impossible d'obtenir le token eBay"
    );
  }

  ebayToken =
    data.access_token;

  ebayTokenExpires =
    Date.now() +
    ((Number(
      data.expires_in
    ) || 7200) - 120) *
      1000;

  return ebayToken;
}

function ebayBase() {
  return String(
    process.env.EBAY_ENVIRONMENT ||
    "production"
  ).toLowerCase() ===
    "sandbox"
    ? "https://api.sandbox.ebay.com"
    : "https://api.ebay.com";
}

function marketplaceId(country) {
  const c = String(
    country || "US"
  ).toUpperCase();

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
  return Math.max(
    0,
    Number(basePrice) || 0
  ) + PRICE_MARKUP;
}

function normalizeEbayItems(items) {
  return items.map((x) => {
    const ebayPrice =
      Number(
        x.price?.value
      ) || 0;

    const salePrice =
      mercadoPrice(
        ebayPrice
      );

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
        x.categories?.[0]
          ?.categoryName ||
        "General",

      cat:
        x.categories?.[0]
          ?.categoryName ||
        "General",

      price:
        Number(
          salePrice.toFixed(2)
        ),

      rating:
        Number(
          x.reviews
            ?.averageRating ||
            x.rating ||
            0
        ),

      sold:
        Number(
          x.quantitySold ||
          0
        ),

      image:
        x.image?.imageUrl ||
        x.thumbnailImages?.[0]
          ?.imageUrl ||
        "",

      imageUrl:
        x.image?.imageUrl ||
        "",

      thumbnail:
        x.thumbnailImages?.[0]
          ?.imageUrl ||
        "",

      description:
        x.shortDescription ||
        "",

      desc:
        x.shortDescription ||
        "",

      itemUrl:
        x.itemWebUrl ||
        "",

      url:
        x.itemWebUrl ||
        "",

      _ebayPrice:
        Number(
          ebayPrice.toFixed(2)
        ),

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
  const token =
    await getEbayToken();

  const safeLimit =
    Math.min(
      Math.max(
        Number(limit) || 48,
        1
      ),
      100
    );

  const safeOffset =
    Math.max(
      Number(offset) || 0,
      0
    );

  const params =
    new URLSearchParams({
      q:
        q ||
        "popular products",
      limit:
        String(safeLimit),
      offset:
        String(safeOffset),
      filter:
        "buyingOptions:{FIXED_PRICE}"
    });

  const url =
    `${ebayBase()}/buy/browse/v1/item_summary/search?${params}`;

  const r = await fetch(
    url,
    {
      headers: {
        Authorization:
          `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID":
          marketplaceId(
            country
          ),
        "Accept-Language":
          "en-US"
      }
    }
  );

  const data =
    await r.json();

  if (!r.ok) {
    throw new Error(
      data.errors?.[0]
        ?.message ||
        "Erreur eBay"
    );
  }

  return {
    total:
      Number(
        data.total
      ) || 0,

    items:
      normalizeEbayItems(
        data.itemSummaries ||
          []
      )
  };
}

app.get(
  "/api/catalog/home",
  async (req, res) => {
    try {
      const result =
        await ebaySearch({
          q:
            req.query.q ||
            "popular products",
          limit:
            req.query.limit,
          offset:
            req.query.offset,
          country:
            req.query.country
        });

      res.json({
        ok: true,
        ...result
      });
    } catch (e) {
      console.error(
        "eBay home:",
        e.message
      );

      res.status(502).json({
        ok: false,
        error:
          e.message
      });
    }
  }
);

app.get(
  "/api/catalog/search",
  async (req, res) => {
    try {
      const q =
        String(
          req.query.q || ""
        ).trim();

      if (!q) {
        return res.status(400).json({
          error:
            "Recherche vide"
        });
      }

      const result =
        await ebaySearch({
          q,
          limit:
            req.query.limit,
          offset:
            req.query.offset,
          country:
            req.query.country
        });

      res.json({
        ok: true,
        ...result
      });
    } catch (e) {
      console.error(
        "eBay search:",
        e.message
      );

      res.status(502).json({
        ok: false,
        error:
          e.message
      });
    }
  }
);

app.get(
  "/api/catalog/item",
  async (req, res) => {
    try {
      const itemId =
        String(
          req.query.itemId ||
          ""
        ).trim();

      if (!itemId) {
        return res.status(400).json({
          error:
            "itemId manquant"
        });
      }

      const token =
        await getEbayToken();

      const url =
        `${ebayBase()}/buy/browse/v1/item/${encodeURIComponent(
          itemId
        )}`;

      const r = await fetch(
        url,
        {
          headers: {
            Authorization:
              `Bearer ${token}`,
            "X-EBAY-C-MARKETPLACE-ID":
              marketplaceId(
                req.query.country
              )
          }
        }
      );

      const data =
        await r.json();

      if (!r.ok) {
        throw new Error(
          data.errors?.[0]
            ?.message ||
            "Produit eBay introuvable"
        );
      }

      const items =
        normalizeEbayItems(
          [data]
        );

      res.json({
        ok: true,
        product:
          items[0] || null
      });
    } catch (e) {
      console.error(
        "eBay item:",
        e.message
      );

      res.status(502).json({
        ok: false,
        error:
          e.message
      });
    }
  }
);

/* =========================================================
   ORDER / CURRENCY
========================================================= */

function customerCurrency(order) {
  return (
    order.currency ||
    currencyForLanguage(
      order.language ||
        order.lang ||
        order.customer
          ?.language ||
        "en"
    )
  );
}

function calculateOrderTotal(
  items,
  currency
) {
  const rate =
    rateForCurrency(
      currency
    );

  let total = 0;

  for (const item of items || []) {
    const qty =
      Math.max(
        1,
        Number(
          item.qty
        ) || 1
      );

    let base =
      Number(
        item.basePrice
      );

    if (!Number.isFinite(base)) {
      base =
        Number(
          item.ebayPrice
        );
    }

    if (!Number.isFinite(base)) {
      base =
        Number(
          item._ebayPrice
        );
    }

    let unitUSD;

    if (
      Number.isFinite(base)
    ) {
      unitUSD =
        base +
        PRICE_MARKUP;
    } else {
      unitUSD =
        Number(
          item.price
        ) || 0;
    }

    total +=
      unitUSD *
      qty *
      rate;
  }

  return Number(
    total.toFixed(2)
  );
}

app.post(
  "/api/order",
  async (req, res) => {
    try {
      const body =
        req.body || {};

      const orderId =
        String(
          body.orderId ||
          `MRC-${Date.now()}-${crypto
            .randomBytes(3)
            .toString("hex")
            .toUpperCase()}`
        );

      const items =
        Array.isArray(
          body.items
        )
          ? body.items
          : [];

      if (!items.length) {
        return res.status(400).json({
          error:
            "Commande vide"
        });
      }

      const language =
        String(
          body.language ||
          body.lang ||
          body.customer
            ?.language ||
          "en"
        ).toLowerCase();

      const currency =
        currencyForLanguage(
          language
        );

      const total =
        calculateOrderTotal(
          items,
          currency
        );

      const order = {
        orderId,
        items,
        customer:
          body.customer ||
          {},
        language,
        currency,
        total,
        paymentMethod:
          "GatePay.to",
        status: "pending",
        paymentStatus:
          "pending",
        createdAt:
          new Date().toISOString()
      };

      orders.push(order);
      writeJSON(
        "orders.json",
        orders
      );

      const message =
        formatOrderMessage(
          order
        );

      await notifyTelegram(
        message
      );

      if (
        order.customer?.email
      ) {
        await sendEmail({
          to:
            order.customer
              .email,

          subject:
            `Commande MERCADO ${orderId}`,

          text:
            `Votre commande ${orderId} ` +
            `a été enregistrée. ` +
            `Total: ${total.toFixed(2)} ${currency}.`,

          html:
            `<h2>MERCADO</h2>` +
            `<p>Commande: <b>${escapeHtml(
              orderId
            )}</b></p>` +
            `<p>Total: <b>${total.toFixed(
              2
            )} ${currency}</b></p>`
        });
      }

      res.json({
        ok: true,
        orderId,
        total,
        currency,
        paymentMethod:
          "GatePay.to"
      });
    } catch (e) {
      console.error(
        "ORDER:",
        e.message
      );

      res.status(500).json({
        error:
          "Impossible de créer la commande"
      });
    }
  }
);

/* =========================================================
   GATEPAY
========================================================= */

app.post(
  "/api/payment/gatepay",
  async (req, res) => {
    try {
      if (!GATEPAY_WALLET) {
        return res.status(500).json({
          error:
            "GATEPAY_WALLET_ADDRESS manquant"
        });
      }

      const orderId =
        String(
          req.body.orderId ||
          req.body.order_id ||
          ""
        ).trim();

      if (!orderId) {
        return res.status(400).json({
          error:
            "orderId manquant"
        });
      }

      const order =
        orders.find(
          (x) =>
            String(
              x.orderId
            ) === orderId
        );

      if (!order) {
        return res.status(404).json({
          error:
            "Commande introuvable"
        });
      }

      const currency =
        customerCurrency(
          order
        );

      const amount =
        calculateOrderTotal(
          order.items,
          currency
        );

      order.currency =
        currency;

      order.total =
        amount;

      const callbackUrl =
        `${PUBLIC_BASE_URL}/api/payment/gatepay/callback`;
