const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "../packages/email-parser-rules/src");

const METADATA_MAP = {
  "amazon": {
    "description": "Parses Amazon order confirmations, shipping updates, returns, and locker pickup codes.",
    "icon_url": "https://www.google.com/s2/favicons?domain=amazon.com&sz=128"
  },
  "paypal": {
    "description": "Parses PayPal refund confirmations and money receipt notifications.",
    "icon_url": "https://www.google.com/s2/favicons?domain=paypal.com&sz=128"
  },
  "dhl": {
    "description": "Parses DHL delivery updates, scheduled arrivals, and delivery confirmations.",
    "icon_url": "https://www.google.com/s2/favicons?domain=dhl.com&sz=128"
  },
  "usps": {
    "description": "Parses USPS tracking updates, out-for-delivery, and delivery alerts.",
    "icon_url": "https://www.google.com/s2/favicons?domain=usps.com&sz=128"
  },
  "ups": {
    "description": "Parses UPS package tracking, delivery schedules, and confirmation emails.",
    "icon_url": "https://www.google.com/s2/favicons?domain=ups.com&sz=128"
  },
  "fedex": {
    "description": "Parses FedEx shipment updates, delivery statuses, and scheduling alerts.",
    "icon_url": "https://www.google.com/s2/favicons?domain=fedex.com&sz=128"
  },
  "ebay": {
    "description": "Parses eBay purchase confirmations, order updates, and seller messages.",
    "icon_url": "https://www.google.com/s2/favicons?domain=ebay.com&sz=128"
  },
  "shopify": {
    "description": "Parses shop-specific order confirmations, shipping updates, and receipts driven by Shopify.",
    "icon_url": "https://www.google.com/s2/favicons?domain=shopify.com&sz=128"
  },
  "royal": {
    "description": "Parses Royal Mail postage confirmations, delivery statuses, and collection updates.",
    "icon_url": "https://www.google.com/s2/favicons?domain=royalmail.com&sz=128"
  },
  "capost": {
    "description": "Parses Canada Post shipping notifications and delivery confirmations.",
    "icon_url": "https://www.google.com/s2/favicons?domain=canadapost.ca&sz=128"
  },
  "auspost": {
    "description": "Parses Australia Post shipment updates, tracking statuses, and arrival notifications.",
    "icon_url": "https://www.google.com/s2/favicons?domain=auspost.com.au&sz=128"
  },
  "hermes": {
    "description": "Parses Evri / Hermes parcel tracking updates and delivery notifications.",
    "icon_url": "https://www.google.com/s2/favicons?domain=myhermes.de&sz=128"
  },
  "dpd_com_pl": {
    "description": "Parses DPD delivery tracking, scheduling updates, and receipt confirmations.",
    "icon_url": "https://www.google.com/s2/favicons?domain=dpd.com&sz=128"
  },
  "gls": {
    "description": "Parses GLS parcel shipment details and delivery notifications.",
    "icon_url": "https://www.google.com/s2/favicons?domain=gls-group.eu&sz=128"
  },
  "inpost_pl": {
    "description": "Parses InPost Paczkomaty locker collection codes and delivery updates.",
    "icon_url": "https://www.google.com/s2/favicons?domain=inpost.pl&sz=128"
  },
  "poczta_polska": {
    "description": "Parses Poczta Polska registered mail updates and delivery notifications.",
    "icon_url": "https://www.google.com/s2/favicons?domain=poczta-polska.pl&sz=128"
  }
};

function walkDir(dir, callback) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walkDir(fullPath, callback);
    } else if (file.endsWith(".ts") && file !== "types.ts") {
      callback(fullPath);
    }
  }
}

walkDir(SRC_DIR, (filePath) => {
  const content = fs.readFileSync(filePath, "utf8");

  // Find id
  const idMatch = content.match(/id:\s*"(.*?)"/);
  if (!idMatch) return;

  const id = idMatch[1];
  const meta = METADATA_MAP[id];

  if (!meta) {
    console.log(`Skipping metadata mapping for rules category with ID '${id}' (${filePath})`);
    return;
  }

  let updated = content;

  // Replace description line
  updated = updated.replace(/description:\s*".*?",?/g, `description: "${meta.description}",`);
  // Replace icon_url line
  updated = updated.replace(/icon_url:\s*".*?",?/g, `icon_url: "${meta.icon_url}",`);

  fs.writeFileSync(filePath, updated, "utf8");
  console.log(`Updated local premium metadata for ${path.basename(filePath)}`);
});
