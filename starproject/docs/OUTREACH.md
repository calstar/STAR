# Outreach CRM (`/outreach`)

A go-between for your Gmail and the task board: who we've written to, who
answered, what's overdue, and the mailing lists, with each email opened as a
filled-in Gmail draft. **Admins only** (it holds donors' emails, home
addresses and gifts) and **not in the sidebar**: it's a separate tool you reach
by its link, so bookmark `/outreach`.

## The pieces

| Tab | What it's for |
|---|---|
| **Today** | What needs you: bounced, your move (they replied), follow-ups due, gone quiet, drafts never sent, forms to submit, renewals not started. Each row has ✉ Gmail, ✓ Sent (reminds you in 10 days), ↩ Replied, ⏰ +7d and **+ Task**. |
| **Sponsors** | One deal per org per season: stage, ask, what they give, value, last contact, next follow-up, notes. |
| **People** | One row per person, with tags, affiliation, class year, phone, gifts and history. |
| **Lists** | Saved filters with live counts → copy the addresses, CSV, or Gmail BCC batches. |
| **Compose** | A template merged per sponsor or person, opened one by one in Gmail, then marked sent. |
| **Campaigns** | Crowdfunding: gifts, goal, deadlines, perk checklist. |
| **Templates / Import** | Email templates with merge fields; paste a sheet in. |

## The task board

The CRM and the board stay separate. **+ Task** (on a sponsor, or its row on
Today) files one ordinary task, "Correspondence - <org> (<ask>)", in the
**Outreach Correspondence** project, assigned to you and due on the deal's
follow-up date. If an open task for that sponsor is already there you get a
link to it instead. Nothing links the task back, and the CRM never reads the
board.

## A week of outreach

1. **Today**, top down. Answer *Your move*, nudge *Follow-ups due*, send or
   delete the *Drafts never sent*, paste the *Forms to submit*. Use **+ Task**
   for anything that needs work beyond an email.
2. For a batch: **Compose** → sponsors by stage or a saved list → a template →
   **Open next in Gmail**. Attach the packet if the email mentions it, send,
   **Mark sent**.
3. For a blast: **Lists** → **Open in Gmail as BCC batches** (≤400 a message).
4. After a campaign: import the ScaleFunder export again (gifts match on
   `sf_id`, so it's safe to repeat), then email *Donors (for the thank-you)*.

## Alumni

Alumni are people with affiliation **Alumni**, and can carry a **class year** and
a **phone**. Phones are stored as `+1…` whatever way they were typed, and show
as tap-to-call and **Text** links. On **Lists**, *Alumni* and *Alumni with phone
numbers* are quick starts. Filter by class year ("class of 2015–2020") and
*Has a phone number*. Every list shows its phone numbers beside its emails
(**Copy numbers**, **Copy as Name: number**, per-person Text links), including
alumni who have a phone but no email, and the CSV has both. Templates can say
`{{class_year}}`.

Import an alumni sheet with *Affiliation: Alumni*. The importer reads `Phone` /
`Cell` / `Mobile` and `Class Year` / `Class of` / `Grad Year` columns. A row
with only a name and a phone is kept.

## Importing a sheet

Paste a range (with its header row) or a CSV, preview, then import. It reads
any contact list with an `Email` column, the members' `NAME | EMAILS`
crowdfunding lists (NAME is the member, so it's ignored), the ScaleFunder
"fulfill" export, and the Current Sponsors List. People merge by email;
placeholders are skipped; mistyped domains (`berkeley.efu`) are flagged and
fixed if you tick the box.

## Gmail

Emails open as Gmail compose links in your own account, so there's no Gmail API
and no OAuth setup. Links can't carry attachments, and the CRM can't see your
inbox: log replies and bounces yourself (↩ Replied, *Address bounced*), or let
an agent with Gmail access do it through the MCP tools (`docs/MCP.md`, all
admins only).
