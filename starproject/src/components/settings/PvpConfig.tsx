"use client";

import { RoleRoster } from "@/components/settings/RoleRoster";
import { addPvp, removePvp } from "@/lib/actions/pvp";

export function PvpConfig({ pvps }: { pvps: { email: string }[] }) {
  return <RoleRoster members={pvps} noun="PVP" add={addPvp} remove={removePvp} />;
}
