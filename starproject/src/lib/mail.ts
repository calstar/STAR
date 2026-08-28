import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

type MailOpts = { to: string; subject: string; html: string; text: string };

let _client: SESv2Client | null = null;
function client(): SESv2Client {
  if (!_client) {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    _client = new SESv2Client(region ? { region } : {});
  }
  return _client;
}

/**
 * Send one email via SES. No-ops (logs, returns true) when SES_FROM is unset, so
 * local dev / CI / builds never try to send. Never throws — returns false on
 * failure so callers (and the deadline scan) can decide whether to record it.
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
}: MailOpts): Promise<boolean> {
  const from = process.env.SES_FROM;
  if (!from) {
    console.log(`[mail:noop] to=${to} subject="${subject}" (SES_FROM unset)`);
    return true;
  }
  try {
    await client().send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject },
            Body: { Html: { Data: html }, Text: { Data: text } },
          },
        },
      }),
    );
    return true;
  } catch (err) {
    console.error("[mail] send failed:", err);
    return false;
  }
}
