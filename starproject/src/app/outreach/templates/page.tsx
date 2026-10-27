import { TemplatesWorkspace } from "@/components/outreach/TemplatesWorkspace";
import { listTemplates, outreachViewer } from "@/lib/outreach/queries";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  // Non-admins see the layout's notice; nothing here may load for them.
  if (!(await outreachViewer()).admin) return null;
  const [{ user }, templates] = await Promise.all([outreachViewer(), listTemplates()]);
  return (
    <TemplatesWorkspace
      templates={templates}
      senderName={user.name ?? user.email}
      senderEmail={user.email}
    />
  );
}
