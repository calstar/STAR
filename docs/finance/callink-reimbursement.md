# Scripting CalLink reimbursements

Reverse-engineered from CalLink's own form script by a browser agent (2026-10-01).
Nothing was uploaded or submitted while working it out. Items marked **unconfirmed**
were inferred from the page script and still need a real test.

## Constraint

CalLink sits behind Berkeley SSO, so a server (or Apps Script) cannot call it. The
work has to run in the user's logged-in browser: a bookmarklet, console snippet or
small extension.

## 1. Get the form

`GET https://callink.berkeley.edu/actionCenter/organization/star/Finance/CreatePurchaseRequest`

Read from the HTML:

- the hidden `__RequestVerificationToken`
- every hidden field, as the page defaults
- the exact `pageResponse.Responses[...]` field names. These IDs belong to this form,
  so read them each time instead of hardcoding them.

## 2. Upload each receipt (once per item)

This is the sequence the page's Upload File button runs:

1. `GET` the `uploadDialogUrl` hidden value,
   `/actioncenter/organization/star/Finance/FileUploadQuestion/GetFileUploadDialog`.
   It returns a small form that posts to `.../FileUploadQuestion/uploadfile`.
2. `POST` `multipart/form-data` to `uploadfile` with the file in the `PostedFile` field
   and the `__RequestVerificationToken`. The limit is 4 MB. PDF, JPG, PNG and several
   other types are allowed.
3. The response is a small HTML snippet. Read `.validResponse` (a unique temp file
   name) and `.fileName` (the original name). **Unconfirmed:** this markup is inferred
   from the page script.
4. Write `.fileName` into `pageResponse.Files[fuXXXX].TemporaryFileName` and
   `.validResponse` into `pageResponse.Files[fuXXXX].TemporaryUniqueFileName`. These
   hidden fields sit inside the item's upload block, next to `AnswerId` and
   `ExistingDocumentId`.
5. `POST .../FileUploadQuestion/RemoveTempFile` removes an unused temp file.

## 3. Submit

`POST` the whole form, URL-encoded, to the same `CreatePurchaseRequest` URL, including
the temp-file fields from step 2. The request then sits at Stage 1 and still has to be
moved to Stage 2 on the request page. **Unconfirmed:** the Stage 2 step has not been
traced.

## 4. Account: always MISC-STAR

- `AccountId` is a hidden field filled by the Account "SELECT..." dialog.
- The listed accounts are `3-70-203828-00000-MISC-STAR`,
  `3-71-203828-00000-TEMP REST STAR` and a SUMMARY account.
- Always use MISC-STAR, ID `94919`. This matches earlier requests. A script can set
  `AccountId=94919` directly.
- The form says never to select SUMMARY.

## Open items

- Upload one tiny test PDF to confirm the `uploadfile` response markup and see how temp
  files behave.
- Trace the Stage 1 → Stage 2 button.
- Source sheet: stray blank rows 6–30 and a partial row-6 entry.
- A CalLink form tab is still open with test values. Don't submit it.

## Server-side session (tested 2026-10-01)

`callink-worker/session.mjs login` signs in headless through CalNet (plain username and
password form at `auth.berkeley.edu/cas/login`), waits for the Duo push, and keeps a
Playwright profile on disk. CalLink's login cookies (`App.Login*`, `access_token`) are
persistent and expire a fixed 24 h after sign-in, so the profile survives restarts and
one Duo approval a day keeps the worker signed in. `session.mjs check` records whether
the stored session still reaches the form.

The /finance banner's **Sign in to CalLink** button (admins) runs the same sign-in from
the worker: STARProject marks a request (`WorkerStatus.loginState = requested`), the
worker polls `GET /api/worker/login` every 10 s, takes it once, and runs
`session.mjs login --fresh`, reporting `waiting_duo` then `ok`/`failed`. `--fresh` sets
CalLink's own cookies aside so a still-live session is renewed too, and puts them back if
the new sign-in fails. Requests not taken within 2 minutes lapse.

## Reading requests (no HTML scraping of the app)

All read-only, with the session's cookies:

| what | endpoint |
|---|---|
| list (paged) | `GET /api/finance/STAR/requests/purchase/list-items?take=&skip=&status=All&...` → `{totalItems, items[]}` |
| one request | `GET /api/finance/STAR/requests/purchase/{id}/` → account, category, stage, payee address, stage and request history |
| stages | `GET /api/finance/stages/STAR` (Stage 1 = 517, Stage 2 = 518) |
| form answers | `GET /actionCenter/organization/STAR/finance/print/{id}`: server-rendered `<strong>question</strong><p>answer</p>` pairs, the "additional questions" already expanded |
| receipt file | `GET /actionCenter/organization/STAR/Finance/FileUploadQuestion/getdocument?DocumentId=&RespondentId=` |

`{id}` is the URL id (e.g. 1890297), not the request number shown on the page (1868311).

`callink-worker/scrape.mjs` uses these. Quirks of the form it handles: items 2–6 label
their upload "Upload Item #N file here", item 3's date question is spelt "Iterm #3",
totals are typed with or without `$` and `,`. CalLink sometimes stalls a request for
30 s; a retry answers at once. The list's `submittedOn` is Eastern time labelled `+00:00`
(a request filed at 12:00Z lists as `07:59:59+00:00`); the detail API's dates carry the
right offset.

What the data is like (735 requests, 2018-01 to 2026-09):

- Requests before mid-2020 (155) predate the itemised form: only the amount,
  description and payee exist, no items or receipts.
- Of the 580 itemised, 79 have item totals that do not sum to the submitted amount.
  These are members' own entries (cents off, a dropped digit, an order number typed
  as the total); the scrape reports them as found.
- Item totals that are not money (`N/A`, "bank statement" proof-of-payment slots, one
  in GBP) are left blank in the `amount` column.

## Submitting (tested 2026-10-02)

`callink-worker/submit.mjs request.json [--submit]` drives the real form rather than
re-encoding its POST, so CalLink's own script writes the hidden fields. It fills each
question by its label, uploads through the page's Upload button, and checks the form's
FormData before submitting (account, amount, subject, one temp file per item). Without
`--submit` it stops there and prints every value it would send.

- The account is not an input. The picker rows are `<a class="account-picker"
  id="{accountId}">`; the script clicks `id="94919"` only if that row's name cell is
  exactly `3-70-203828-00000-MISC-STAR` (its parent column says SUMMARY, so a text match
  on the row is wrong).
- The upload sequence in the notes above is confirmed: the receipt goes up as a temp
  file (`<uuid>.pdf`) whose name lands in `TemporaryUniqueFileName`, and the stored
  document is byte-identical to the upload.
- After submit CalLink redirects to `/finance/STAR/requests/purchase`; the request
  appears at Stage 1, status Unapproved. First test: id 1892410, request 1868534.
- Moving to Stage 2 (which sends it to ASUC) is not automated yet.
- First direct (HTTP-only) submission: id 1892411, request 1868535, read back identical,
  receipt byte-identical.

## Submitting without the page (`direct.mjs`)

`callink-worker/direct.mjs request.json [--compare FILE | --submit]` sends the same
request with plain HTTP and the stored session's cookies:

1. `GET CreatePurchaseRequest`. Parse `#finance_form`, set our answers in its DOM, and
   serialise it the way a browser does (jQuery `serializeArray`: no unchecked radios,
   selects send their selected option, unanswered questions still send their ids).
2. Per receipt: `GET` the block's `uploadDialogUrl`, then `POST` multipart to the
   dialog form's action (`.../FileUploadQuestion/uploadfile`) with `PostedFile` **and**
   the form's `__RequestVerificationToken`. Without the token CalLink 302s to
   `error.aspx`. The reply is `<div class="validResponse">{uuid}.ext</div><div
   class="fileName">{original}</div>`; those go into `TemporaryUniqueFileName` and
   `TemporaryFileName`.
3. `POST` the pairs URL-encoded to the form's action. Success is a 302 to the request
   list; a 200 is the form returned with its validation errors.

`submit.mjs --capture FILE` presses Submit in the real page, cancels the POST before it
leaves and saves its body; `direct.mjs --compare FILE` diffs against it. On 2026-10-02 the
two agreed on all 220 fields (token and temp file name aside, which are fresh per load).

## What STAR fixes, and what the member fills in (decided 2026-10-02)

The CalLink form is long; STAR's own form asks only what varies. `request.mjs` fills the
rest and rejects a request file that tries to set a fixed answer.

| CalLink field | STAR form |
|---|---|
| Account | fixed: `3-70-203828-00000-MISC-STAR` (94919) |
| Category | fixed: Reimbursement (1352) |
| Requested amount | not a field: always the sum of the item totals |
| Q1 UC Berkeley student/staff | fixed YES; member gives their UID (7-8 digits, never a 303… student ID) |
| Q2 payee email | prefilled from the member's STARProject account email, editable |
| Q4 expenditure action | defaults to Direct Deposit, with a short note on ASUC's direct-deposit sign-up |
| Q6 direct-deposit sign-up | "already completed" unless the member says they will finish it within 3 business days |
| Item type of expense | fixed: Supplies, hidden |
| Item location | fixed: Berkeley, CA, hidden |
| Item invoice number | hidden, sent blank |
| Item additional misc. information | shown as "Comment" |
| Event details | not asked: STAR reimburses supplies, not events (left blank on CalLink) |

Request file shape: `subject, description, payee{firstName, lastName, street, street2,
city, state, zip}, uid, email, phone, expenditureAction?, directDepositSignedUp?,
specialInstructions?, items[{date, vendor, total, comment?, file}]`.

## The system (built 2026-10-02)

```
member ──form──▶ STARProject /finance ──admin approves──▶ queue
                     ▲   (Postgres: requests, PII, receipts)    │
                     │                                          ▼
   nightly scrape ───┴──── callink-worker ◀──claim/report── /api/worker/* (bearer token)
   (all of CalLink)           │  files on CalLink (plain HTTP, tagged [STAR R-n])
                              ▼
                           CalLink
```

- **STARProject** (`starproject/src/lib/finance/`, `src/app/finance`, `src/app/api/finance`,
  `src/app/api/worker`): the Finance tab lists every request (CalLink's history plus ours),
  the detail card hides address/phone/UID/receipts from everyone but the payee, the filer
  and admins, the form files to `pending_approval`, admins approve/reject/retry.
- **callink-worker** (`worker.mjs`, `lib/`): claims approved requests, files them, reports
  the CalLink id; scrapes and pushes CalLink nightly (`push.mjs` for the first import).
  Runs as the `callink-worker` service in `deploy/ec2/docker-compose.yml`, dry until
  `CALLINK_WORKER_FLAGS=--live`.

How a request is never filed twice:

1. The subject carries `[STAR R-n]`. Before posting, the worker looks for that tag on
   CalLink and reports "filed" if it is already there.
2. A journal entry is written before the final POST. A crash leaves it at `posting`;
   the next start reports "maybe filed", which parks the request as **Needs check** for
   an admin (who looks on CalLink and picks "It's on CalLink" or "queue again").
3. A claim's lease that runs out comes back as a *reconcile* job (look for the tag), never
   as a fresh filing.
4. The scrape links any CalLink request carrying our tag to its STARProject row and marks
   it filed, even if we had it as failed or re-queued.

Deletions: CalLink's list omits deleted requests, so the scrape's last batch sends every
listed id and rows no longer listed are marked deleted, unless that would mark more than
10 (or 5%) at once, which means a broken scrape, not a purge.
