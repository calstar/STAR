"use client";

import { RoleRoster } from "@/components/settings/RoleRoster";
import { addAdmin, removeAdmin } from "@/lib/actions/admins";

export function AdminConfig({ admins }: { admins: { email: string }[] }) {
  return <RoleRoster members={admins} noun="admin" add={addAdmin} remove={removeAdmin} />;
}
