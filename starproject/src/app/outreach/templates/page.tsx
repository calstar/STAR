import { TemplatesWorkspace } from "@/components/outreach/TemplatesWorkspace";
import { listTemplates, outreachViewer } from "@/lib/outreach/queries";
import { STARTER_TEMPLATES } from "@/lib/outreach/starter-templates";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const [{ user }, templates] = await Promise.all([outreachViewer(), listTemplates()]);
  const names = new Set(templates.map((t) => t.name));
  const missingStarters = STARTER_TEMPLATES.filter((t) => !names.has(t.name)).length;
  return (
    <TemplatesWorkspace
      templates={templates}
      missingStarters={missingStarters}
      senderName={user.name ?? user.email}
      senderEmail={user.email}
    />
  );
}
