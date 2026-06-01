/**
 * verify-parsed.ts
 * Cross-checks every entry in parsed_mails.json against the actual .eml Subject and From header.
 * Run: npx tsx scripts/verify-parsed.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

const MAILS_DIR = "/var/mnt/nfs/Backups (NAS)/Timo/mails/";
const OUTPUT_FILE = path.join(__dirname, "../parsed_mails.json");

function decodeMimeHeader(str: string): string {
  return str.replace(
    /=\?([^?]+)\?([QB])\?([^?]*)\?=/gi,
    (match, charset, encoding, text) => {
      try {
        if (encoding.toUpperCase() === "B") {
          return Buffer.from(text, "base64").toString(
            charset.toLowerCase() === "utf-8" ? "utf8" : "latin1"
          );
        }
        if (encoding.toUpperCase() === "Q") {
          const hexDecoded = text.replace(/_/g, " ").replace(
            /=([0-9A-F]{2})/gi,
            (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16))
          );
          return Buffer.from(hexDecoded, "binary").toString(
            charset.toLowerCase() === "utf-8" ? "utf8" : "latin1"
          );
        }
      } catch {}
      return match;
    }
  );
}

function parseFoldedHeader(headersText: string, name: string): string {
  const re = new RegExp(`^${name}:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)`, "im");
  const m = headersText.match(re);
  if (!m) return "";
  return decodeMimeHeader(m[1].replace(/\r?\n[ \t]+/g, " ").trim());
}

const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
const entries: any[] = data.parsed;

let passed = 0;
let warned = 0;

for (const entry of entries) {
  const filePath = path.join(MAILS_DIR, entry.filename);
  let from = "?", subject = "?";
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(8000);
    const bytesRead = fs.readSync(fd, buf, 0, 8000, 0);
    fs.closeSync(fd);
    const chunk = buf.toString("utf8", 0, bytesRead);
    const headerEnd = chunk.indexOf("\n\n");
    const headers = headerEnd !== -1 ? chunk.slice(0, headerEnd) : chunk;
    from    = parseFoldedHeader(headers, "From").toLowerCase();
    subject = parseFoldedHeader(headers, "Subject");
  } catch (e) {
    console.log(`  [WARN] Could not read ${entry.filename}: ${e}`);
    warned++;
    continue;
  }

  const results: Record<string, any> = entry.results ?? {};
  const types = Object.keys(results);
  const issues: string[] = [];

  // ── Parcel checks ────────────────────────────────────────────────
  if (results.parcel) {
    const status = results.parcel.status;
    if (status === "delivered" && !/delivered|zugestellt|geliefert|consegna effettuata|dostarczono/i.test(subject)) {
      issues.push(`parcel:delivered but subject doesn't look delivered`);
    }
    if (status === "arriving" && /^delivered:/i.test(subject)) {
      issues.push(`parcel:arriving but subject starts with "Delivered:"`);
    }
  }

  // ── Order checks ─────────────────────────────────────────────────
  if (results.order) {
    const status = results.order.status;
    if (status === "shipped" && !/versandt|shipped|dispatched|spedita/i.test(subject) && !/versandbestaetigung|shipment-tracking|dispatch-confirmation/i.test(from)) {
      issues.push(`order:shipped but From/Subject don't indicate shipment`);
    }
    if (status === "confirmed" && !/bestätigung|confirm|bestellung|order|delivery estimate/i.test(subject)) {
      issues.push(`order:confirmed but subject lacks confirmation keyword`);
    }
    if (status === "placed" && !/bestellung|order|your amazon|purchase|kauf|ordered|delivery estimate/i.test(subject)) {
      issues.push(`order:placed but subject lacks order keyword`);
    }
    if (/^(rueckgabe|returns?)@/i.test(from) || /your return of|rücksendung/i.test(subject)) {
      issues.push(`return-type email mis-classified as order`);
    }
    if (/zahlungsbestätigung|payment confirmation/i.test(subject)) {
      issues.push(`payment-only email should have been filtered`);
    }
  }

  // ── Return checks ────────────────────────────────────────────────
  if (results.return) {
    const status = results.return.status;
    if (status === "initiated" && !/return|retoure|rückgabe|rücksendung|zwrot/i.test(subject)) {
      issues.push(`return:initiated but subject has no return keyword`);
    }
  }

  // ── Dunning checks ───────────────────────────────────────────────
  if (results.dunning) {
    const status = results.dunning.status;
    if (status === "reminder" && !/zahlungserinnerung|erinnerung|reminder/i.test(subject)) {
      issues.push(`dunning:reminder but subject has no reminder keyword`);
    }
    if (status === "warning" && !/mahnung|warning|overdue|letzte/i.test(subject)) {
      issues.push(`dunning:warning but subject has no warning keyword`);
    }
  }

  const typeStr = `[${types.join("+")}]`.padEnd(18);
  if (issues.length > 0) {
    console.log(`  ✗ ${typeStr} ${entry.filename}`);
    console.log(`      From:    ${from}`);
    console.log(`      Subject: ${subject}`);
    for (const issue of issues) console.log(`      Issue:   ${issue}`);
    warned++;
  } else {
    console.log(`  ✓ ${typeStr} ${subject.slice(0, 68)}`);
    passed++;
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Result: ${passed} passed, ${warned} warnings/failures out of ${entries.length} entries.`);
if (warned === 0) console.log("All parsed entries look correct!");
