#!/usr/bin/env node
/**
 * List GCP entity bucket grouped by user (when DB available) and extract Invoice.json files.
 *
 * Usage (bucket only; groups by scope):
 *   GCP_ENTITY_BUCKET=profitwise-storage2026 node scripts/bucket-by-user-and-extract-invoices.mjs [key-file.json] [--out=./invoices]
 *
 * Usage (with DB for user mapping; set DATABASE_URL):
 *   DATABASE_URL=... GCP_ENTITY_BUCKET=profitwise-storage2026 node scripts/bucket-by-user-and-extract-invoices.mjs [key-file.json] [--out=./invoices]
 *
 * Optional --out=DIR defaults to ./out-invoices.
 */
import { Storage } from "@google-cloud/storage";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const bucketName = process.env.GCP_ENTITY_BUCKET;
const outDir = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "out-invoices";
const keyPath = process.argv.find((a) => a.endsWith(".json") && !a.startsWith("--"));

let credentials = null;
if (keyPath) {
  const abs = join(process.cwd(), keyPath);
  credentials = JSON.parse(readFileSync(abs, "utf8"));
}
if (!credentials && process.env.GCP_SERVICE_KEY_JSON) {
  credentials = JSON.parse(process.env.GCP_SERVICE_KEY_JSON);
}

if (!bucketName) {
  console.error("Set GCP_ENTITY_BUCKET");
  process.exit(1);
}

const storage = new Storage(credentials ? { credentials, projectId: credentials.project_id } : {});
const bucket = storage.bucket(bucketName);

/** @returns { Promise<{ userId: string, qbo: string[], xero: string[] }[]> } */
async function loadUserScopesFromDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return [];
  const pg = await import("pg");
  const client = new pg.default.Client({ connectionString: url });
  await client.connect();
  try {
    const [qboRows, xeroRows] = await Promise.all([
      client.query("SELECT user_id, realm_id FROM qbo_connections"),
      client.query("SELECT user_id, tenant_id FROM xero_connections"),
    ]);
    const byUser = new Map();
    for (const r of qboRows.rows ?? []) {
      let u = byUser.get(r.user_id);
      if (!u) {
        u = { userId: r.user_id, qbo: [], xero: [] };
        byUser.set(r.user_id, u);
      }
      u.qbo.push(r.realm_id);
    }
    for (const r of xeroRows.rows ?? []) {
      let u = byUser.get(r.user_id);
      if (!u) {
        u = { userId: r.user_id, qbo: [], xero: [] };
        byUser.set(r.user_id, u);
      }
      u.xero.push(r.tenant_id);
    }
    return Array.from(byUser.values());
  } finally {
    await client.end();
  }
}

/** Parse path: accounting/user/{userId}/qbo/{scope}/X.json or accounting/qbo/{scope}/X.json -> { userId?, provider, scopeId, entityType } */
function parsePath(name) {
  const userMatch = name.match(/^accounting\/user\/([^/]+)\/(qbo|xero)\/([^/]+)\/([^/]+)\.json$/);
  if (userMatch) return { userId: userMatch[1], provider: userMatch[2], scopeId: userMatch[3], entityType: userMatch[4] };
  const legacyMatch = name.match(/^accounting\/(qbo|xero)\/([^/]+)\/([^/]+)\.json$/);
  if (legacyMatch) return { userId: null, provider: legacyMatch[1], scopeId: legacyMatch[2], entityType: legacyMatch[3] };
  return null;
}

async function main() {
  const userScopes = await loadUserScopesFromDb();
  const scopeToUser = new Map();
  if (userScopes.length > 0) {
    console.log("Loaded user→scope mapping from DB for", userScopes.length, "users");
    for (const u of userScopes) {
      for (const r of u.qbo) scopeToUser.set(`qbo:${r}`, u.userId);
      for (const t of u.xero) scopeToUser.set(`xero:${t}`, u.userId);
    }
  } else {
    console.log("No DATABASE_URL: grouping by scope (provider/scope_id) only.");
  }

  const [files] = await bucket.getFiles({ prefix: "accounting/" });
  const byUser = new Map();
  const byScope = new Map();

  for (const file of files) {
    const p = parsePath(file.name);
    if (!p) continue;
    const key = `${p.provider}:${p.scopeId}`;
    const userId = p.userId ?? scopeToUser.get(key);
    if (userId) {
      let arr = byUser.get(userId);
      if (!arr) {
        arr = [];
        byUser.set(userId, arr);
      }
      arr.push({ ...p, path: file.name });
    }
    let scopeArr = byScope.get(key);
    if (!scopeArr) {
      scopeArr = [];
      byScope.set(key, scopeArr);
    }
    scopeArr.push({ ...p, path: file.name });
  }

  const baseOut = join(process.cwd(), outDir);
  mkdirSync(baseOut, { recursive: true });

  const invoiceSummary = [];
  const toDownload = [];

  if (byUser.size > 0) {
    for (const [userId, items] of byUser) {
      const invoiceFiles = items.filter((i) => i.entityType === "Invoice");
      for (const inv of invoiceFiles) {
        toDownload.push({
          path: inv.path,
          outPath: join(baseOut, "by-user", userId, inv.provider, inv.scopeId, "Invoice.json"),
          userId,
          provider: inv.provider,
          scopeId: inv.scopeId,
        });
      }
      invoiceSummary.push({ userId, qbo: [...new Set(items.filter((i) => i.provider === "qbo").map((i) => i.scopeId))], xero: [...new Set(items.filter((i) => i.provider === "xero").map((i) => i.scopeId))], invoiceFiles: items.filter((i) => i.entityType === "Invoice").length });
    }
  } else {
    for (const [key, items] of byScope) {
      const invoiceFiles = items.filter((i) => i.entityType === "Invoice");
      for (const inv of invoiceFiles) {
        const [provider, scopeId] = key.split(":");
        toDownload.push({
          path: inv.path,
          outPath: join(baseOut, "by-scope", provider, scopeId, "Invoice.json"),
          userId: null,
          provider,
          scopeId,
        });
      }
    }
  }

  for (const { path: bucketPath, outPath } of toDownload) {
    const [buf] = await bucket.file(bucketPath).download();
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buf.toString("utf8"), "utf8");
    console.log("Wrote", outPath);
  }

  console.log("\n--- Summary ---");
  console.log("Bucket: gs://" + bucketName);
  console.log("Total objects under accounting/:", files.length);
  if (byUser.size > 0) {
    console.log("Grouped by user:", byUser.size, "users");
    for (const s of invoiceSummary) {
      console.log("  User", s.userId, "| QBO realms:", s.qbo.join(", ") || "(none)", "| Xero tenants:", s.xero.join(", ") || "(none)", "| Invoices:", s.invoiceFiles);
    }
  } else {
    console.log("Grouped by scope:", byScope.size, "scopes");
    for (const [key, items] of byScope) {
      const invCount = items.filter((i) => i.entityType === "Invoice").length;
      if (invCount > 0) console.log(" ", key, "| Invoices:", invCount);
    }
  }
  console.log("Extracted", toDownload.length, "Invoice.json file(s) to", baseOut);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
