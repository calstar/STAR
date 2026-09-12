/**
 * Config validation rules — the single statement of what makes a config unfit to run.
 *
 * These rules used to exist only inside the config editor, as JSX rendered next to the field they
 * complained about. That made them advisory: an operator could see a red box on the Boards tab,
 * navigate away, and start a run on exactly that config. Only three of them (duplicate roles, the
 * state-machine consistency block, and the PWM assignment) ever stopped anything, and only at the
 * moment of pressing Save in the editor — never at the moment that matters, which is session start,
 * where the profile is deployed and the C++ services read it.
 *
 * So the rules live here, in the compiled `shared` package, and are evaluated in two places:
 *
 *   - the BACKEND, in SessionManager.start(), which refuses to start a run when any issue is
 *     found unless the caller explicitly overrides. That is the enforcement point, and it is the
 *     only one — a browser cannot skip it by not asking.
 *   - the config EDITOR, which renders the same issues inline as you type. Presentation only.
 *
 * Everything here is pure: config object in, plain-text issues out. No fetch, no fs, no DOM. The
 * backend reads the files (the ACTIVE PROFILE, which is what session start deploys) and calls in.
 *
 * `error` = will break the running config. `warn` = a mismatch worth fixing before a run. Both
 * block the first press of Start, because an operator who wanted neither would not have configured
 * it that way; the second press runs anyway, and that decision is theirs to make at the pad.
 */
/** Ids match the config editor's tab ids, so an issue can name the page that fixes it. */
export type ConfigPageId = 'boards' | 'roles' | 'gui' | 'controller' | 'state' | 'calibration' | 'system';
export declare const CONFIG_PAGE_LABELS: Record<ConfigPageId, string>;
export type ConfigIssueLevel = 'error' | 'warn';
export interface ConfigIssue {
    /** The editor tab an operator opens to fix this. */
    page: ConfigPageId;
    level: ConfigIssueLevel;
    /** Plain text — rendered by the editor and by the session page, so no markup. */
    message: string;
}
/** The three state-machine CSVs, as raw file text. An absent file is ''. */
export interface StateCsvSet {
    actuators: string;
    delays: string;
    transitions: string;
}
export type CsvGrid = {
    states: string[];
    rows: {
        key: string;
        cells: string[];
    }[];
};
export declare const parseCsvGrid: (text: string) => CsvGrid;
export declare const serializeCsvGrid: (g: CsvGrid) => string;
/** Rows/columns present in `have` but not `want`, and vice versa — the orphan/missing warnings. */
export declare const diffKeys: (have: string[], want: string[]) => {
    orphan: string[];
    missing: string[];
};
/**
 * Friendly board name for display: "PT Board #2" rather than the raw `pt_board_2` config key.
 * Numbered by position among boards of the same type, so it tracks what is actually configured
 * instead of parsing digits out of the key.
 */
export declare const boardDisplayName: (boards: Record<string, any>, boardKey: string) => string;
/**
 * Every layer maps a board to an Elodin slot as board_id % 10 (0 → 10), and the packet id low
 * byte is (slot-1) * 0x20 + 0x10 + channel — so only 8 slots fit in a byte, and two enabled
 * boards of the same type on one slot merge into a single entity with no error anywhere.
 *
 * Same-type only: the packet id's high byte already separates the types, so a PT and an actuator
 * board sharing a slot is fine. Mirrors check_board_slots() in
 * lib/src/config/LoadActiveBoards.cpp.
 */
export declare const boardSlotIssue: (boards: Record<string, any>, boardKey: string) => string | null;
/**
 * Every reason this config is unfit to run, in the order an operator would work through them.
 *
 * `csv` is optional: on a box whose profile predates the state tables, the CSV rules simply do not
 * run rather than reporting every state as missing. A config with no [[states]] at all skips the
 * state-machine rules for the same reason — that is a different and much louder problem, and
 * burying it under fifty derived complaints helps nobody.
 */
export declare function validateConfigForRun(config: any, csv?: Partial<StateCsvSet>): ConfigIssue[];
/** Group issues by the editor page that fixes them, preserving rule order within a page. */
export declare function groupIssuesByPage(issues: ConfigIssue[]): {
    page: ConfigPageId;
    label: string;
    issues: ConfigIssue[];
}[];
export declare const countByLevel: (issues: ConfigIssue[]) => {
    errors: number;
    warnings: number;
};
//# sourceMappingURL=config-validation.d.ts.map