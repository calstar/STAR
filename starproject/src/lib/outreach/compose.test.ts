import { describe, expect, it } from "vitest";

import { batches, clipboardText, gmailComposeUrl, mailtoUrl, uniqueEmails } from "./compose";

describe("gmailComposeUrl", () => {
  it("opens a filled compose window in the chosen account", () => {
    const url = new URL(
      gmailComposeUrl({ to: ["a@x.com"], subject: "Hi & bye", body: "Line 1\nLine 2", authuser: "me@berkeley.edu" }),
    );
    expect(url.origin + url.pathname).toBe("https://mail.google.com/mail/");
    expect(url.searchParams.get("view")).toBe("cm");
    expect(url.searchParams.get("authuser")).toBe("me@berkeley.edu");
    expect(url.searchParams.get("to")).toBe("a@x.com");
    expect(url.searchParams.get("su")).toBe("Hi & bye");
    expect(url.searchParams.get("body")).toBe("Line 1\nLine 2");
  });
});

describe("mailtoUrl", () => {
  it("encodes subject and body", () => {
    expect(mailtoUrl({ to: ["a@x.com"], subject: "A B", body: "x&y" })).toBe("mailto:a%40x.com?subject=A%20B&body=x%26y");
  });
});

describe("batches", () => {
  const emails = Array.from({ length: 10 }, (_, i) => `person${i}@example.com`);
  it("splits by count", () => {
    expect(batches(emails, { size: 4 }).map((b) => b.length)).toEqual([4, 4, 2]);
  });
  it("splits by URL length, and every batch's link fits", () => {
    const body = "x".repeat(450);
    const out = batches(emails, { size: 400, body, maxUrl: 600 });
    expect(out.length).toBeGreaterThan(1);
    expect(out.flat()).toEqual(emails);
    for (const b of out) expect(gmailComposeUrl({ bcc: b, body }).length).toBeLessThanOrEqual(600);
  });
});

describe("clipboardText", () => {
  const rs = [{ email: "a@x.com", name: "Ada, Countess" }, { email: "b@y.com" }];
  it("formats for pasting", () => {
    expect(clipboardText(rs)).toBe("a@x.com, b@y.com");
    expect(clipboardText(rs, "lines")).toBe("a@x.com\nb@y.com");
    expect(clipboardText(rs, "named")).toBe("Ada Countess <a@x.com>, b@y.com");
  });
});

describe("uniqueEmails", () => {
  it("dedupes ignoring case and blanks", () => {
    expect(uniqueEmails(["A@x.com", "a@x.com", null, "", "b@y.com"])).toEqual(["a@x.com", "b@y.com"]);
  });
});
