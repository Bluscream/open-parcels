import path from "node:path";
import { loadRemoteRules } from "../services/ingest/rules-loader";
import { parseOrderEmail, parseReturnEmail } from "mail-parser-ts";

async function runTests() {
  console.log("=== STARTING DYNAMIC ORDER AND RETURN INTEGRATION TESTS ===");

  const orderRulesPath = path.join(
    process.cwd(),
    "packages",
    "email-parser-rules",
    "dist",
    "order.js"
  );

  const returnRulesPath = path.join(
    process.cwd(),
    "packages",
    "email-parser-rules",
    "dist",
    "return.js"
  );

  // 1. TEST ORDERS RULESET
  console.log("\n[Test] Loading dynamic Order ruleset...");
  process.env.OPENPARCELS_RULES = `file://${orderRulesPath}`;
  const orderRules = await loadRemoteRules();
  console.log(`[Test] Loaded ${orderRules.length} Order rules`);

  if (orderRules.length === 0) {
    console.error("[Test FAIL] No dynamic order rules loaded!");
    process.exit(1);
  }

  // A. Test Amazon Order Confirmation
  console.log("[Test] Testing Amazon Order Confirmation email...");
  const amazonOrderEmail = {
    from: "auto-confirm@amazon.de",
    subject: "Ihre Bestellung bei Amazon.de",
    body: "Vielen Dank für Ihre Bestellung! Bestellnummer: 302-8472901-4739201"
  };
  const amazonOrderResult = parseOrderEmail(
    amazonOrderEmail.from,
    amazonOrderEmail.subject,
    amazonOrderEmail.body,
    undefined,
    orderRules as any
  );
  console.log("[Test] Amazon Order confirmation result:", amazonOrderResult);

  if (
    amazonOrderResult &&
    amazonOrderResult.courier === "amazon" &&
    amazonOrderResult.status === "confirmed" &&
    amazonOrderResult.orderNumbers?.includes("302-8472901-4739201")
  ) {
    console.log("[Test PASS] Amazon Order Confirmation successfully matched and parsed!");
  } else {
    console.error("[Test FAIL] Amazon Order Confirmation matching failed!");
    process.exit(1);
  }

  // B. Test Amazon Shipment Notification
  console.log("[Test] Testing Amazon Shipment Notification email...");
  const amazonShipEmail = {
    from: "shipment-tracking@amazon.de",
    subject: "Ihre Amazon.de Bestellung wurde versandt",
    body: "Bestellung Nr. 302-8472901-4739201"
  };
  const amazonShipResult = parseOrderEmail(
    amazonShipEmail.from,
    amazonShipEmail.subject,
    amazonShipEmail.body,
    undefined,
    orderRules as any
  );
  console.log("[Test] Amazon Shipment result:", amazonShipResult);

  if (
    amazonShipResult &&
    amazonShipResult.courier === "amazon" &&
    amazonShipResult.status === "shipped" &&
    amazonShipResult.orderNumbers?.includes("302-8472901-4739201")
  ) {
    console.log("[Test PASS] Amazon Shipment Notification successfully matched and parsed!");
  } else {
    console.error("[Test FAIL] Amazon Shipment Notification matching failed!");
    process.exit(1);
  }


  // 2. TEST RETURNS RULESET
  console.log("\n[Test] Loading dynamic Return ruleset...");
  process.env.OPENPARCELS_RULES = `file://${returnRulesPath}`;
  const returnRules = await loadRemoteRules();
  console.log(`[Test] Loaded ${returnRules.length} Return rules`);

  if (returnRules.length === 0) {
    console.error("[Test FAIL] No dynamic return rules loaded!");
    process.exit(1);
  }

  // A. Test Amazon Return Confirmation
  console.log("[Test] Testing Amazon Return confirmation email...");
  const amazonReturnEmail = {
    from: "order-update@amazon.de",
    subject: "Zwrot przedmiotu z zamówienia 302-8472901-4739201",
    body: "Your return label is ready."
  };
  const amazonReturnResult = parseReturnEmail(
    amazonReturnEmail.from,
    amazonReturnEmail.subject,
    amazonReturnEmail.body,
    undefined,
    returnRules as any
  );
  console.log("[Test] Amazon Return result:", amazonReturnResult);

  if (
    amazonReturnResult &&
    amazonReturnResult.courier === "amazon" &&
    amazonReturnResult.status === "initiated" &&
    amazonReturnResult.orderNumbers?.includes("302-8472901-4739201")
  ) {
    console.log("[Test PASS] Amazon Return successfully matched and parsed!");
  } else {
    console.error("[Test FAIL] Amazon Return matching failed!");
    process.exit(1);
  }

  // B. Test PayPal Refund
  console.log("[Test] Testing PayPal Refund email...");
  const paypalRefundEmail = {
    from: "service@paypal.de",
    subject: "Rückzahlung von Muster GmbH",
    body: "Sie haben eine Rückzahlung erhalten."
  };
  const paypalRefundResult = parseReturnEmail(
    paypalRefundEmail.from,
    paypalRefundEmail.subject,
    paypalRefundEmail.body,
    undefined,
    returnRules as any
  );
  console.log("[Test] PayPal Refund result:", paypalRefundResult);

  if (
    paypalRefundResult &&
    paypalRefundResult.courier === "paypal" &&
    paypalRefundResult.status === "refunded"
  ) {
    console.log("[Test PASS] PayPal Refund successfully matched and parsed!");
  } else {
    console.error("[Test FAIL] PayPal Refund matching failed!");
    process.exit(1);
  }

  console.log("\n=== ALL DYNAMIC ORDER AND RETURN INTEGRATION TESTS PASSED SUCCESSFULLY! ===");
}

runTests().catch((err) => {
  console.error("[Test FAIL] Exception running tests:", err);
  process.exit(1);
});
