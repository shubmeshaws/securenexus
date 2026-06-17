<div align="center">

<img src="github-image.png" alt="SECURENEXUS" width="520" />

<br />

### Pod Schedule Manager for Kubernetes, EC2 & ArgoCD

Automate workload shutdown and startup windows for **EKS** and **EC2**, cut non-production costs, and keep full audit visibility across your clusters.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js&logoColor=white)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16+-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Hub-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/r/securenexusapp/securenexus)
[![Docs](https://img.shields.io/badge/docs-setup-blue)](https://github.com/securenexus/SecureNexus#ec2-deployment-step-by-step)
[![PM2](https://img.shields.io/badge/PM2-production-2B037A?logo=pm2&logoColor=white)](https://pm2.keymetrics.io/)

</div>

---

## What is SecureNexus?

**SecureNexus** is an open-source **Pod Schedule Manager** for teams running **Amazon EKS** with **ArgoCD**. It lets you:

- **Schedule automated shutdown & startup** for Deployments and StatefulSets (daily or one-time windows)
- **Schedule EC2 stop/start** (Non-EKS / manual instances) using named AWS accounts from Admin → Settings
- **Scale entire namespaces** with optional workload exclusions
- **Manage multiple named AWS credentials** (optional IAM role assumption for least-privilege keys)
- **Pause & restore ArgoCD sync** during stop/start windows
- **Track live schedules** with countdown timers and manual override actions
- **Manage multiple ArgoCD instances** from a single admin panel
- **Register multiple Kubernetes clusters** via kubeconfig
- **Monitor cost savings** from scheduled downtime with trend charts and schedule action history
- **Dashboard stop-time analytics** for EKS namespaces and standalone EC2 (from activity logs)
- **Export activity logs** to CSV and PDF with date ranges
- **Send alerts** via email, Microsoft Teams, and in-app notifications
- **Control user permissions** per schedule (edit, start, stop, live stop)
- **Authenticate with Google SSO** and role-based access (Admin, Analyst, Viewer)

Built with **Next.js 14**, **PostgreSQL**, **Prisma**, **Kubernetes client**, and a built-in **minute-level cron scheduler**.

---

## Table of Contents

- [Dashboard](#dashboard)
- [Schedules (EKS & Non-EKS)](#schedules-eks--non-eks)
- [Prerequisites (EC2)](#prerequisites-ec2)
- [EC2 Deployment (Step by Step)](#ec2-deployment-step-by-step)
- [Local Development](#local-development)
- [Production with PM2](#production-with-pm2)
- [Docker](#docker)
- [Docker Hub Image](#docker-hub-image)
- [Environment Variables](#environment-variables)
- [First-Time Setup Wizard](#first-time-setup-wizard)
- [Database Schema (Prisma)](#database-schema-prisma)
- [Upgrading an Existing Install](#upgrading-an-existing-install)
- [Security Group Ports](#security-group-ports)
- [Expose with nginx (HTTP & HTTPS)](#expose-with-nginx-http--https)
- [Google OAuth setup](#google-oauth-setup)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [License](#license)
- [Give a Star](#give-a-star-)

---

## Dashboard

The **Dashboard** (`/dashboard`) is the live overview for cost and stop-time visibility.

| Feature | Description |
|---------|-------------|
| **Environment uptime** | Shown beside the page title — total up time and when the current running period started |
| **Global date filter** | One **Period** control at the top (7 / 14 / 30 days or custom range). Default is **14 days**. Applies to all charts and stop-time tables on the page |
| **Cost savings trend** | Estimated daily savings from logged stop→start windows (line or bar chart), grouped by cluster |
| **Schedule actions** | Daily shutdown vs startup counts; click a bar to open filtered **Activity** logs |
| **Kubernetes stop time** | EKS namespace stop→start duration from schedules, manual runs, and infrastructure actions |
| **Standalone stop time** | Non-EKS EC2 instance stop→start duration for the selected period |
| **Refresh** | **Refresh** button in the page header refetches only this page’s data (no full browser reload) |
| **Live updates** | Charts and stop-time tables refresh on an interval; changing the date filter updates data in place without reloading the whole page |

Stop-time values are computed from **successful** activity log entries (`schedule-shutdown`, `scale-down`, `infra-shutdown` paired with matching startup actions). Data refreshes automatically about every 30 seconds.

---

## Schedules (EKS & Non-EKS)

### EKS schedules

- Pick a **registered cluster** (Clusters page), then namespace and workload — or an entire namespace with optional exclusions
- Cluster list loads from the database; namespaces use Kubernetes API with fast fallbacks (schedules, audit history) when the API is slow
- EKS auth tokens are cached to speed up namespace and workload loading

### Non-EKS (EC2) schedules

- Select an **AWS account** from Admin → Settings → AWS Integration, then choose instance(s)
- **Single instance** — one schedule for one EC2 instance
- **Multiple instances** — select several instances; SecureNexus creates **one schedule per instance** with the same timing
- The instance picker **excludes EKS-managed nodes** tagged with `eks:cluster-name`, `eks:eks-cluster-name`, `eks:nodegroup-name`, or `kubernetes.io/cluster/*=owned`
- Instance discovery is cached and scoped to the credential’s default region (plus regions already used in schedules) for faster loading

Every app page includes a **Refresh** button in the header to reload that page’s data only.

---

## Prerequisites (EC2)

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| **OS** | Ubuntu 22.04 / 24.04 / 26.04 LTS | Ubuntu 24.04 LTS |
| **Instance type** | `t3.small` (2 vCPU) | `t3.medium` (2 vCPU) |
| **Memory** | 2 GB RAM | 4 GB RAM |
| **EBS volume** | 20 GB `gp3` | 30 GB `gp3` |
| **Network** | Elastic IP (optional but recommended) | Elastic IP attached |

### Software prerequisites

| Software | Version |
|----------|---------|
| Node.js | 20.x LTS |
| npm | 10.x |
| PostgreSQL | 15+ (16 recommended) |
| Git | Latest |
| PM2 | Latest (production) |
| Docker & Docker Compose | Latest (optional, for container deploy) |

### Outbound access required

The EC2 instance must reach:

- Your **EKS API endpoints** (via kubeconfig)
- Your **ArgoCD server** URL(s)
- **Google OAuth** endpoints (if using Google SSO)
- **AWS APIs** (EC2/EKS/STS) when using Admin → AWS Integration or Non-EKS schedules
- **SMTP / Teams webhook** (if using alerts)

---

## Security Group Ports

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| **22** | TCP | Your IP / bastion | SSH access |
| **3005** | TCP | Private subnet / same host only | SecureNexus app (PM2) — **do not expose publicly** when using nginx |
| **80** | TCP | `0.0.0.0/0` | HTTP — nginx reverse proxy (public access) |
| **443** | TCP | `0.0.0.0/0` | HTTPS — nginx + TLS |
| **5432** | TCP | **Do not expose publicly** | PostgreSQL (localhost / private subnet only) |

> **Tip:** Do **not** expose port **3005** to the internet. Run SecureNexus on a private IP (or localhost) and put **nginx** on the public IP for HTTP/HTTPS. See [Expose with nginx (HTTP & HTTPS)](#expose-with-nginx-http--https).

---

## Expose with nginx (HTTP & HTTPS)

Browsers reach SecureNexus through **nginx** on ports **80** / **443**. The Next.js app stays on **port 3005** (PM2) and is not opened to the public internet.

### Architecture (recommended)

```text
Browser  →  http://13.201.60.211        (public IP, nginx :80)
         →  http://10.1.14.230:3005   (private IP, SecureNexus / PM2)
```

| Server | Role | Example IP | Port |
|--------|------|------------|------|
| Nginx host | Public reverse proxy | `13.201.60.211` | 80, 443 |
| App host | SecureNexus (PM2) | `10.1.14.230` | 3005 |

**Security groups**

- **Nginx host:** inbound **80**, **443** (and **22** for SSH)
- **App host:** inbound **3005** only from nginx host private IP / VPC (not `0.0.0.0/0`)

---

### HTTP (public IP, no domain)

Use `scripts/nginx-securenexus-http.conf` on the **nginx server** (public IP `13.201.60.211`):

```nginx
server {
    listen 80;
    server_name 13.201.60.211;

    client_max_body_size 50M;

    location / {
        proxy_pass http://10.1.14.230:3005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

**Install on nginx server:**

```bash
sudo apt install -y nginx
sudo cp scripts/nginx-securenexus-http.conf /etc/nginx/sites-available/securenexus
sudo sed -i 's/PUBLIC_IP/13.201.60.211/g; s/APP_PRIVATE_IP/10.1.14.230/g' \
  /etc/nginx/sites-available/securenexus
sudo ln -sf /etc/nginx/sites-available/securenexus /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

**On the app server** (`10.1.14.230`), set `.env`:

```env
NEXT_PUBLIC_APP_URL=http://13.201.60.211
```

```bash
npm run build
pm2 restart securenexus
```

Open in browser: **`http://13.201.60.211/getting-started`** (no `:3005`).

---

### HTTPS (domain name required)

Let's Encrypt needs a **domain** (not a bare IP). Point DNS **A record** → `13.201.60.211`, then use `scripts/nginx-securenexus-https.conf`.

**1. HTTP config first** (for certbot challenge):

```bash
sudo sed -i 's/PUBLIC_IP/securenexus.example.com/g; s/APP_PRIVATE_IP/10.1.14.230/g' \
  /etc/nginx/sites-available/securenexus
# Use YOUR_DOMAIN in server_name instead of IP for HTTPS path
```

**2. Obtain certificate:**

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d securenexus.example.com
```

Certbot installs SSL and can merge settings from `scripts/nginx-securenexus-https.conf`. Manual template:

```nginx
server {
    listen 80;
    server_name securenexus.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name securenexus.example.com;

    ssl_certificate     /etc/letsencrypt/live/securenexus.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/securenexus.example.com/privkey.pem;

    client_max_body_size 50M;

    location / {
        proxy_pass http://10.1.14.230:3005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

**App server `.env`:**

```env
NEXT_PUBLIC_APP_URL=https://securenexus.example.com
```

```bash
npm run build
pm2 restart securenexus
```

Open: **`https://securenexus.example.com/getting-started`**

**Renewal:** `sudo certbot renew` (add to cron; certbot installs a systemd timer on Ubuntu).

---

### Same server (nginx + app on one EC2)

If PM2 and nginx run on the **same** machine, use `scripts/nginx-securenexus.conf` (`proxy_pass http://127.0.0.1:3005`).

---

### Verify

**On nginx server:**

```bash
curl -s http://13.201.60.211/api/setup/status
```

**From your laptop:**

```bash
curl -s http://13.201.60.211/api/setup/status
```

Both should return JSON. If nginx works locally but not from laptop → open **TCP 80** (and **443** for HTTPS) on the **nginx host** Security Group.

---

## Security Group checklist (browser not loading)

| Check | Command / action |
|-------|------------------|
| App listening | `ss -tlnp \| grep 3005` → should show `*:3005` |
| Works locally | `curl http://127.0.0.1:3005/api/setup/status` |
| Ubuntu firewall | `sudo ufw allow 80/tcp` and/or `sudo ufw allow 443/tcp` on nginx host |
| **AWS inbound rule** | Nginx host SG → Custom TCP **80** and **443**; app host SG → **3005** from nginx private IP only |
| Correct SG attached | Same security group shown on the instance you SSH into |
| Public IP | Nginx instance has **Public IPv4** `13.201.60.211` (or Elastic IP) |
| URL | `http://PUBLIC_IP` or `https://YOUR_DOMAIN` via nginx — not `:3005` publicly |

Test from your laptop:

```bash
curl -v --connect-timeout 5 http://13.201.60.211/api/setup/status
```

If this **times out** but curl on the server works → **Security Group** (or subnet NACL) is blocking inbound **80/443** on the nginx host. The app on `:3005` should stay private behind nginx.

---

## Google OAuth setup

SecureNexus uses Google SSO. You must create a **dedicated OAuth client** for SecureNexus — do **not** reuse credentials from another app (Grafana, etc.). If Google shows *"Prismforce - Grafana"* or another app name on the error screen, your `GOOGLE_CLIENT_ID` belongs to the wrong project.

### 1. Create credentials (Google Cloud Console)

1. Open [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials**.
2. **Create project** (or pick an existing one for SecureNexus).
3. **OAuth consent screen** → configure:
   - User type: **Internal** (Google Workspace only) or **External** (any Google account)
   - App name: e.g. **SecureNexus**
   - Support email: your email
   - Scopes: add `openid`, `email`, `profile` (or leave defaults)
   - If **Testing**: add your Google account under **Test users**
4. **Credentials** → **Create credentials** → **OAuth client ID**:
   - Application type: **Web application**
   - Name: `SecureNexus`
   - **Authorized JavaScript origins** (optional for server-side flow):
     - `http://13.201.60.211` (your public IP)
     - or `https://securenexus.example.com` if using HTTPS
   - **Authorized redirect URIs** — must match **exactly** (character-for-character):

```text
http://13.201.60.211/api/auth/google/callback
```

For HTTPS with a domain:

```text
https://securenexus.example.com/api/auth/google/callback
```

5. Copy **Client ID** and **Client secret** into the app server `.env`.

### 2. Match `NEXT_PUBLIC_APP_URL`

The redirect URI is built as:

```text
{NEXT_PUBLIC_APP_URL}/api/auth/google/callback
```

| How users access the app | `NEXT_PUBLIC_APP_URL` | Redirect URI to register in Google |
|--------------------------|----------------------|-------------------------------------|
| nginx HTTP (public IP) | `http://13.201.60.211` | `http://13.201.60.211/api/auth/google/callback` |
| nginx HTTPS (domain) | `https://securenexus.example.com` | `https://securenexus.example.com/api/auth/google/callback` |
| Local dev | `http://localhost:3005` | `http://localhost:3005/api/auth/google/callback` |

**Common mistakes**

- `NEXT_PUBLIC_APP_URL` still has `:3005` while users open `http://IP` (nginx) → redirect mismatch
- Trailing slash on URL (`http://IP/`) → wrong redirect URI
- Reusing another app's Client ID (Grafana, etc.) → **Error 400: invalid_request** / OAuth policy error
- Consent screen in **Testing** but your account is not listed as a **Test user**

### 3. Apply on the server

```bash
nano .env
# GOOGLE_CLIENT_ID=....apps.googleusercontent.com
# GOOGLE_CLIENT_SECRET=GOCSPX-...
# NEXT_PUBLIC_APP_URL=http://13.201.60.211

npm run build
pm2 restart securenexus
```

### 4. Verify

Open login → **Sign in with Google**. The Google screen should show your app name (**SecureNexus**), not another product.

If it still fails, click **error details** on Google's page — `redirect_uri_mismatch` means the URI in the request is not listed in the OAuth client. Compare the `redirect_uri` in the error with your Google Console entry and `.env`.

---

## EC2 Deployment (Step by Step)

### Step 1 — Launch & connect to EC2

1. Launch an **Ubuntu** EC2 instance with the [prerequisites](#prerequisites-ec2) above.
2. Attach a security group with the [ports](#security-group-ports) you need.
3. SSH into the machine:

```bash
ssh -i your-key.pem ubuntu@<EC2_PUBLIC_IP>
```

### Step 2 — Update system packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential ca-certificates gnupg
```

### Step 3 — Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # should print v20.x
npm -v
```

### Step 4 — Install PostgreSQL

```bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql
```

Create database and user (**required on PostgreSQL 15+** — schema `public` permissions must be granted explicitly).

Use an **alphanumeric-only** password (no `@`, `:`, `#`, `%`) so `DATABASE_URL` in `.env` stays simple.

```bash
sudo -u postgres psql <<'EOF'
CREATE USER securenexus WITH PASSWORD 'your_strong_db_password';
CREATE DATABASE securenexus OWNER securenexus;
\c securenexus
ALTER SCHEMA public OWNER TO securenexus;
GRANT ALL ON SCHEMA public TO securenexus;
GRANT CREATE ON SCHEMA public TO securenexus;
GRANT USAGE ON SCHEMA public TO securenexus;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO securenexus;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO securenexus;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO securenexus;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO securenexus;
EOF
```

Or use the bundled script (edit the password inside first):

```bash
nano scripts/init-postgres.sql   # set your password
sudo -u postgres psql -f scripts/init-postgres.sql
```

**If the database already exists** but `npm run db:push` fails with `denied access on securenexus.public` (Prisma **P1010**), run this fix as `postgres`:

```bash
sudo -u postgres psql -d securenexus <<'EOF'
ALTER SCHEMA public OWNER TO securenexus;
GRANT ALL ON SCHEMA public TO securenexus;
GRANT CREATE ON SCHEMA public TO securenexus;
GRANT USAGE ON SCHEMA public TO securenexus;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO securenexus;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO securenexus;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO securenexus;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO securenexus;
EOF
```

Remote Postgres (replace host and use the `postgres` superuser password when prompted):

```bash
psql -h 10.1.14.230 -U postgres -d securenexus -f scripts/fix-postgres-public-schema.sql
```

Then run `npm run db:push` again.

### Step 5 — Clone the repository

```bash
sudo mkdir -p /opt/securenexus
sudo chown $USER:$USER /opt/securenexus
cd /opt/securenexus

git clone https://github.com/YOUR_ORG/SecureNexus.git .
# Or your fork:
# git clone https://github.com/YOUR_USERNAME/SecureNexus.git .
```

### Step 6 — Configure environment

```bash
cp .env.example .env
nano .env
```

Minimum `.env` for EC2:

```env
DATABASE_URL=postgresql://securenexus:your_strong_db_password@localhost:5432/securenexus?schema=public
```

Use the **same password** as in Step 4. Prefer letters and numbers only (no `@`, `:`, `#`) to avoid Prisma **P1013** URL errors. For remote Postgres, set the host to your DB IP (e.g. `10.1.14.230`).

```env
JWT_SECRET=generate-a-long-random-secret-here
NEXT_PUBLIC_APP_URL=http://<EC2_PUBLIC_IP>

GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
```

> Use the **public URL users open in the browser** (nginx on port 80 → no `:3005`). See [Google OAuth setup](#google-oauth-setup).

> ArgoCD, kubeconfig, and most integrations are configured later in **Admin → Settings** (stored in the database).

### Step 7 — Install dependencies & initialize database

```bash
npm install
npm run db:push    # creates / syncs all tables from prisma/schema.prisma
npm run build
```

> **Important:** Always run `npm run db:push` after pulling a new version. This applies new Prisma models (for example `AwsCredential`, schedule `platformType` fields) without manual SQL migrations.

### Step 8 — Open the setup wizard

Start the app once to complete onboarding:

```bash
npm run start
```

Visit `http://<EC2_PUBLIC_IP>/getting-started` if nginx is in front (recommended), or `http://<EC2_PUBLIC_IP>:3005/getting-started` for direct access during setup. Complete:

1. Database connection check
2. Schema initialization
3. Admin user creation

Stop the temporary process with `Ctrl+C`, then continue to PM2 for production.

> **Website not loading?** Run these on the **app server** before opening the browser:
>
> ```bash
> # 1. App must be running (not stopped after Ctrl+C)
> ss -tlnp | grep 3005
> curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3005/api/setup/status
>
> # 2. If using nginx on a public host, verify proxy (see Expose with nginx section)
> curl -s http://<PUBLIC_IP>/api/setup/status
>
> # 3. Open AWS Security Group on nginx host: TCP 80 (and 443 for HTTPS)
> #    Do not expose 3005 to 0.0.0.0/0 — only nginx → app on private network
> ```
>
> Set `NEXT_PUBLIC_APP_URL` in `.env` to the public URL users open in the browser (e.g. `http://<PUBLIC_IP>` or `https://your-domain.com`), not `localhost` or `:3005` when behind nginx.

---

## Local Development

```bash
# 1. Clone
git clone https://github.com/YOUR_ORG/SecureNexus.git
cd SecureNexus

# 2. Install
npm install

# 3. Environment
cp .env.example .env
# Edit DATABASE_URL, JWT_SECRET, Google OAuth credentials

# 4. Database — sync Prisma schema to PostgreSQL
npm run db:push

# 5. Run dev server (hot reload on port 3005)
npm run dev
```

Open [http://localhost:3005](http://localhost:3005)

---

## Production with PM2

PM2 keeps the Next.js server running, restarts on failure, and survives SSH logout.

### Install PM2

```bash
sudo npm install -g pm2
```

### Start SecureNexus

From the project root (`/opt/securenexus`):

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
# Run the command PM2 prints, then:
pm2 save
```

Confirm the app is listening on all interfaces:

```bash
pm2 logs securenexus --lines 30
curl -s http://127.0.0.1:3005/api/setup/status
ss -tlnp | grep 3005
```

You should see `0.0.0.0:3005` (or `*:3005`) in `ss` output. Then open `http://<EC2_PUBLIC_IP>:3005` in your browser.

### Useful PM2 commands

```bash
pm2 status
pm2 logs securenexus
pm2 restart securenexus
pm2 stop securenexus
```

The built-in **schedule cron runner** starts automatically via Next.js instrumentation — no separate worker process is required.

---

## Docker

### Option A — Docker Compose (app + PostgreSQL)

```bash
git clone https://github.com/YOUR_ORG/SecureNexus.git
cd SecureNexus
cp .env.example .env
# Set JWT_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, NEXT_PUBLIC_APP_URL

docker compose up -d --build
```

App: [http://localhost:3005](http://localhost:3005)

View logs:

```bash
docker compose logs -f app
```

Stop:

```bash
docker compose down
```

### Option B — App image only (external PostgreSQL)

```bash
docker build -t securenexusapp/securenexus:latest .

docker run -d \
  --name securenexus \
  -p 3005:3005 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/securenexus?schema=public" \
  -e JWT_SECRET="your-jwt-secret" \
  -e NEXT_PUBLIC_APP_URL="https://securenexus.example.com" \
  -e GOOGLE_CLIENT_ID="..." \
  -e GOOGLE_CLIENT_SECRET="..." \
  securenexusapp/securenexus:latest
```

Initialize schema (first run):

```bash
docker compose exec app npm run db:push
```

---

## Docker Hub Image

Pull the pre-built image:

```bash
docker pull shubmeshaws/securenexus:latest
```

**Docker Hub:** [https://hub.docker.com/r/shubmeshaws/securenexus](https://hub.docker.com/r/securenexusapp/securenexus)

### Push your own image to Docker Hub

```bash
docker login
docker build -t YOUR_DOCKERHUB_USERNAME/securenexus:latest .
docker push YOUR_DOCKERHUB_USERNAME/securenexus:latest
```

Replace `YOUR_DOCKERHUB_USERNAME` with your Docker Hub account name.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Secret for signing session tokens |
| `NEXT_PUBLIC_APP_URL` | Yes | Public app URL (OAuth redirects) |
| `GOOGLE_CLIENT_ID` | Yes* | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes* | Google OAuth client secret |
| `ARGOCD_SERVER` | No | Bootstrap ArgoCD URL (or set in Admin UI) |
| `ARGOCD_TOKEN` | No | Bootstrap ArgoCD token (or set in Admin UI) |
| `KUBECONFIG_BASE64` | No | Base64 kubeconfig (or add clusters in UI) |
| `ARGOCD_INSECURE_TLS` | No | Set `true` for self-signed ArgoCD TLS |

\* Required for Google SSO login.

Most settings (ArgoCD instances, clusters, **AWS accounts**, alerts, retention) are configured in **Admin → Settings** after first login — AWS access keys are **not** stored in `.env`.

---

## First-Time Setup Wizard

1. Start the application (`npm run dev`, `npm start`, PM2, or Docker).
2. Navigate to `/getting-started`.
3. Verify PostgreSQL connectivity.
4. **Initialize / sync database schema** — runs `prisma db push` (creates all tables on a fresh DB, or adds new columns/tables on upgrade).
5. Sign in with Google — new users are created as **viewer** with **Access enabled**, limited to **Dashboard**, **Schedules** (view only), and **Live Schedules** (stop access). Admins can expand access under **Admin → Users**.
6. Configure integrations in **Admin → Settings** (AWS accounts, ArgoCD, clusters, alerts).

---

## Database Schema (Prisma)

Schema lives in `prisma/schema.prisma`. SecureNexus uses **`prisma db push`** (not checked-in SQL migrations) to keep PostgreSQL in sync with the Prisma models.

| Model / area | Purpose |
|--------------|---------|
| `User` | Google SSO users, roles, page permissions, access enabled flag |
| `Schedule` | EKS and Non-EKS (EC2) schedules — includes `platformType`, `awsCredentialId`, `ec2InstanceId`, `ec2Region` |
| `AwsCredential` | Named AWS accounts (encrypted keys, optional `iamRoleName`, cached `awsAccountId`) |
| `Cluster` | Registered kubeconfig or AWS EKS clusters |
| `ArgoCDInstance` | Multiple ArgoCD servers |
| `SystemSetting` | Encrypted app settings (legacy single AWS keys may migrate into `AwsCredential`) |
| `ActivityLog` | Schedule run audit trail |

**Fresh install commands:**

```bash
npm install          # runs prisma generate via postinstall
npm run db:push      # apply schema to empty PostgreSQL
npm run build
```

**After `git pull` on an existing server**, run `npm run db:push` before restarting the app so new tables/columns exist — otherwise API routes that touch new models (e.g. AWS Integration) will fail.

---

## Upgrading an Existing Install

```bash
git pull
npm install
npm run db:push      # sync new Prisma fields / tables
npm run build
pm2 restart securenexus   # or npm run start
```

Alternatively, open `/getting-started` and run the schema step — it now **syncs** the latest schema even when tables already exist.

Configure **Admin → Settings → AWS Integration** for EC2 (Non-EKS) scheduling: add named AWS accounts, test connection, optionally set an IAM role to assume. When creating Non-EKS schedules, use **Multiple instances** to bulk-create schedules with the same window.

---

## Database connection troubleshooting

| Prisma error | Cause | Fix |
|--------------|-------|-----|
| **P1013** invalid port in URL | Password contains `@`, `:`, `#`, `%`, etc. without URL encoding | Encode password (see below) or use alphanumeric-only password |
| **P1000** authentication failed | Wrong user/password in `.env` | `ALTER USER securenexus WITH PASSWORD '...'` then match `.env` |
| **P1010** denied access on `securenexus.public` | PostgreSQL 15+ `public` schema permissions | Run the `sudo -u postgres psql -d securenexus` grant block in [Step 4](#step-4--install-postgresql) or `scripts/fix-postgres-public-schema.sql` |

**URL-encode a password for `DATABASE_URL`:**

```bash
node -e "console.log(encodeURIComponent('your@actual#password'))"
```

Use the output in place of the raw password:

```env
DATABASE_URL=postgresql://securenexus:ENCODED_OUTPUT@10.1.14.230:5432/securenexus?schema=public
```

**Why `@` breaks URLs:** `postgresql://user:pass@word@host:5432/db` is parsed as host `word` and an invalid port — always encode `@` as `%40` in the password.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 14, React 18, TypeScript, Tailwind CSS |
| State | TanStack Query, Zustand |
| Backend | Next.js API Routes, node-cron |
| Database | PostgreSQL + Prisma ORM |
| Integrations | Kubernetes client, ArgoCD REST API, AWS SDK (EKS, EC2, STS) |
| Auth | JWT + Google OAuth |
| Alerts | Nodemailer, Teams webhooks, in-app notifications |

---

## Project Structure

```
SecureNexus/
├── prisma/schema.prisma       # Database models (User, Schedule, AwsCredential, …)
├── src/
│   ├── app/                   # Next.js App Router pages
│   ├── components/
│   │   ├── dashboard/         # Cost trend, schedule actions, date filter
│   │   └── pod-scheduler/     # Schedules, clusters, activity, admin UI
│   ├── lib/
│   │   ├── dashboard-metrics.ts      # Stop-time insights from activity logs
│   │   ├── dashboard-date-range.ts   # Shared dashboard period filter
│   │   ├── stopped-activity-logs.ts  # Stop/start log queries for analytics
│   │   ├── scheduler-runner.ts
│   │   ├── k8s-client.ts
│   │   ├── argocd-client.ts
│   │   └── ...
│   └── pages/api/             # REST API routes
├── Dockerfile
├── docker-compose.yml
├── ecosystem.config.cjs       # PM2 production config
└── .env.example
```

---

## License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

## Give a Star! ⭐

If you like or are using this project, please **give it a star**. Thanks!

---

<div align="center">

<img src="github-image.png" alt="SECURENEXUS" width="360" />

<br />

**Stop wasting cloud spend. Start scheduling smarter.**

</div>
