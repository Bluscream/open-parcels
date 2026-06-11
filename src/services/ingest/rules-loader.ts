import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import type { ParcelRule, OrderRule, ReturnRule, DunningRule } from "mail-parser-ts";
import { requestQueue } from "../../utils/requestQueue";

const CACHE_DIR = path.join(process.cwd(), ".scratch", "rules-cache");

let activeParcelRules: ParcelRule[] = [];
let activeOrderRules: OrderRule[] = [];
let activeReturnRules: ReturnRule[] = [];
let activeDunningRules: DunningRule[] = [];

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function initRulesLoader(): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    console.error("[RulesLoader] Failed to create cache directory:", error);
  }
}

export async function loadRemoteRules(): Promise<any[]> {
  const rulesUrls = process.env.OPENPARCELS_RULES;
  if (!rulesUrls) {
    console.log("[RulesLoader] OPENPARCELS_RULES not set. No remote rules will be loaded.");
    return [];
  }

  const urls = rulesUrls.split(",").map(url => url.trim()).filter(Boolean);
  
  const loadedParcels: Record<string, ParcelRule> = {};
  const loadedOrders: Record<string, OrderRule> = {};
  const loadedReturns: Record<string, ReturnRule> = {};
  const loadedDunning: Record<string, DunningRule> = {};

  await initRulesLoader();

  for (const url of urls) {
    let jsContent: string | null = null;
    let fileName = "rules.js";
    let cachePath = "";

    if (url.startsWith("file://")) {
      try {
        let filePath = decodeURIComponent(url.substring(7));
        if (filePath.startsWith("/") && filePath[2] === ":") {
          filePath = filePath.substring(1);
        }
        fileName = path.basename(filePath);
        console.log(`[RulesLoader] Loading local file rules from: ${filePath}`);
        jsContent = await fs.readFile(filePath, "utf-8");
      } catch (err) {
        console.error(`[RulesLoader] Failed to read local rules file from ${url}:`, err);
        continue;
      }
    } else {
      let urlObj: URL;
      try {
        urlObj = new URL(url);
      } catch (err) {
        console.error(`[RulesLoader] Invalid URL configured: ${url}`, err);
        continue;
      }

      fileName = path.basename(urlObj.pathname) || "rules.js";
      cachePath = path.join(CACHE_DIR, fileName);

      try {
        console.log(`[RulesLoader] Fetching remote rules from: ${url}`);
        const res = await requestQueue.enqueue(url, () => fetch(url));
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        jsContent = await res.text();
        
        // Save/overwrite the disk cache on successful fetch
        await fs.writeFile(cachePath, jsContent, "utf-8");
        console.log(`[RulesLoader] Successfully cached ruleset to: ${cachePath}`);
      } catch (fetchError) {
        console.warn(`[RulesLoader] Failed to fetch remote rules from ${url}:`, fetchError);
        
        // Attempt to load from disk cache
        if (await exists(cachePath)) {
          try {
            jsContent = await fs.readFile(cachePath, "utf-8");
            console.log(`[RulesLoader] Fell back to disk cache for: ${cachePath}`);
          } catch (cacheError) {
            console.error(`[RulesLoader] Failed to read disk cache file ${cachePath}:`, cacheError);
          }
        } else {
          console.warn(`[RulesLoader] No local disk cache found for ${fileName}`);
        }
      }
    }

    if (jsContent) {
      try {
        const rules = compileRulesFromJs(jsContent);
        console.log(`[RulesLoader] Loaded ${rules.length} rules from ${fileName}`);
        
        const isParcel = fileName.includes("parcel");
        const isOrder = fileName.includes("order");
        const isReturn = fileName.includes("return");
        const isDunning = fileName.includes("dunning");

        for (const rule of rules) {
          if (rule && rule.id) {
            if (isOrder) {
              loadedOrders[rule.id] = rule as OrderRule;
            } else if (isReturn) {
              loadedReturns[rule.id] = rule as ReturnRule;
            } else if (isDunning) {
              loadedDunning[rule.id] = rule as DunningRule;
            } else if (isParcel || (!isOrder && !isReturn && !isDunning)) {
              // Default to parcel rules if category cannot be inferred
              loadedParcels[rule.id] = rule as ParcelRule;
            }
          }
        }
      } catch (compileError) {
        console.error(`[RulesLoader] Failed to compile ruleset from ${fileName}:`, compileError);
      }
    }
  }

  activeParcelRules = Object.values(loadedParcels);
  activeOrderRules = Object.values(loadedOrders);
  activeReturnRules = Object.values(loadedReturns);
  activeDunningRules = Object.values(loadedDunning);

  console.log(`[RulesLoader] Active rules loaded:`);
  console.log(`  - Parcels: ${activeParcelRules.length}`);
  console.log(`  - Orders: ${activeOrderRules.length}`);
  console.log(`  - Returns: ${activeReturnRules.length}`);
  console.log(`  - Dunning: ${activeDunningRules.length}`);

  // Return all rules flat for any generic test/loader compatibility
  return [...activeParcelRules, ...activeOrderRules, ...activeReturnRules, ...activeDunningRules];
}

export function getActiveParcelRules(): ParcelRule[] {
  return activeParcelRules;
}

export function getActiveOrderRules(): OrderRule[] {
  return activeOrderRules;
}

export function getActiveReturnRules(): ReturnRule[] {
  return activeReturnRules;
}

export function getActiveDunningRules(): DunningRule[] {
  return activeDunningRules;
}

export function getActiveRules(): ParcelRule[] {
  return activeParcelRules;
}


function compileRulesFromJs(jsContent: string): any[] {
  const sandbox = { exports: {} as any, module: { exports: {} as any } };
  vm.createContext(sandbox);
  
  // Support both standard exports and module.exports
  vm.runInContext(jsContent, sandbox);
  
  const exports = sandbox.exports || {};
  const moduleExports = sandbox.module.exports || {};
  
  const rules = 
    exports.rules || 
    exports.default || 
    moduleExports.rules || 
    moduleExports.default || 
    exports || 
    moduleExports;
    
  return Array.isArray(rules) ? rules : [];
}
