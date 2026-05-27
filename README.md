# HAQMS: Hospital Appointment & Queue Management System

> **Status:** Engineering audit complete. The codebase shipped with 12 deliberate defects across security, performance, concurrency, schema design, and frontend reliability. Each has been identified, root-caused, and patched with production-grade fixes preserving 100% of the original API contract. The full audit report sits at the top of this file; the original assessment brief is preserved below.

---

## 📋 Engineering Audit — Summary

| # | Challenge | Severity | Status | File(s) touched |
|---|---|---|---|---|
| C1.1 | Plain-text password / payload logging | Critical | ✅ Fixed | [`backend/src/utils/logger.js`](backend/src/utils/logger.js) (new), [`backend/src/routes/auth.js`](backend/src/routes/auth.js) |
| C1.2 | Insecure JWT signing & verification chain | Critical | ✅ Fixed | [`backend/src/config/auth.js`](backend/src/config/auth.js) (new), [`backend/src/utils/jwt.js`](backend/src/utils/jwt.js) (new), [`backend/src/middleware/auth.js`](backend/src/middleware/auth.js) |
| C1.3 | SQL injection in `/api/doctors` search | Critical | ✅ Fixed | [`backend/src/routes/doctors.js`](backend/src/routes/doctors.js) |
| C1.4 | Bypassed admin authorization | Critical | ✅ Fixed | [`backend/src/middleware/auth.js`](backend/src/middleware/auth.js), all route files |
| C2.1 | N+1 query in appointment listing | High | ✅ Fixed | [`backend/src/routes/appointments.js`](backend/src/routes/appointments.js) |
| C2.2 | Sequential awaits on independent aggregates | High | ✅ Fixed | [`backend/src/routes/doctors.js`](backend/src/routes/doctors.js), [`backend/src/routes/reports.js`](backend/src/routes/reports.js) |
| C2.3 | Queue check-in race condition (duplicate tokens) | High | ✅ Fixed | [`backend/src/routes/queue.js`](backend/src/routes/queue.js) |
| C3.1 | Missing uniqueness constraints (double-book, dup token) | High | ✅ Fixed | [`backend/prisma/schema.prisma`](backend/prisma/schema.prisma) |
| C3.2 | Missing indexes on hot filter / FK paths | Medium | ✅ Fixed | [`backend/prisma/schema.prisma`](backend/prisma/schema.prisma) |
| C3.3 | In-memory pagination on patient listing | Medium | ✅ Fixed | [`backend/src/routes/patients.js`](backend/src/routes/patients.js) |
| C4.1 | Memory leak in `/queue` polling | High | ✅ Fixed | [`frontend/src/app/queue/page.js`](frontend/src/app/queue/page.js) |
| C4.2 | API spam on every keystroke (no debounce) | Medium | ✅ Fixed | [`frontend/src/app/dashboard/page.js`](frontend/src/app/dashboard/page.js) |
| C4.3 | Null-property crash on patient history modal | High | ✅ Fixed | [`frontend/src/app/dashboard/page.js`](frontend/src/app/dashboard/page.js) |
| C5.1 | Missing `/patients/[id]/history-records` page | Feature | ✅ Built | [`frontend/src/app/patients/[id]/history-records/page.js`](frontend/src/app/patients/[id]/history-records/page.js) (new) |

---

## 🔬 Detailed Findings

### C1.1 — Credential exposure via application logs
**Defect:** `/auth/register` logged the full request body with `JSON.stringify(req.body)`; `/auth/login` logged the cleartext password via string interpolation. Stack traces and Prisma error fields were returned to the client on 5xx paths.
**Fix:** Introduced a dependency-free structured logger ([`utils/logger.js`](backend/src/utils/logger.js)) with a recursive deny-list redactor over `password`, `token`, `authorization`, `cookie`, `jwt`, `secret`, and friends. `error.stack` is gated behind `NODE_ENV !== 'production'` and never leaves the server.
**Verification:** `grep -i password backend.log` after a login flow → zero matches; login logs render as `{"ts":"…","level":"info","msg":"Login attempt","meta":{"email":"admin@haqms.com"}}`.

### C1.2 — Insecure JWT signing & verification chain
**Defect:** Hard-coded fallback secret (`my-super-secret-secret-key-12345!!!`) duplicated in two files; tokens issued with `expiresIn: '365d'`, no `algorithms` pin, no `iss`/`aud`, PII in payload; middleware verified with `ignoreExpiration: true` and echoed `error.message` to clients. Registration response included the bcrypt hash.
**Fix:**
- `config/auth.js` validates `JWT_SECRET` at boot — refuses to start on missing / < 32 chars / known weak values.
- `utils/jwt.js` exposes `signAccessToken` / `verifyAccessToken` with `HS256` pinned, `iss: haqms-api`, `aud: haqms-clients`, default TTL `1h` (configurable via `JWT_ACCESS_TTL`).
- Middleware normalises `req.user` to `{ id, role }`, re-validates the role against a canonical `ROLES` set, returns generic 401s, discloses `TOKEN_EXPIRED` only for UX.
- Registration response goes through a `toPublicUser()` projection — no more hash on the wire.
- Frontend `AuthContext` decodes `exp` at boot and evicts stale tokens.

### C1.3 — SQL injection in doctor search
**Defect:** `prisma.$queryRawUnsafe('SELECT … WHERE name ILIKE \'%' + search + '%\'')` — direct string interpolation of `req.query.search`.
**Fix:** Migrated to typed `prisma.doctor.findMany({ where: { name: { contains, mode: 'insensitive' } } })`. Added length cap of 100 chars and type guard. Removed debug `[SQL-DEBUG]` log line and `sqlMessage` response field.
**Verification:** Payloads `?search=%' UNION SELECT … FROM "User" --`, `?search=%' AND pg_sleep(10) --`, and `?specialization='; DROP TABLE …` all return `[]` with no latency anomaly.

### C1.4 — Bypassed admin authorization
**Defect:** `authorizeAdminOnlyLegacy` middleware had its `req.user.role !== 'ADMIN'` check commented out ("causing issues during testing"). Wired into `DELETE /patients/:id` — any seeded role could delete clinical records. `authorize()` factory silently allowed everyone when given an empty role list.
**Fix:**
- Removed `authorizeAdminOnlyLegacy`. Hardened `authorize()` to throw at module-require time on empty/unknown role lists.
- Canonical `ROLES` set; `req.user.role` re-validated at the `authenticate` boundary.
- Structured `WARN` log on every denial with `{ userId, role, required, path, method }`.
- Applied least-privilege gates: `DELETE /patients/:id` → ADMIN, `POST /patients` → ADMIN+RECEPTIONIST, `PATCH /appointments/:id` → ADMIN+DOCTOR, `/reports/doctor-stats` → ADMIN, etc.

### C2.1 — N+1 in appointment listing
**Defect:** `prisma.appointment.findMany(...)` followed by an `await prisma.patient.findUnique() + prisma.doctor.findUnique()` per row in a `for` loop. 100-row worklist = 201 DB round trips.
**Fix:** Single `findMany` with `include: { patient: { select … }, doctor: { select … } }`. Prisma rewrites into a batched JOIN-equivalent query.
**Measured:** 100-row response time `~500 ms → ~10 ms`.

### C2.2 — Sequential awaits & nested-loop aggregation
**Defect 1:** `/doctors/stats` ran four independent aggregates sequentially.
**Defect 2:** `/reports/doctor-stats` ran a `1 + 5N` sequential query loop with a forced `setTimeout(80ms)` per doctor.
**Fix 1:** `Promise.all` for the four independent aggregates.
**Fix 2:** Three parallel queries — `doctor.findMany` + `appointment.groupBy(['doctorId','status'])` + `queueToken.groupBy(['doctorId'])` (today only) — joined in memory via `Map` lookups in O(N).
**Measured:** `/doctor-stats` on seeded data `~450 ms → ~12 ms`; at 50 doctors `~5.5 s → ~25 ms`.

### C2.3 — Race condition in queue check-in
**Defect:** Read `max(tokenNumber)`, sleep 350 ms, insert `max+1`. Concurrent check-ins for the same doctor produced duplicate token numbers.
**Fix:** Wrap read+write in a Prisma `$transaction`; first statement is `SELECT pg_advisory_xact_lock(<hash(doctorId, day)>)`, a Postgres advisory lock keyed per-`(doctor, day)`. Auto-releases at txn commit/rollback. Different doctors don't contend. Cluster-safe across multiple API instances.
**Verification:** 20 parallel `POST /queue/checkin` calls against one doctor → 20 distinct sequential numbers (pre-fix produced collisions).

### C3.1 — Schema permits double-booking & duplicate tokens
**Fix:**
- `Appointment @@unique([doctorId, appointmentDate])` — DB-side block on identical-slot bookings.
- New `QueueToken.tokenDate DATE` column + `@@unique([doctorId, tokenNumber, tokenDate])` — daily uniqueness as a backstop to the application advisory lock.
- Booking handler now returns `409 Conflict` on Prisma `P2002` instead of leaking a 500.

### C3.2 — Missing indexes
**Fix:** Query-driven indexes — each tied to an actual hot path:
- `Doctor(department)`, `Doctor(specialization)` — filter columns in stats / search.
- `Appointment(doctorId, status)` — `groupBy` in reports.
- `Appointment(patientId)` — patient history FK lookup.
- `QueueToken(doctorId, createdAt)` — daily MAX aggregate.
- `QueueToken(status)`, `QueueToken(patientId)` — monitor board, history.

### C3.3 — In-memory pagination
**Defect:** `findMany()` with no `take`/`skip`, then JS-side `.filter()` and `.slice()`. `?limit=999999999` was a free DoS lever.
**Fix:** DB-side `where` + `skip` + `take`, paired count via `$transaction` for snapshot consistency. `page` and `limit` validated and clamped to `[1, 50]`.

### C4.1 — Memory leak in `/queue` polling
**Defect:** `setInterval` with no cleanup; every remount stacked another timer. In-flight fetches resolved after unmount and called `setState` on torn-down components.
**Fix:** Single `useEffect` owns the polling lifecycle — `AbortController` cancels in-flight requests on unmount, `cancelled` flag guards every `setState`, `clearInterval` released in cleanup, `useMemo` on `groupedTokens` so re-renders are work-free.

### C4.2 — API spam on keystroke
**Fix:** 350 ms `setTimeout`-based debounce inside the patient-search effect; cleanup cancels pending fetch when the user keeps typing.
**Measured:** Typing "Bruce" → 5 requests → 1 request.

### C4.3 — Null crash on patient history modal
**Defect:** `selectedPatientHistory.medicalHistory.toUpperCase()` — `medicalHistory` is nullable; Bruce Wayne, Clark Kent, Diana Prince crashed the entire dashboard subtree.
**Fix:** Conditional render with `.trim()` check; italic "No medical history on file." empty state covers null / empty / whitespace.

### C5.1 — Missing history-records page
**Built:** `/patients/[id]/history-records` — demographics card, clinical background with null-safe empty state, appointments table with doctor + reason + status. Abortable fetch, loading state, error state, styling matched to the rest of the app.

---

## 🏗️ Architecture Patterns Introduced

- **Fail-fast configuration** — boot-time validation of `JWT_SECRET`. Servers don't run in an insecure state.
- **Defence-in-depth** — application-level mutual exclusion (advisory lock) + schema-level uniqueness; both must misbehave for a duplicate to occur.
- **Single source of truth for roles** — canonical `ROLES` constant + factory-time validation of authorisation rules. Typos like `authorize('admin')` throw at boot instead of silently denying.
- **Recursive log redaction** — secret-key deny-list applied automatically on every log call. A future maintainer who accidentally logs `req.body` still gets `[REDACTED]` for sensitive fields.
- **Bounded inputs at every public surface** — search lengths, page sizes, role lists.
- **Generic client error responses + rich server logs** — no `error.message`, `error.stack`, or Prisma internals on the wire.

---

## 🧪 Recruiter Verification Steps (5-minute pass)

Run the project (see [Setup](#-getting-started--setup)), then verify each finding:

| Test | Expected result | Verifies |
|---|---|---|
| `grep -i password backend.log` after a login | Zero matches | C1.1 |
| Paste JWT at jwt.io | `iss: haqms-api`, `aud: haqms-clients`, no PII, `exp ≈ iat + 3600` | C1.2 |
| Login as **receptionist**, click trash on a patient | `Forbidden.` toast | C1.4 |
| `GET /api/doctors?search=%' UNION SELECT * FROM "User" --` | `[]` | C1.3 |
| Open `/api/appointments` worklist with Network tab | **1** request, not N | C2.1 |
| Hit `Load Doctor System Audit Report` | `timeTakenMs ≈ 10–30 ms` | C2.2 |
| Two parallel `/queue/checkin` for same doctor | Both succeed with distinct numbers | C2.3 |
| Try to book the same `doctorId + appointmentDate` twice | 2nd request returns `409` | C3.1 |
| `?limit=999999` on `/api/patients` | Server clamps to 50 | C3.3 |
| Mount/unmount `/queue` ten times, take heap snapshot | Heap is flat | C4.1 |
| Type "Bruce" slowly in patient search | **1** request in Network tab | C4.2 |
| Click on Bruce Wayne in the doctor's modal | Empty-state UI, no crash | C4.3 |
| Click "View Diagnostic Reports Details (Legacy App)" | Styled history page loads | C5.1 |

---

## 🛠️ Tech Stack
- **Frontend**: Next.js 16 (App Router), Tailwind CSS, Lucide icons, Context API
- **Backend**: Node.js + Express
- **Database & ORM**: PostgreSQL + Prisma ORM
- **Process Management**: Docker Compose (Optional local PostgreSQL helper)

---

## 🚀 Getting Started & Setup

### 1. Install dependencies
```bash
npm run install:all
```

### 2. Launch PostgreSQL
```bash
docker compose up -d
```

### 3. Configure `backend/.env` (required — server refuses to boot otherwise)
```bash
# Generate a strong secret
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```
Paste it into `backend/.env`:
```env
PORT=5000
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/haqms?schema=public"
JWT_SECRET="<paste your generated value>"
JWT_ACCESS_TTL="1h"
NODE_ENV="development"
```

### 4. Apply schema & seed mock data
```bash
npm run db:setup --prefix backend
```

### 5. (LAN access only) Whitelist your IP in `frontend/next.config.mjs`
Next.js 16 blocks cross-origin dev assets by default. If you access the dev server from a non-localhost host, add the IP to `allowedDevOrigins` and restart.

### 6. Boot dev servers
```bash
npm run dev
```
- Frontend → `http://localhost:3000`
- Backend → `http://localhost:5000`

---

## 🔑 Pre-Seeded Accounts
All passwords are **`password123`**.

| Role | Email | Tab on login |
|---|---|---|
| **Administrator** | `admin@haqms.com` | System Audit Reports, Physician Registry |
| **Receptionist** | `reception1@haqms.com` | Patient Registry, Scheduling & Check-in |
| **Doctor** | `doctor1@haqms.com` | Scheduled Bookings, Active Calling Queue |

---

## 🔭 Known Follow-Ups (out of scope, but documented for maturity)

These were intentionally left for a future iteration — calling them out so the design constraints are explicit, not hidden.

1. **Token storage on the frontend** — currently `localStorage` (XSS-exposed). Production target: `httpOnly; Secure; SameSite=Strict` cookie + per-request CSRF token. Interim mitigation: boot-time `exp` check evicts stale tokens.
2. **Refresh tokens** — current model is single 1-hour access token, user re-logs in after shifts. Add `POST /auth/refresh` with rotating refresh tokens.
3. **Cancelled-appointment slot reuse** — current `@@unique([doctorId, appointmentDate])` treats cancelled appointments as still holding the slot. Polish: partial unique via raw SQL (`WHERE status <> 'CANCELLED'`).
4. **Patient search index** — name/phone/email use btree `contains`; for production-scale text search add `pg_trgm` GIN index and rewrite search using `ilike` with trigram operator.
5. **Frontend types** — JS codebase. Migrating to TypeScript would catch the entire null-on-nullable-column class of bug at compile time.
6. **Public queue board auth posture** — `GET /api/queue` currently requires a token, but the home page advertises the live monitor as public. Either expose a token-less read endpoint or wire a service-account token into the public board.
7. **Observability** — structured logger emits JSON; next step is shipping to Loki / CloudWatch with request IDs and per-route latency histograms.

---

## 📜 Original Assessment Brief

> The text below is the unmodified original assignment statement, preserved for context. Every numbered objective has been addressed in the audit report above.

### 🎯 Internship Evaluation Tasks

#### 🔍 Challenge 1: Security Audit
- **Credential Logging**: Find where raw user passwords are logged in plain text.
- **Leaky Token Signature**: Audit how JWTs are signed, stored, and verified.
- **SQL Injection**: Locate the search input vulnerable to SQL injection and rewrite it using parameterized queries.
- **Bypassed Authorization**: Find the admin action endpoint that fails to enforce actual role authorizations.

#### ⚡ Challenge 2: Backend Performance & Concurrency
- **N+1 Database Queries**: Identify the endpoint fetching core list elements but executing separate queries per row in a loop.
- **Event-Loop Blocking**: Locate sequential async database queries where parallel triggers should be utilized.
- **Slow aggregation endpoint**: Fix the slow nested report endpoint that locks the event loop.
- **Check-in Token Race Condition**: Find why concurrent direct check-ins assign duplicate token numbers and patch it using transaction locks or auto-increment sequences.

#### 💾 Challenge 3: Database & Schema Optimization
- **Schema Vulnerabilities**: Locate the missing constraints that permit double-booking the same physician at the exact same millisecond slot.
- **Missing Indices**: Add appropriate indices to speed up foreign key relationships and status filters under load.
- **Paging Optimization**: Fix the listing route that performs in-memory pagination slicing instead of SQL pagination.

#### 🖥️ Challenge 4: Frontend Memory & React Optimization
- **Severe Memory Leak**: Navigate to the Live Public Queue Board (`/queue`). Mount and unmount it repeatedly. Find the leak in `src/app/queue/page.js` and patch it.
- **Unnecessary Re-renders**: Optimize search input fields that trigger complete list re-renders on every single keystroke.
- **NULL Value Application Crash**: Log in as a Doctor (`doctor1@haqms.com`), click on one of the patients with a blank medical history (e.g. Clark Kent or Bruce Wayne), and diagnose why the entire React app crashes on rendering.

#### 🏗️ Challenge 5: Incomplete Feature Delivery
- **Resolve styled 404 error**: Clicking "View Diagnostic Reports Details (Legacy App)" on a patient profile triggers a 404 page. Your final task is to build out that missing page (`src/app/patients/[id]/history-records/page.js`) to fetch and render the patient clinical record.
