# Outreach CRM (`/outreach`)

Sponsors, donors and mailing lists for the outreach team, inside STARProject.
**Admins only**: it holds donors' emails, home addresses (for perks) and gift
amounts. Non-admins see a notice and no sidebar link.

## What it replaces

| Before | Now |
|---|---|
| Current Sponsors List sheet, "Outreach Correspondence" tasks with one checkbox each | **Sponsors**: one deal per org per season, with a stage, ask, value, owner, last contact and next follow-up |
| Remembering who hasn't replied | **Today**: the queue of what needs you (bounced, your move, follow-ups due, gone quiet, unsent drafts, forms to submit, renewals not started) |
| Five crowdfunding mailing sheets, deduped by formula | **People** (one row per email, tags, referrer) and **Lists** (saved filters with live counts) |
| Copy-pasting addresses, writing each email by hand | **Compose**: a template merged per sponsor or person, opened as a filled-in Gmail draft |
| The ScaleFunder export in a sheet | **Campaigns**: gifts, perk checklist, ambassador table |

## A week of outreach

1. Open **Today**. Work top down: *Bounced* (find a new address), *Your move*
   (answer them), *Follow-ups due*, *Drafts never sent*, *Forms to submit*.
   Each row has ✉ Gmail, ✓ Sent (logs it, reminds you in 10 days), ↩ Replied
   and ⏰ +7d.
2. For a batch (renewals, cold asks, a follow-up nudge): **Compose** → pick
   sponsors by stage (or a saved list) → pick a template → **Open next in
   Gmail**. Review, attach the sponsorship packet if the email mentions it,
   send, then **Mark sent**. Sending stays in your own inbox.
3. For a blast (crowdfunding final push, thank-yous): **Lists** → open or
   build the list → **Open in Gmail as BCC batches** (≤400 a message) or copy
   the addresses.
4. When the campaign ends, import the ScaleFunder export again (safe to repeat:
   gifts are matched on `sf_id`), then use *Donors (for the thank-you)*.

## Importing a sheet

**Import** takes a range pasted from Google Sheets (with its header row) or a
CSV file, and always previews before it writes. It recognises:

- any contact list with an `Email` column (2024 Alumni / Friends & Family tabs;
  "Contact First/Last Name" is read as the member who referred them),
- the member list layout `NAME | EMAILS` (NAME is the member, filled down
  their block of five),
- the ScaleFunder "fulfill" export (gifts, perks, ambassador),
- the Current Sponsors List master sheet (one deal per sponsor; *Current* means
  a renewal to ask for this season).

People merge by email (existing values win, tags and referrers add up).
Placeholders ("whatever his email is") are skipped; mistyped domains
(`berkeley.efu`) are flagged and fixed if you tick the box.

**Sponsors → Bring in N sponsors from the task board** makes a deal for each
Outreach Correspondence task ("Correspondence - Garmin (inReach …)") and links
it back to the task.

## Why there are no automatic drafts

Real Gmail drafts need the restricted `gmail.compose` scope on the STAR Google
OAuth client; until Google verifies the app, every user is a manually added
test user who must reconnect every 7 days. Compose links
(`mail.google.com/mail/?view=cm&authuser=…`) open the same filled-in draft in
your own account with no setup. They can't carry attachments.

The CRM can't see your inbox either, so a reply or a bounce is logged by you
(↩ Replied, or tick *Address bounced* on the person). The MCP tools let an
agent with Gmail access do that logging for you.

## For agents

Tools are listed in `docs/MCP.md` (`get_outreach_dashboard`, `list_sponsors`,
`log_outreach_touch`, `get_outreach_merge`, `import_outreach_sheet`, …), all
admins only. Code: `src/lib/outreach/*` (pure, tested), `src/lib/actions/outreach.ts`,
`src/app/outreach/**`, `src/components/outreach/**`.
