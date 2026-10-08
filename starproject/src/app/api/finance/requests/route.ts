import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { MAX_RECEIPT_BYTES, checkReceipt, safeFileName } from "@/lib/finance/receipts";
import { parseMoney, sumCents } from "@/lib/finance/money";
import { MAX_ITEMS, reimbursementInputSchema } from "@/lib/finance/schema";
import { displayNameOf } from "@/lib/names";
import { getCurrentDbUser } from "@/lib/user";

export const dynamic = "force-dynamic";

// A member files a reimbursement: the form's JSON in `payload` plus one receipt
// per item as `receipt-<index>`. It lands as pending_approval; nothing goes to
// CalLink until an admin approves it. A route rather than a server action so a
// failed submit keeps the form (and its chosen files) and the 1 MB action body
// limit doesn't apply.

const MAX_BODY = MAX_ITEMS * MAX_RECEIPT_BYTES + 512 * 1024;

const fail = (error: string, fieldErrors?: Record<string, string>, status = 400) =>
  NextResponse.json({ error, fieldErrors }, { status });

export async function POST(req: Request) {
  const user = await getCurrentDbUser();
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) {
    return fail("That's too much to upload at once: each receipt must be under 4 MB.", undefined, 413);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("The upload didn't arrive in one piece; try again.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("payload") ?? ""));
  } catch {
    return fail("The form data was malformed.");
  }
  const parsed = reimbursementInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[issue.path.join(".")] ??= issue.message;
    return fail("Some fields need fixing.", fieldErrors);
  }
  const input = parsed.data;

  const [project, subteam] = await Promise.all([
    input.projectId ? prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true } }) : null,
    input.subteamId ? prisma.subteam.findUnique({ where: { id: input.subteamId }, select: { id: true } }) : null,
  ]);
  if (input.projectId && !project) return fail("Some fields need fixing.", { projectId: "That project no longer exists" });
  if (input.subteamId && !subteam) return fail("Some fields need fixing.", { subteamId: "That subteam no longer exists" });

  // One receipt per item: CalLink takes one file per item.
  const receipts: { fileName: string; mimeType: string; data: Uint8Array<ArrayBuffer> }[] = [];
  const fieldErrors: Record<string, string> = {};
  for (let i = 0; i < input.items.length; i++) {
    const file = form.get(`receipt-${i}`);
    if (!(file instanceof File) || file.size === 0) {
      fieldErrors[`items.${i}.receipt`] = "Attach the receipt";
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkReceipt(file.name, bytes.length, bytes.subarray(0, 8));
    if (!check.ok) {
      fieldErrors[`items.${i}.receipt`] = check.error;
      continue;
    }
    receipts.push({ fileName: safeFileName(file.name), mimeType: check.mime, data: bytes });
  }
  if (Object.keys(fieldErrors).length) return fail("Some receipts need fixing.", fieldErrors);

  const amounts = input.items.map((it) => parseMoney(it.amount));
  const p = input.payee;

  const created = await prisma.$transaction(async (tx) => {
    const r = await tx.reimbursement.create({
      data: {
        source: "starproject",
        status: "pending_approval",
        subject: input.subject,
        description: input.description ?? null,
        projectId: project?.id ?? null,
        subteamId: subteam?.id ?? null,
        specialInstructions: input.specialInstructions ?? null,
        expenditureAction: input.expenditureAction,
        directDepositSignedUp: input.expenditureAction === "Direct Deposit" ? input.directDepositSignedUp : null,
        amountCents: sumCents(amounts),
        payeeFirstName: p.firstName,
        payeeLastName: p.lastName,
        payeeEmail: input.email,
        submitterName: displayNameOf(user),
        submitterEmail: user.email.toLowerCase(),
        createdById: user.id,
        pii: {
          create: {
            street: p.street,
            street2: p.street2 ?? null,
            city: p.city,
            state: p.state,
            zip: p.zip,
            phone: input.phone,
            uid: input.uid,
          },
        },
        events: { create: { kind: "created", toStatus: "pending_approval", actorId: user.id } },
      },
      select: { id: true, number: true },
    });
    for (const [i, it] of input.items.entries()) {
      const rc = receipts[i];
      await tx.reimbursementItem.create({
        data: {
          reimbursementId: r.id,
          position: i + 1,
          date: it.date,
          vendor: it.vendor,
          amountCents: amounts[i],
          comment: it.comment ?? null,
          receipts: {
            create: {
              fileName: rc.fileName,
              mimeType: rc.mimeType,
              size: rc.data.length,
              blob: { create: { data: rc.data } },
            },
          },
        },
      });
    }
    if (input.saveProfile) {
      const profile = {
        firstName: p.firstName,
        lastName: p.lastName,
        street: p.street,
        street2: p.street2 ?? null,
        city: p.city,
        state: p.state,
        zip: p.zip,
        phone: input.phone,
        uid: input.uid,
        // Only remember an email that differs from the account's.
        email: input.email === user.email.toLowerCase() ? null : input.email,
        directDepositSignedUp: input.directDepositSignedUp,
      };
      await tx.payeeProfile.upsert({ where: { userId: user.id }, create: { userId: user.id, ...profile }, update: profile });
    }
    return r;
  });

  return NextResponse.json({ number: created.number });
}
