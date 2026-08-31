"use client";

import { useState } from "react";

import { FieldSelect } from "@/components/fields/FieldSelect";
import { updateField } from "@/lib/fieldUpdate";

export function SubteamSelect({
  taskId,
  value,
  subteams,
}: {
  taskId: string;
  value: string | null;
  subteams: { id: string; name: string }[];
}) {
  const [v, setV] = useState(value ?? "");
  const options = [
    { value: "", label: "No subteam" },
    ...subteams.map((s) => ({ value: s.id, label: s.name })),
  ];
  return (
    <FieldSelect
      ariaLabel="Subteam"
      value={v}
      options={options}
      onChange={(next) => {
        setV(next);
        updateField(taskId, "subteamId", next);
      }}
    />
  );
}
