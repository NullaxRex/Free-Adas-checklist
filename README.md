# CollisionIQ v3

© Collision IQ LLC · Owned by CuelJuris · All rights reserved. Proprietary software (see LICENSE).

Free ADAS calibration requirement lookup (`/check`) plus shop accounts for documenting scans, calibrations and photos, with shareable read-only reports.

- Node 22+, Express, built-in `node:sqlite`. No native dependencies, no Stripe (free tier).
- `/check` is public. `/register` creates a shop account. `/admin` (leads, usage by `?src=`) is only for the email set in `ADMIN_EMAIL`.

## Deploy (new GitHub repo + new Railway service)

1. GitHub → New repository (private) → "uploading an existing file" → drag in everything from this folder (not `node_modules`) → Commit.
2. Railway → New Project → Deploy from GitHub repo → pick the new repo.
3. Service → Variables, add:
   - `NODE_ENV` = `production`
   - `SESSION_SECRET` = a long random string (e.g. 40+ characters)
   - `ADMIN_EMAIL` = the email you will register with
   - `DB_PATH` = `/data/collisioniq.db`
   - `UPLOAD_DIR` = `/data/uploads`
4. Service → Volumes → Add Volume → mount path `/data`. Without this, the database and photos are erased on every redeploy.
5. Settings → Networking → Generate Domain. Open `/healthz` (should say `ok`), then `/check`.
6. Register your own account with the `ADMIN_EMAIL` address and confirm `/admin` loads.

## Local

    npm install
    npm start        # http://localhost:3000
    npm test         # end-to-end smoke test (63 checks)

## Notes

- Outreach links: add `?src=email1` (any label) to `/check` links. `/admin` shows lookups per label.
- Requirement text comes from `adasEngine.js`. Do not paste OEM subscription content (ALLDATA, Toyota TIS, Subaru STIS, etc.) into it.
- `/terms` is a draft. Have counsel review it.
- Branding constants (`BRAND`, `LEGAL`, `OWNER`) are at the top of `server.js`. Change them in one place if the registered entity name differs.
- Theme: black `#0B0B0C` and yellow `#FFC61A`, defined as CSS variables at the top of the `CSS` block.
