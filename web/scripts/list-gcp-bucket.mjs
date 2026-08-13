#!/usr/bin/env node
/**
 * List objects in GCP_ENTITY_BUCKET. Usage:
 *   GCP_ENTITY_BUCKET=profitwise-storage2026 GCP_SERVICE_KEY_JSON="$(cat path/to/key.json)" node scripts/list-gcp-bucket.mjs
 *   Or with key file: node scripts/list-gcp-bucket.mjs ../profitwise-mainapp-f52e3eeb98a7.json
 */
import { Storage } from "@google-cloud/storage";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

let bucketName = process.env.GCP_ENTITY_BUCKET;
let credentials = null;

const keyPath = process.argv[2];
if (keyPath) {
  const abs = join(process.cwd(), keyPath);
  credentials = JSON.parse(readFileSync(abs, "utf8"));
}
if (!credentials && process.env.GCP_SERVICE_KEY_JSON) {
  credentials = JSON.parse(process.env.GCP_SERVICE_KEY_JSON);
}

if (!bucketName) {
  console.error("Set GCP_ENTITY_BUCKET or pass bucket as second arg");
  process.exit(1);
}

const storage = new Storage(credentials ? { credentials, projectId: credentials.project_id } : {});
const bucket = storage.bucket(bucketName);

async function main() {
  const [files] = await bucket.getFiles({ prefix: "accounting/" });
  console.log(`Bucket: gs://${bucketName}\nObjects: ${files.length}\n`);
  const byPrefix = {};
  for (const f of files) {
    const p = f.name.replace(/\/[^/]+\.json$/, "");
    byPrefix[p] = (byPrefix[p] || 0) + 1;
  }
  const sorted = Object.entries(byPrefix).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [prefix, count] of sorted) {
    console.log(`  ${prefix}/  (${count} file(s))`);
  }
  console.log("\nAll paths:");
  files.forEach((f) => console.log(`  ${f.name}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
