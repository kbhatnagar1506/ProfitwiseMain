# Database setup: Cloud SQL (GCP) and DATABASE_URL (production only)

This guide is for **production only**. Use it to create a Postgres database on GCP Cloud SQL, allow your production app to connect, and set `DATABASE_URL` in the production environment (e.g. Heroku).

---

## 1. Create a Postgres instance (GCP Cloud SQL)

1. In [Google Cloud Console](https://console.cloud.google.com), open **SQL** (Cloud SQL).
2. Click **Create instance** → choose **PostgreSQL**.
3. Set instance ID (e.g. `profitwise-db`), password for the default user, region, and tier.
4. Under **Connections**:
   - For **Public IP**: enable and note the **Public IP address** (needed for IP allowlist or Proxy).
   - For **Private IP** (VPC): enable if your app runs in the same VPC (e.g. GKE, Cloud Run with VPC connector).
5. Create the instance, then create a **database** (e.g. `profitwise`) and a **user** (or use the postgres user and a strong password).

**Connection string format:**

```text
postgres://USER:PASSWORD@HOST:5432/DATABASE
```

- **USER**: Cloud SQL user (e.g. `postgres` or a dedicated user).
- **PASSWORD**: That user’s password (URL-encode special characters).
- **HOST**: Public IP, or Private IP (see connectivity options below).
- **DATABASE**: Database name (e.g. `profitwise`).

Example:

```text
postgres://profitwise_user:MyP%40ss@34.123.45.67:5432/profitwise
```

---

## 2. Allow connections from production

Your **production** app (Heroku, Cloud Run, GKE, etc.) must be allowed to reach Cloud SQL. Use one of the following.

### Option A: Cloud SQL Proxy (recommended for Heroku)

Run the Proxy in production so the app connects via a secure channel.

1. **Connection name:**  
   In Cloud Console → your instance → **Overview** → **Connection name** (e.g. `my-project:us-central1:profitwise-db`).

2. **Heroku:**  
   Use the [Heroku Cloud SQL addon](https://elements.heroku.com/addons/cloud-sql). It runs the Proxy and sets `DATABASE_URL` for you. Alternatively, run the Proxy as a sidecar/worker and point the web dyno at it; then set `DATABASE_URL` with the host/port the Proxy exposes.

### Option B: Private Service Connect (GCP-only)

If the app runs on GCP (e.g. Cloud Run, GKE):

1. In Cloud SQL → **Connections** → enable **Private IP** and configure the allocated range.
2. Use [Private Service Connect](https://cloud.google.com/sql/docs/postgres/configure-private-service-connect) or a VPC connector so your service can reach the instance’s private IP.
3. **DATABASE_URL** uses the instance **Private IP** as host:
   ```text
   DATABASE_URL=postgres://USER:PASSWORD@10.x.x.x:5432/DATABASE
   ```

### Option C: Public IP + authorized networks (IP allowlist)

If production has a **fixed outbound IP** (e.g. Heroku with [Static IP](https://devcenter.heroku.com/articles/static-ip-geolocation)):

1. In Cloud SQL → **Connections** → **Networking** → **Add network**.
2. Add your production outbound IP and a name (e.g. `Heroku`).
3. **DATABASE_URL** uses the instance **Public IP**:
   ```text
   DATABASE_URL=postgres://USER:PASSWORD@PUBLIC_IP:5432/DATABASE
   ```

Without a static IP, use **Option A** (Cloud SQL Proxy / addon) so Cloud SQL can be reached from Heroku.

---

## 3. Set DATABASE_URL in production

### Heroku

Set the config var (replace with your real URL; do not commit it):

```bash
heroku config:set DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DATABASE" --app profitwise-login-page
```

If you use the Heroku Postgres addon instead of Cloud SQL:

```bash
heroku addons:create heroku-postgresql:essential-0 --app profitwise-login-page
```

Heroku sets `DATABASE_URL` automatically. For Cloud SQL, set it manually as above.

### Verify in production

```bash
heroku config:get DATABASE_URL --app profitwise-login-page
```

If you see a value (starts with `postgres://`), it’s set. Don’t paste the full URL in public places.

---

## Summary checklist

- [ ] Cloud SQL Postgres instance created; database and user exist.
- [ ] Connections allowed from production: **Cloud SQL Proxy** (e.g. Heroku addon), or **Private Service Connect**, or **Public IP + authorized networks**.
- [ ] `DATABASE_URL` set in **production** (Heroku Config Vars or your host’s environment).
- [ ] App code uses `process.env.DATABASE_URL`; no URL committed in repo.
