#!/usr/bin/env node
// Posts a pull request's comments and reviews to Discord, so a review doesn't
// sit unseen in a GitHub email. Run by .github/workflows/pr-comments-discord.yml.
//
// Input is the GitHub event (GITHUB_EVENT_NAME, GITHUB_EVENT_PATH); output is
// one Discord webhook post to DISCORD_WEBHOOK_URL. Without that secret it
// prints the message it would have sent and exits 0, so a fork or a repo that
// hasn't set it up doesn't go red.
//
// The comment text is untrusted (anyone can comment on a public PR): it is only
// ever data here -- read from the event file, never interpolated into a shell --
// and the post sets allowed_mentions to nothing, so "@everyone" in a comment
// can't ping the server.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_BODY = 1500; // Discord allows 4096 in an embed; keep it a glance.

const COLOR = {
  approved: 0x2da44e, // green
  changes_requested: 0xcf222e, // red
  comment: 0x5865f2, // Discord blurple
};

const truncate = (s, n = MAX_BODY) => {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/**
 * The Discord webhook body for a GitHub event, or null when the event isn't
 * worth a message. Pure, so it can be tested without GitHub or Discord.
 *
 * Skipped: comments on issues (not PRs); anything a bot wrote; and a review
 * that is only "commented" with no summary text -- that is the wrapper GitHub
 * makes around inline comments, which are each posted on their own already.
 */
export function toDiscordMessage(eventName, event) {
  const sender = event.sender ?? {};
  if (sender.type === "Bot") return null;

  let pr;
  let kind = "comment";
  let verb;
  let body;
  let url;
  let where = "";

  if (eventName === "issue_comment") {
    if (event.action !== "created" || !event.issue?.pull_request) return null;
    pr = event.issue;
    verb = "commented on";
    body = event.comment?.body;
    url = event.comment?.html_url;
  } else if (eventName === "pull_request_review_comment") {
    if (event.action !== "created") return null;
    pr = event.pull_request;
    verb = "commented on";
    body = event.comment?.body;
    url = event.comment?.html_url;
    const c = event.comment ?? {};
    const line = c.line ?? c.original_line;
    if (c.path) where = line ? `${c.path}:${line}` : c.path;
  } else if (eventName === "pull_request_review") {
    if (event.action !== "submitted") return null;
    pr = event.pull_request;
    const state = (event.review?.state ?? "").toLowerCase();
    body = event.review?.body;
    url = event.review?.html_url;
    if (state === "approved") {
      kind = "approved";
      verb = "approved";
    } else if (state === "changes_requested") {
      kind = "changes_requested";
      verb = "requested changes on";
    } else {
      if (!truncate(body)) return null;
      verb = "reviewed";
    }
  } else {
    return null;
  }
  if (!pr) return null;

  const who = sender.login ?? "someone";
  const text = truncate(body);
  const description = [where && `\`${where}\``, text].filter(Boolean).join("\n");

  return {
    username: "GitHub PRs",
    // Never ping from comment text: no @everyone, @here, roles or users.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: truncate(`#${pr.number} ${pr.title ?? ""}`, 250),
        url: url ?? pr.html_url,
        color: COLOR[kind],
        author: {
          name: `${who} ${verb} a pull request`,
          url: sender.html_url,
          icon_url: sender.avatar_url,
        },
        ...(description ? { description } : {}),
        footer: { text: event.repository?.full_name ?? "" },
        timestamp: event.comment?.created_at ?? event.review?.submitted_at ?? undefined,
      },
    ],
  };
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const message = toDiscordMessage(eventName, event);
  if (!message) {
    console.log(`Nothing to post for ${eventName}.`);
    return;
  }
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) {
    console.log("::notice::DISCORD_PR_WEBHOOK_URL is not set; this is what would have been posted:");
    console.log(JSON.stringify(message, null, 2));
    return;
  }
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    // The body can echo the request; the URL (the secret) is never printed.
    throw new Error(`Discord answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  console.log(`Posted ${eventName} on #${message.embeds[0].title.split(" ")[0]} to Discord.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
