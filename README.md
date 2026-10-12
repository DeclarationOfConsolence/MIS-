# NapChief MIS Performance Dashboard

An organization MIS tracking dashboard powered by **Asana**. One Next.js app — the
frontend and the backend (Asana API calls) run together with a single `npm run dev`.
Login-protected (5 accounts), filterable, with charts. Deploys to Vercel.

---

## 1. First-time setup

```bash
cd "MSI Report"
npm install
```

## 2. Add your Asana token

Open **`.env.local`** and paste your token:

```
ASANA_TOKEN=1/1234567890:your_real_token_here
```

> Get a token from Asana → Profile photo → **Settings** → **Apps** →
> **Developer apps** → **Personal access tokens** → **Create new token**.

The token stays server-side only — it is never sent to the browser, and
`.env.local` is gitignored so it never reaches GitHub.

## 3. Run it

```bash
npm run dev
```

Open http://localhost:3000 → you'll hit the **login** page.

## Logins (5 accounts)

| Username | Password |
|----------|----------|
| user1    | nap123   |
| user2    | nap123   |
| user3    | nap123   |
| user4    | nap123   |
| user5    | nap123   |

Change these anytime in `.env.local` → `MIS_ACCOUNTS=user1:nap123,...`

---

## Features

- **Login gate** — 5 accounts, session cookie, 12h expiry.
- **Live Asana pull** — full workspace: all projects, sections, tasks, assignees, due dates.
- **Filters** — search, assignee, board/project, section, status (Open/Completed/Overdue), date view.
- **Overview tab** — KPI cards + per-person completion table.
- **Team tab** — workload bar chart + completion table.
- **Tasks tab** — full filterable task list.
- **Charts tab** — status donut, tasks by project, workload by assignee.
- **Light / Dark** theme toggle (black & white professional look).
- **Export CSV** of the current filtered view.

---

## Deploy to Vercel

1. Push this folder to a GitHub repo (the `.gitignore` keeps `.env.local` out).
2. On [vercel.com](https://vercel.com) → **New Project** → import the repo.
3. In **Settings → Environment Variables**, add the same keys from `.env.local`:
   - `ASANA_TOKEN`
   - `SESSION_SECRET`
   - `MIS_ACCOUNTS`
   - (optional) `ASANA_WORKSPACE_GID`
4. Deploy. Your CEO just opens the Vercel URL and logs in.

---

## Project structure

```
MSI Report/
├─ .env.local            # SECRETS: Asana token + accounts (gitignored)
├─ middleware.js         # blocks pages until logged in
├─ lib/
│  ├─ asana.js           # Asana API client + workspace fetch
│  └─ auth.js            # login accounts + session signing
├─ app/
│  ├─ layout.jsx
│  ├─ globals.css
│  ├─ login/page.jsx     # login screen
│  ├─ page.jsx           # the dashboard
│  └─ api/
│     ├─ login/route.js
│     ├─ logout/route.js
│     └─ asana/route.js  # server route that talks to Asana
└─ components/Charts.jsx # Recharts graphs
```
