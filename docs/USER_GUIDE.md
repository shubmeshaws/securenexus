# SecureNexus — User Guide

This guide explains how to use SecureNexus from a day-to-day user perspective. It covers the four main areas you will use most often: **Dashboard**, **Schedules**, **Live Schedules**, and **Contact**.

---

## Getting started

1. Open SecureNexus in your browser and sign in (for example, with Google SSO).
2. Use the **sidebar on the left** to move between pages.
3. On most pages, use the **Refresh** button in the top-right of the page header to reload that page’s data without refreshing the whole browser tab.

> **Note:** What you can see and do depends on your role. Some users can only view schedules; others can create, edit, run, or stop them. If an action button is missing, ask your admin to update your permissions under **Admin Panel → Users**.

---

## Dashboard

The **Dashboard** is your home for cost savings and stop-time visibility. Open it from the sidebar: **Dashboard**.

### What you see

| Area | What it shows |
|------|----------------|
| **Environment uptime** | Beside the page title — how long the environment has been up, or when it was last stopped |
| **Period filter** | One date control at the top that applies to all charts and tables on the page |
| **Cost savings trend** | Estimated daily savings from workloads that were stopped and later started again |
| **Schedule actions** | Daily count of shutdown vs startup actions |
| **Kubernetes workload stop time** | How long EKS namespaces were stopped during the selected period |
| **Standalone workload stop time** | How long Non-EKS EC2 instances were stopped during the selected period |

Data refreshes automatically about every **30 seconds**. A **Live** indicator beside the title shows when data was last updated.

---

### Step 1 — Open the Dashboard

1. Click **Dashboard** in the left sidebar.
2. Wait a moment for the page to load. The uptime line appears beside the **Dashboard** title once live data is available.

---

### Step 2 — Choose a time period

All charts and stop-time tables share one date filter at the top of the page.

1. Find the **Period** control below the page title.
2. Choose a preset:
   - **Last 7 days**
   - **Last 14 days** (default)
   - **Last 30 days**
   - **Custom range**
3. If you pick **Custom range**, set a **From** date and **To** date.
4. Charts and tables update in place — the page does not fully reload.

---

### Step 3 — Review cost savings

1. Look at the **Cost savings trend** chart on the left.
2. Each line or bar represents estimated savings for a cluster (or EC2 group) based on actual stop→start windows in activity logs.
3. Hover over the chart to see values for a specific day.

---

### Step 4 — Review schedule activity

1. Look at the **Schedule actions** chart on the right.
2. **Shutdown** and **Startup** bars show how many actions ran each day in the selected period.
3. **Click a bar** to open **Activity Logs** filtered to that day and action type.

---

### Step 5 — Review stop-time tables

Two tables appear below the charts.

**Kubernetes workload stop time (EKS)**

1. Scan the list of **Cluster**, **Namespace**, and **Stopped time**.
2. The bar beside each row shows stop duration relative to the longest entry.
3. Scroll inside the table if there are more rows than fit on screen.
4. Check the footer for **Total across EKS namespaces**.

**Standalone workload stop time (Non-EKS EC2)**

1. Scan **Instance name**, **Instance type**, and **Stopped time**.
2. Scroll for additional instances.
3. Check the footer for **Total across instances**.

Stop-time is calculated from successful activity log entries: shutdown actions paired with a matching startup. If a workload was started early (manually or by another schedule), the stopped window ends at that actual start time.

---

### Step 6 — Refresh or retry

1. Click **Refresh** in the page header to reload dashboard data immediately.
2. If a warning banner appears (for example, Kubernetes or ArgoCD unreachable), read the message and click **Retry** if offered.

---

## Schedules

The **Schedules** page is where you create and manage automated start/stop windows for EKS workloads and standalone EC2 instances. Open it from the sidebar: **Schedules**.

### What you see

- A table of all schedules with cluster, namespace, target, shutdown/startup times, timezone, repeat pattern, status, and next run.
- Color cues in the table:
  - **Amber** — EKS schedule
  - **Sky blue** — Non-EKS (EC2) schedule
  - **Red highlight** — schedule is currently in its stopped window (also appears on **Live Schedules**)

---

### Step 1 — View your schedules

1. Click **Schedules** in the sidebar.
2. Scroll horizontally if needed to see all columns.
3. Use the **Search schedules…** box to filter by name, cluster, namespace, or other details.

---

### Step 2 — Create a new schedule

> Requires **Schedule — Edit** permission.

1. Click **Add Schedule** (top right).
2. Fill in the form in the drawer that opens.

**Common fields (all schedule types)**

| Field | What to enter |
|-------|----------------|
| **Name** | A clear label, e.g. `Dev nightly shutdown` |
| **Schedule type** | **Daily** (repeats weekly on selected days) or **One-time** (runs once, then disables itself) |
| **Timezone** | The timezone used for shutdown and startup times |
| **Shutdown / Startup** | Daily: time of day. One-time: exact date and time for each |
| **Days of week** | (Daily only) Which weekdays the schedule runs |
| **Enabled** | Turn the schedule on or off without deleting it |

---

#### Option A — EKS schedule

1. Under **Platform**, choose **EKS**.
2. Select **Cluster** (must be registered under **Clusters** first).
3. Select **Namespace**.
4. Choose **Schedule scope**:
   - **Single workload** — pick one Deployment or StatefulSet.
   - **Entire namespace** — all scalable workloads in the namespace; optionally uncheck workloads to exclude.
5. Set shutdown and startup times (and days, for daily schedules).
6. Optionally choose an **ArgoCD instance** and sync policy if your cluster uses ArgoCD.
7. Click **Save**.

**Overnight windows:** If shutdown is in the evening and startup is the next morning (e.g. 8:30 PM → 8:30 AM), SecureNexus treats that as an overnight schedule and shows a reminder in the form.

---

#### Option B — Non-EKS (EC2) schedule

1. Under **Platform**, choose **Non EKS**.
2. Select the **AWS account** (configured by your admin under **Admin → Settings → AWS Integration**).
3. Choose **Instance scope**:
   - **Single instance** — one EC2 instance, one schedule.
   - **Multiple instances** — check several instances; SecureNexus creates **one schedule per instance** with the same timing.
4. Pick the instance(s). EKS-managed nodes are excluded from the list automatically.
5. Set shutdown and startup times.
6. Click **Save**.

---

### Step 3 — Run a schedule immediately

> Requires **Schedule — Stop** and/or **Schedule — Start** permission.

1. Find the schedule in the table.
2. In the **Actions** column on the right:
   - Click the **stop** icon to run **shutdown now**.
   - Click the **play** icon to run **startup now**.
3. Confirm in the dialog.
4. The action is logged under **Activity Logs** and reflected on the **Dashboard** after the next refresh.

---

### Step 4 — Edit or delete a schedule

> Requires **Schedule — Edit** permission.

**Edit**

1. Click the **pencil** icon on the schedule row.
2. Update fields in the drawer.
3. Click **Save**.

**Delete**

1. Click the **trash** icon on the schedule row.
2. Confirm deletion. This cannot be undone.

---

### Step 5 — Understand schedule status

| Status | Meaning |
|--------|---------|
| **Enabled** | Schedule will run at its next scheduled time |
| **Disabled** | Schedule is paused; no automatic runs until re-enabled |
| **One-time completed** | One-time schedule finished its startup and will not run again |
| **Next run** | When the next shutdown or startup is expected |

---

## Live Schedules

**Live Schedules** shows workloads that are **currently stopped** and waiting for their next scheduled startup. Open it from the sidebar: **Live Schedules**. A red badge on the sidebar shows how many schedules are live right now.

### When a schedule appears here

1. A schedule runs its **shutdown** action (automatically or manually).
2. The workload stays stopped until the **startup** time.
3. While in that window, the schedule appears on **Live Schedules**.
4. When startup runs (automatically or manually from **Schedules**), the entry disappears from this page.

---

### Step 1 — Check what is stopped now

1. Click **Live Schedules** in the sidebar.
2. Read the **In stopped window** count at the top.
3. Review the table:
   - **Name**, **Cluster**, **Namespace**, **Target**
   - **Stopped window** — shutdown time → startup time
   - **Time remaining** — countdown until startup
   - **Startup at** — exact next startup time

If nothing is stopped, you will see **No live schedules** with a link to go to **Schedules**.

---

### Step 2 — Stop a live schedule early

> Requires **Live Schedule — Stop** permission.

Use this when you want to **end the stopped window immediately** and shut down the schedule’s tracking on this page. To **start workloads back up**, go to **Schedules** and run startup from there.

1. Find the schedule in the **Live Schedules** table.
2. Click **Stop** in the Actions column.
3. Confirm **Stop live schedule?**
4. The schedule is removed from Live Schedules. Use **Schedules** to start the workload again when needed.

---

### Step 3 — Start a stopped workload

Startup is **not** done from Live Schedules.

1. Go to **Schedules**.
2. Find the same schedule.
3. Click the **play** (startup) icon in Actions.
4. Confirm **Run now**.

---

### Step 4 — Jump between Schedules and Live Schedules

- From **Live Schedules**, click **All Schedules** (top right) to open the full schedule list.
- From **Schedules**, click **Live Schedules** in the sidebar to see only workloads currently in a stopped window.

---

## Contact

The **Contact** page lists your DevOps team so you can reach the right people for platform support and infrastructure requests. Open it from the sidebar: **Contact**.

---

### Step 1 — Open the Contact page

1. Click **Contact** in the sidebar.
2. Read the page description: *Reach the DevOps team for platform support and infrastructure requests.*

---

### Step 2 — Find a team member

1. At the top, note the **Team** name (for example, *DevOps Team*).
2. Browse the contact cards below. Each card shows:
   - **Name** and **Designation**
   - **Email Id** — click to open your email client
   - **Contact No** — click to call (on supported devices)

---

### Step 3 — If no contacts are listed

If the page shows **No contacts configured yet**, your admin needs to add team members:

1. Go to **Admin Panel → Settings → DevOps Contacts** (admin only).
2. Add names, emails, and phone numbers there.
3. Return to **Contact** — cards will appear after they are saved.

---

## Quick reference

| I want to… | Go to… | Action |
|------------|--------|--------|
| See cost savings and stop time | **Dashboard** | Set **Period**, review charts and tables |
| Create a shutdown schedule | **Schedules** | **Add Schedule** → fill form → **Save** |
| Stop a workload right now | **Schedules** | Stop icon on the row → confirm |
| Start a workload right now | **Schedules** | Play icon on the row → confirm |
| See what is stopped now | **Live Schedules** | Review the live table |
| End a stopped window early | **Live Schedules** | **Stop** → confirm (startup from **Schedules**) |
| Reach the DevOps team | **Contact** | Click email or phone on a card |
| Reload page data | Any page | **Refresh** in the page header |

---

## Related pages (not covered in detail here)

These are available in the sidebar depending on your permissions:

- **Infrastructure** — infrastructure-level shutdown and startup
- **Clusters** — register EKS clusters used by schedules
- **Activity Logs** — full history of shutdown and startup actions
- **Resource changes** — audit of resource changes in Git
- **Alerts** — notification rules and delivery
- **Admin Panel** — users, AWS integration, contacts, and system settings (admins only)

For installation and technical setup, see the main [README](../README.md).
