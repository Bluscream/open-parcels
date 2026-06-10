const path = require("path");
const { parseParcelEmail } = require("../../packages/mail-parser-ts/dist/parser.js");
const rulesModule = require("../../packages/email-parser-rules/dist/parcel.js");

function runTests() {
  console.log("=== STARTING PURE JAVASCRIPT INTEGRATION TESTS ===");

  // 1. Get compiled rules
  const rules = rulesModule.rules || rulesModule.default || rulesModule;
  console.log(`[Test] Loaded compiled rules: ${rules.length}`);
  
  if (rules.length === 0) {
    console.error("[Test FAIL] No compiled rules found!");
    process.exit(1);
  }

  // 2. Test USPS dynamic parsing (declarative prefix status matching & regex)
  console.log("\n[Test] Testing USPS dynamic rule...");
  const uspsEmail = {
    from: "auto-reply@usps.com",
    subject: "Your USPS Item Delivered!",
    body: "Hi, your item was delivered today. Tracking: 9400111899562725381123."
  };
  
  const uspsResult = parseParcelEmail(uspsEmail.from, uspsEmail.subject, uspsEmail.body, undefined, rules);
  console.log("[Test] USPS Result:", uspsResult);

  if (
    uspsResult &&
    uspsResult.courier === "usps" &&
    uspsResult.status === "delivered" &&
    uspsResult.trackingNumbers.includes("9400111899562725381123")
  ) {
    console.log("[Test PASS] USPS dynamic rules successfully matched and parsed!");
  } else {
    console.error("[Test FAIL] USPS dynamic rules matching failed!");
    process.exit(1);
  }

  // 3. Test DHL dynamic parsing (declarative status and prefix matching)
  console.log("\n[Test] Testing DHL dynamic rule...");
  const dhlEmail = {
    from: "NoReply.ODD@dhl.com",
    subject: "DHL On Demand Delivery update",
    body: "Your package has been delivered. Waybill/tracking: 8475930281"
  };
  
  const dhlResult = parseParcelEmail(dhlEmail.from, dhlEmail.subject, dhlEmail.body, undefined, rules);
  console.log("[Test] DHL Result:", dhlResult);

  if (
    dhlResult &&
    dhlResult.courier === "dhl" &&
    dhlResult.status === "delivered" &&
    dhlResult.trackingNumbers.includes("8475930281")
  ) {
    console.log("[Test PASS] DHL dynamic rules successfully matched and parsed!");
  } else {
    console.error("[Test FAIL] DHL dynamic rules matching failed!");
    process.exit(1);
  }

  // 4. Test Amazon Dynamic Custom Parser (Locker email)
  console.log("\n[Test] Testing Amazon custom parser (Hub Locker email)...");
  const amazonLockerEmail = {
    from: "thehub@amazon.com",
    subject: "Your package 123-4567890-1234567 is ready for pickup from Amazon Hub Locker",
    body: "Hi! Your pickup code is <b>987654</b>. Please collect it soon."
  };
  
  const lockerResult = parseParcelEmail(amazonLockerEmail.from, amazonLockerEmail.subject, amazonLockerEmail.body, undefined, rules);
  console.log("[Test] Amazon Locker Result:", lockerResult);

  if (
    lockerResult &&
    lockerResult.courier === "amazon" &&
    lockerResult.status === "arriving" &&
    lockerResult.secretCode === "987654" &&
    lockerResult.secretType === "locker" &&
    lockerResult.orderNumbers.includes("123-4567890-1234567")
  ) {
    console.log("[Test PASS] Amazon Hub Locker custom parser matched and parsed correctly!");
  } else {
    console.error("[Test FAIL] Amazon Hub Locker custom parser matching failed!");
    process.exit(1);
  }

  // 5. Test Amazon Dynamic Custom Parser (Late Delivery update)
  console.log("\n[Test] Testing Amazon custom parser (Late update)...");
  const amazonLateEmail = {
    from: "order-update@amazon.de",
    subject: "Delivery update: your order is running late",
    body: "Sorry, your order 987-6543210-9876543 is running late. Arriving tomorrow."
  };
  
  const lateResult = parseParcelEmail(amazonLateEmail.from, amazonLateEmail.subject, amazonLateEmail.body, undefined, rules);
  console.log("[Test] Amazon Late Result:", lateResult);

  if (
    lateResult &&
    lateResult.courier === "amazon" &&
    lateResult.status === "exception" &&
    lateResult.orderNumbers.includes("987-6543210-9876543")
  ) {
    console.log("[Test PASS] Amazon late delivery custom parser matched and parsed correctly!");
  } else {
    console.error("[Test FAIL] Amazon late delivery custom parser matching failed!");
    process.exit(1);
  }

  // 6. Test Amazon Courier OTP
  console.log("\n[Test] Testing Amazon Courier OTP...");
  const amazonOtpEmail = {
    from: "shipment-tracking@amazon.de",
    subject: "Arriving Today: A one-time password is required for your Amazon delivery",
    body: "Your package is out for delivery! Your one-time password is 737725"
  };
  const otpResult = parseParcelEmail(amazonOtpEmail.from, amazonOtpEmail.subject, amazonOtpEmail.body, undefined, rules);
  console.log("[Test] Amazon OTP Result:", otpResult);

  if (
    otpResult &&
    otpResult.courier === "amazon" &&
    otpResult.status === "arriving" &&
    otpResult.secretCode === "737725" &&
    otpResult.secretType === "courier"
  ) {
    console.log("[Test PASS] Amazon OTP courier matching successfully parsed!");
  } else {
    console.error("[Test FAIL] Amazon OTP courier parsing failed!");
    process.exit(1);
  }

  // 7. Performance benchmark
  console.log("\n[Test] Running performance benchmark...");
  const { performance } = require("perf_hooks");
  const testEmail = {
    from: "shipment-tracking@amazon.de",
    subject: "Arriving Today: A one-time password is required for your Amazon delivery",
    body: "Your package is out for delivery! Your one-time password is 737725"
  };

  const iterations = 1000;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    parseParcelEmail(testEmail.from, testEmail.subject, testEmail.body, undefined, rules);
  }
  const end = performance.now();
  const totalTime = end - start;
  const avgTime = totalTime / iterations;
  console.log(`[Perf] Processed ${iterations} iterations in ${totalTime.toFixed(2)}ms (average: ${avgTime.toFixed(4)}ms per parse)`);

  const warnThreshold = 2.0; // 2ms per parse
  const failThreshold = 10.0; // 10ms per parse

  if (avgTime > failThreshold) {
    console.error(`[Perf FAIL] Average parse time (${avgTime.toFixed(4)}ms) exceeded failure threshold of ${failThreshold}ms!`);
    process.exit(1);
  } else if (avgTime > warnThreshold) {
    console.warn(`[Perf WARN] Average parse time (${avgTime.toFixed(4)}ms) exceeded warning threshold of ${warnThreshold}ms!`);
  } else {
    console.log("[Perf PASS] Performance is excellent.");
  }

  console.log("\n=== ALL DYNAMIC PARSING INTEGRATION TESTS PASSED SUCCESSFULLY! ===");
}

try {
  runTests();
} catch (err) {
  console.error("[Test FAIL] Exception running tests:", err);
  process.exit(1);
}
