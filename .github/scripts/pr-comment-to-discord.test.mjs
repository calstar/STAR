// node --test .github/scripts/
import assert from "node:assert/strict";
import { test } from "node:test";

import { toDiscordMessage } from "./pr-comment-to-discord.mjs";

const sender = { login: "inez9", type: "User", html_url: "https://github.com/inez9", avatar_url: "a.png" };
const repository = { full_name: "calstar/STAR" };
const pr = { number: 161, title: "starproject: subteam column", html_url: "https://github.com/calstar/STAR/pull/161" };

const embed = (m) => m.embeds[0];

test("a conversation comment on a PR is posted, linked to the comment", () => {
  const m = toDiscordMessage("issue_comment", {
    action: "created",
    sender,
    repository,
    issue: { ...pr, pull_request: { url: "x" } },
    comment: { body: "Looks good to me", html_url: "https://github.com/c/1", created_at: "2026-11-05T00:00:00Z" },
  });
  assert.equal(embed(m).title, "#161 starproject: subteam column");
  assert.equal(embed(m).url, "https://github.com/c/1");
  assert.equal(embed(m).description, "Looks good to me");
  assert.equal(embed(m).author.name, "inez9 commented on a pull request");
  assert.equal(embed(m).footer.text, "calstar/STAR");
});

test("a comment on a plain issue is not posted", () => {
  const m = toDiscordMessage("issue_comment", {
    action: "created",
    sender,
    repository,
    issue: { number: 3, title: "bug" },
    comment: { body: "hi" },
  });
  assert.equal(m, null);
});

test("an inline review comment says which file and line", () => {
  const m = toDiscordMessage("pull_request_review_comment", {
    action: "created",
    sender,
    repository,
    pull_request: pr,
    comment: { body: "off by one?", path: "src/lib/board.ts", line: 42, html_url: "u" },
  });
  assert.equal(embed(m).description, "`src/lib/board.ts:42`\noff by one?");
});

test("approvals and change requests are posted, coloured by verdict, even with no text", () => {
  const review = (state) =>
    toDiscordMessage("pull_request_review", {
      action: "submitted",
      sender,
      repository,
      pull_request: pr,
      review: { state, body: null, html_url: "r" },
    });
  assert.equal(embed(review("approved")).author.name, "inez9 approved a pull request");
  assert.equal(embed(review("approved")).color, 0x2da44e);
  assert.equal(embed(review("changes_requested")).author.name, "inez9 requested changes on a pull request");
  assert.equal(embed(review("changes_requested")).color, 0xcf222e);
  assert.equal(embed(review("approved")).description, undefined);
});

test("a bare 'commented' review (the wrapper around inline comments) is skipped", () => {
  const base = { action: "submitted", sender, repository, pull_request: pr };
  assert.equal(toDiscordMessage("pull_request_review", { ...base, review: { state: "commented", body: "" } }), null);
  const withSummary = toDiscordMessage("pull_request_review", {
    ...base,
    review: { state: "commented", body: "A few nits" },
  });
  assert.equal(embed(withSummary).author.name, "inez9 reviewed a pull request");
});

test("bots and edits are not posted", () => {
  const ev = { action: "created", repository, pull_request: pr, comment: { body: "x" } };
  assert.equal(toDiscordMessage("pull_request_review_comment", { ...ev, sender: { login: "ci", type: "Bot" } }), null);
  assert.equal(toDiscordMessage("pull_request_review_comment", { ...ev, action: "edited", sender }), null);
});

test("comment text can never ping anyone", () => {
  const m = toDiscordMessage("issue_comment", {
    action: "created",
    sender,
    repository,
    issue: { ...pr, pull_request: {} },
    comment: { body: "@everyone look" },
  });
  assert.deepEqual(m.allowed_mentions, { parse: [] });
});

test("long comments are cut to a glance", () => {
  const m = toDiscordMessage("issue_comment", {
    action: "created",
    sender,
    repository,
    issue: { ...pr, pull_request: {} },
    comment: { body: "a".repeat(5000) },
  });
  assert.equal(embed(m).description.length, 1500);
  assert.ok(embed(m).description.endsWith("…"));
});
