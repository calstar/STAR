"use client";

import { useState } from "react";

import { Board } from "@/components/Board";
import { FieldSelect } from "@/components/fields/FieldSelect";
import { BOARD_SORT_OPTIONS, type BoardSort, type BoardTask } from "@/lib/board";

// Board plus its own sort picker, for contexts that render a board without the
// TasksWorkspace toolbar (e.g. a project or subteam detail page).
export function BoardWithSort({ tasks }: { tasks: BoardTask[] }) {
  const [sort, setSort] = useState<BoardSort>("due");
  return (
    <div>
      <div className="mb-3 flex justify-end">
        <FieldSelect
          ariaLabel="Sort board"
          value={sort}
          onChange={(v) => setSort(v as BoardSort)}
          options={BOARD_SORT_OPTIONS}
        />
      </div>
      <Board tasks={tasks} sort={sort} />
    </div>
  );
}
