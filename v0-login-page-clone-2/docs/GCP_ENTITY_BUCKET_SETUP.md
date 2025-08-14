# GCP Cloud Storage bucket for accounting entities

When **`GCP_ENTITY_BUCKET`** is set, QuickBooks and Xero synced entity data (invoices, contacts, etc.) is stored as JSON files in this bucket instead of Postgres. That avoids production schema mismatches (`user_id`, `payload` columns) and keeps large payloads off the database.

---

## 1. Create the bucket (GCP Console)

1. Open [Google Cloud Console](https://console.cloud.google.com) and select the **profitwise-mainapp** project (or your app’s project).
2. Go to **Cloud Storage** → **Buckets** → **Create**.
3. Name the bucket (e.g. `profitwise-storage2026`). Use a unique name; bucket names are global.
4. Choose a location (e.g. **us (multiple regions in United States)** for multi-region).
5. Create the bucket. You can leave access control as “Uniform” and keep it private.

---

## 2. Grant the service account access

The app uses a GCP service account (e.g. the one whose key is in `GCP_SERVICE_KEY_JSON`). That account needs permission to read/write objects in the bucket.

1. In GCP Console go to **Cloud Storage** → **Buckets** → open your bucket.
2. Open the **Permissions** tab → **Grant access**.
3. **New principals**: enter the service account email (e.g. `cloud-sql-proxy-240@profitwise-mainapp.iam.gserviceaccount.com`).
4. **Role**: choose **Storage Object Admin** (or a custom role with `storage.objects.create`, `storage.objects.get`, `storage.objects.delete`, `storage.objects.list`).
5. Save.

If you use a different service account for Cloud Storage, create a key for that account and use its JSON in `GCP_SERVICE_KEY_JSON` instead.

---

## 3. Set production config (e.g. Heroku)

Set these in your production environment (e.g. Heroku Config Vars):

| Config var             | Value |
|------------------------|--------|
| **GCP_ENTITY_BUCKET**  | Your bucket name (e.g. `profitwise-storage2026`). |
| **GCP_SERVICE_KEY_JSON** | Full contents of the service account JSON key (single line or multi-line string). |

**Heroku example:**

```bash
# Bucket name
heroku config:set GCP_ENTITY_BUCKET=profitwise-storage2026 --app profitwise-login-page

# Service account key (paste the entire JSON; escape single quotes if needed)
heroku config:set GCP_SERVICE_KEY_JSON="$(cat /path/to/your-service-account-key.json)" --app profitwise-login-page
```

After setting these and redeploying, QBO and Xero sync will read/write entity data from the bucket instead of Postgres. Connections and tokens still use Postgres.

---

## Paths in the bucket

- **QBO:** `accounting/qbo/{realmId}/{entityType}.json` (e.g. `accounting/qbo/9341456553171256/Invoice.json`).
- **Xero:** `accounting/xero/{tenantId}/{entityType}.json` (e.g. `accounting/xero/4fa0c9b6-.../Contact.json`).

Each file is a JSON array of entities for that type. If `GCP_ENTITY_BUCKET` is not set, the app falls back to Postgres (or in-memory in dev).
