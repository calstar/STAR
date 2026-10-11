import { prisma } from "@/lib/db";
import { parseMoney, sumCents } from "@/lib/finance/money";
import { checkReceipt, safeFileName } from "@/lib/finance/receipts";
import { reimbursementInputSchema } from "@/lib/finance/schema";
import { displayNameOf } from "@/lib/names";

// Filing a reimbursement: the form's JSON in `payload` plus one receipt per
// item as `receipt-<index>`. It lands as pending_approval; nothing goes to
// CalLink until an admin approves it. Shared by POST /api/finance/requests (the
// web form) and the MCP `file_reimbursement` tool, which build the same FormData.

export type Filer = { id: string; email: string; name: string | null; displayName: string | null };

export type FileResult =
  | { number: number }
  | { error: string; fieldErrors?: Record<string, string>; status: 400 | 413 };

export async function fileReimbursement(user: Filer, form: FormData): Promise<FileResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("payload") ?? ""));
  } catch {
    return { error: "The form data was malformed.", status: 400 };
  }
  const parsed = reimbursementInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[issue.path.join(".")] ??= issue.message;
    return { error: "Some fields need fixing.", fieldErrors, status: 400 };
  }
  const input = parsed.data;

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
  if (Object.keys(fieldErrors).length) return { error: "Some receipts need fixing.", fieldErrors, status: 400 };

  const amounts = input.items.map((it) => parseMoney(it.amount));
  const p = input.payee;

  const created = await prisma.$transaction(async (tx) => {
    const r = await tx.reimbursement.create({
      data: {
        source: "starproject",
        status: "pending_approval",
        subject: input.subject,
        description: input.description ?? null,
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

  return { number: created.number };
}
