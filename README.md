<div align="center">

<img src="github-image.png" alt="SECURENEXUS" width="520" />

<br />

### Pod Schedule Manager for Kubernetes & ArgoCD

Automate workload shutdown and startup windows, cut non-production costs, and keep full audit visibility across your EKS clusters.

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
- **Scale entire namespaces** with optional workload exclusions
- **Pause & restore ArgoCD sync** during stop/start windows
- **Track live schedules** with countdown timers and manual override actions
- **Manage multiple ArgoCD instances** from a single admin panel
- **Register multiple Kubernetes clusters** via kubeconfig
- **Monitor cost savings** from scheduled downtime
- **Export activity logs** to CSV and PDF with date ranges
- **Send alerts** via email, Microsoft Teams, and in-app notifications
- **Control user permissions** per schedule (edit, start, stop, live stop)
- **Authenticate with Google SSO** and role-based access (Admin, Analyst, Viewer)

Built with **Next.js 14**, **PostgreSQL**, **Prisma**, **Kubernetes client**, and a built-in **minute-level cron scheduler**.

---

## Table of Contents

- [Prerequisites (EC2)](#prerequisites-ec2)
- [EC2 Deployment (Step by Step)](#ec2-deployment-step-by-step)
- [Local Development](#local-development)
- [Production with PM2](#production-with-pm2)
- [Docker](#docker)
- [Docker Hub Image](#docker-hub-image)
- [Environment Variables](#environment-variables)
- [First-Time Setup Wizard](#first-time-setup-wizard)
- [Security Group Ports](#security-group-ports)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [License](#license)
- [Give a Star](#give-a-star-)

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
- **SMTP / Teams webhook** (if using alerts)

---

## Security Group Ports

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| **22** | TCP | Your IP / bastion | SSH access |
| **3005** | TCP | Your IP or ALB | SecureNexus web UI & API |
| **80** | TCP | `0.0.0.0/0` | Optional — HTTP (nginx reverse proxy) |
| **443** | TCP | `0.0.0.0/0` | Optional — HTTPS (nginx + TLS) |
| **5432** | TCP | **Do not expose publicly** | PostgreSQL (localhost / private subnet only) |

> **Tip:** In production, put **nginx** or an **ALB** in front of the app on ports 80/443 instead of exposing 3005 publicly.

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

Create database and user:

```bash
sudo -u postgres psql <<'EOF'
CREATE USER securenexus WITH PASSWORD 'your_strong_db_password';
CREATE DATABASE securenexus OWNER securenexus;
GRANT ALL PRIVILEGES ON DATABASE securenexus TO securenexus;
EOF
```

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
JWT_SECRET=generate-a-long-random-secret-here
NEXT_PUBLIC_APP_URL=http://<EC2_PUBLIC_IP>:3005

GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
```

> ArgoCD, kubeconfig, and most integrations are configured later in **Admin → Settings** (stored in the database).

### Step 7 — Install dependencies & initialize database

```bash
npm install
npx prisma db push
npm run build
```

### Step 8 — Open the setup wizard

Start the app once to complete onboarding:

```bash
npm run start
```

Visit `http://<EC2_PUBLIC_IP>:3005/getting-started` and complete:

1. Database connection check
2. Schema initialization
3. Admin user creation

Stop the temporary process with `Ctrl+C`, then continue to PM2 for production.

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

# 4. Database
npx prisma db push

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
docker exec -it securenexus npx prisma db push
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

Most settings (ArgoCD instances, clusters, alerts, retention) are managed in **Admin → Settings** after first login.

---

## First-Time Setup Wizard

1. Start the application (`npm run dev`, `npm start`, PM2, or Docker).
2. Navigate to `/getting-started`.
3. Verify PostgreSQL connectivity.
4. Create database tables (`prisma db push`).
5. Sign in with Google and configure integrations in **Admin → Settings**.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 14, React 18, TypeScript, Tailwind CSS |
| State | TanStack Query, Zustand |
| Backend | Next.js API Routes, node-cron |
| Database | PostgreSQL + Prisma ORM |
| Integrations | Kubernetes client, ArgoCD REST API |
| Auth | JWT + Google OAuth |
| Alerts | Nodemailer, Teams webhooks, in-app notifications |

---

## Project Structure

```
SecureNexus/
├── prisma/schema.prisma       # Database models
├── src/
│   ├── app/                   # Next.js App Router pages
│   ├── components/            # UI & feature components
│   ├── lib/                   # Core business logic
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
