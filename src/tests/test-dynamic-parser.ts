import path from "node:path";
import { loadRemoteRules, getActiveRules } from "../services/ingest/rules-loader";
import { TrackingParser } from "../services/ingest/parser";
import { expandDomains } from "mail-parser-ts";

async function runTests() {
  console.log("=== STARTING DYNAMIC PARSING INTEGRATION TESTS ===");

  // 1. Configure the local compiled ruleset as a local file URL
  const rulesPath = path.join(
    process.cwd(),
    "packages",
    "email-parser-rules",
    "dist",
    "parcel.js"
  );
  process.env.OPENPARCELS_RULES = `file://${rulesPath}`;
  console.log(`[Test] Set OPENPARCELS_RULES to: ${process.env.OPENPARCELS_RULES}`);

  // 2. Load rules
  const rules = await loadRemoteRules();
  console.log(`[Test] Active Rules Loaded: ${rules.length}`);
  
  if (rules.length === 0) {
    console.error("[Test FAIL] No dynamic rules loaded!");
    process.exit(1);
  }

  // 3. Verify USPS Match
  console.log("\n[Test] Testing USPS parsing...");
  const uspsParser = new TrackingParser(
    "auto-reply@usps.com",
    "Your USPS Item Delivered!",
    "Hi, your item was delivered today. Tracking: 9400111899562725381123."
  );
  const uspsResult = uspsParser.parse();
  console.log("[Test] USPS Parse Result:", uspsResult);

  if (
    uspsResult &&
    uspsResult.courier &&
    uspsResult.courier.name === "USPS" &&
    uspsResult.type === "delivered" &&
    uspsResult.courier.tracking_number === "9400111899562725381123"
  ) {
    console.log("[Test PASS] USPS rules successfully matched and parsed!");
  } else {
    console.error("[Test FAIL] USPS rules matching failed!");
    process.exit(1);
  }

  // 4. Verify DHL Match
  console.log("\n[Test] Testing DHL parsing...");
  const dhlParser = new TrackingParser(
    "NoReply.ODD@dhl.com",
    "DHL On Demand Delivery update",
    "Your package has been delivered. Waybill/tracking: 8475930281"
  );
  const dhlResult = dhlParser.parse();
  console.log("[Test] DHL Parse Result:", dhlResult);

  if (
    dhlResult &&
    dhlResult.courier &&
    dhlResult.courier.name === "DHL" &&
    dhlResult.type === "delivered" &&
    dhlResult.courier.tracking_number === "8475930281"
  ) {
    console.log("[Test PASS] DHL rules successfully matched and parsed!");
  } else {
    console.error("[Test FAIL] DHL rules matching failed!");
    process.exit(1);
  }

  // 5. Verify Amazon Locker Custom Parser Match
  console.log("\n[Test] Testing Amazon custom parser (Hub Locker email)...");
  const amazonLockerParser = new TrackingParser(
    "thehub@amazon.com",
    "Your package 123-4567890-1234567 is ready for pickup from Amazon Hub Locker",
    "Hi! Your pickup code is <b>987654</b>. Please collect it soon."
  );
  const lockerResult = amazonLockerParser.parse();
  console.log("[Test] Amazon Locker Parse Result:", lockerResult);

  if (
    lockerResult &&
    lockerResult.platform &&
    lockerResult.platform.name === "Amazon" &&
    lockerResult.type === "arriving" &&
    lockerResult.platform.order_number === "123-4567890-1234567" &&
    lockerResult.location === "Amazon Hub Locker: 987654"
  ) {
    console.log("[Test PASS] Amazon Hub Locker custom parser matched and parsed correctly!");
  } else {
    console.error("[Test FAIL] Amazon Hub Locker custom parser matching failed!");
    process.exit(1);
  }

  // 6. Verify Amazon Late Delivery Custom Parser Match
  console.log("\n[Test] Testing Amazon custom parser (Late update)...");
  const amazonLateParser = new TrackingParser(
    "order-update@amazon.de",
    "Delivery update: your order is running late",
    "Sorry, your order 987-6543210-9876543 is running late. Arriving tomorrow."
  );
  const lateResult = amazonLateParser.parse();
  console.log("[Test] Amazon Late Parse Result:", lateResult);

  if (
    lateResult &&
    lateResult.platform &&
    lateResult.platform.name === "Amazon" &&
    lateResult.type === "exception" &&
    lateResult.platform.order_number === "987-6543210-9876543"
  ) {
    console.log("[Test PASS] Amazon late delivery custom parser matched and parsed correctly!");
  } else {
    console.error("[Test FAIL] Amazon late delivery custom parser matching failed!");
    process.exit(1);
  }

  // 7. Verify expandDomains helper
  console.log("\n[Test] Testing expandDomains helper...");
  const rawDomains = ["regex:^amazon\\.(com|ca|co\\.uk|in|de|it|com\\.au|pl)$", "ebay.com"];
  const expanded = expandDomains(rawDomains);
  console.log("[Test] Expanded domains:", expanded);
  
  if (
    expanded.includes("amazon.com") &&
    expanded.includes("amazon.de") &&
    expanded.includes("amazon.pl") &&
    expanded.includes("ebay.com") &&
    expanded.length === 9
  ) {
    console.log("[Test PASS] expandDomains helper successfully expanded regex patterns!");
  } else {
    console.error("[Test FAIL] expandDomains helper expansion failed!", expanded);
    process.exit(1);
  }

  console.log("\n=== ALL DYNAMIC PARSING INTEGRATION TESTS PASSED SUCCESSFULLY! ===");
}

runTests().catch((err) => {
  console.error("[Test FAIL] Exception running tests:", err);
  process.exit(1);
});
