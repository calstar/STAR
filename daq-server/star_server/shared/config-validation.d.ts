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
/** Ids match the config editor's tab ids, so an issue can name the page that fixes it — except
 *  'profile', which is the profile picker at the top of the editor rather than a tab of its own. */
export type ConfigPageId = 'profile' | 'boards' | 'roles' | 'gui' | 'controller' | 'state' | 'calibration';
export declare const CONFIG_PAGE_LABELS: Record<ConfigPageId, string>;
/** The config editor's tabs, in order: every page id but 'profile'. */
export declare const CONFIG_TAB_IDS: ("state" | "boards" | "roles" | "gui" | "controller" | "calibration")[];
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
/** [boards.*].type of a motorized ball valve board (firmware/Hotfire_Code/BallValve_Hotfire). */
export declare const BALL_VALVE_TYPE = "BALL_VALVE";
/**
 * board_ids of every [boards.*] with type BALL_VALVE, enabled or not. An actuator role whose
 * board_id is in this set is a ball valve: no NO/NC (1 is open on the wire), no PWM, and its
 * position (not a current) is what shows under it.
 */
export declare const ballValveBoardIds: (config: any) => Set<number>;
/** The name an operator gave a board ([boards.*].name), trimmed; '' when it has none. */
export declare const boardGivenName: (board: any) => string;
/**
 * Friendly board name for display: its given name ([boards.*].name) when it has one, else
 * "PT Board #2" rather than the raw `pt_board_2` config key — numbered by position among boards
 * of the same type, so it tracks what is actually configured instead of parsing digits out of
 * the key.
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
export type T7Kind = 'PT' | 'TC' | 'LC' | 'RTD' | 'VOLTAGE';
/** The field a calibrated T7 channel publishes, by kind; VOLTAGE has no calibrated table. */
export declare const T7_CAL_FIELD: Record<string, string | undefined>;
export declare const T7_PT_SIGNALS: readonly ["0-5V", "0.5-4.5V", "1-5V", "0-10V", "4-20mA"];
export declare const T7_RANGES: readonly [10, 1, 0.1, 0.01];
export declare const T7_MAX_AIN = 13;
/** AIN14 is the T7's internal temperature sensor, streamed raw for thermocouple CJC. */
export declare const T7_CJC_AIN = 14;
export interface T7ChannelInfo {
    boardKey: string;
    boardId: number;
    boardIp: string;
    enabled: boolean;
    slot: number;
    ain: number;
    /** 'CJC' is the AIN14 entry a board with a thermocouple streams; it has no role. */
    kind: T7Kind | 'CJC';
    role: string;
    rawLow: number;
    entity: string;
    /** null for VOLTAGE and CJC, which publish volts only. */
    calLow: number | null;
    calEntity: string | null;
    calField: string | null;
}
/**
 * Every T7 channel in `boards`, in config order, with the tables t7_bridge publishes it to.
 * Disabled boards are included (enabled: false) so an editor can still show them; anything that
 * subscribes or lists live sensors filters them out. Malformed entries (no integer ain, no
 * integer board_id) are skipped — t7BoardIssues() is what reports them.
 */
export declare function t7Channels(boards: Record<string, any> | undefined | null): T7ChannelInfo[];
/**
 * What is wrong with one T7 board, as plain sentences; [] for a fine one or a non-T7. Mirrors
 * parse_t7_boards() in lib/src/config/T7Config.cpp check for check, so the editor and the session
 * gate refuse exactly what t7_bridge would.
 */
export declare function t7BoardIssues(boards: Record<string, any>, boardKey: string): string[];
/** The part of t7BoardIssues() about the board itself (identity, network, stream) — the Boards tab. */
export declare function t7BoardSettingsIssues(boards: Record<string, any>, boardKey: string): string[];
/** The part of t7BoardIssues() about the channel table — the Roles tab, where the table lives. */
export declare function t7ChannelIssues(boards: Record<string, any>, boardKey: string): string[];
/**
 * Enabled T7 inputs whose role an ESP32 sensor ([sensor_roles_<board>]) already has. The GUI finds
 * a sensor by its role (sensorByRole, [gui.groups], pressure bars) and calibration files it by
 * role, so a shared name would make one of the two unreachable.
 */
export declare function t7RoleClashes(config: any): Array<{
    boardKey: string;
    ain: number;
    message: string;
}>;
/**
 * Every reason this config is unfit to run, in the order an operator would work through them.
 *
 * `csv` is optional: on a box whose profile predates the state tables, the CSV rules simply do not
 * run rather than reporting every state as missing. A config with no [[states]] at all skips the
 * state-machine rules for the same reason — that is a different and much louder problem, and
 * burying it under fifty derived complaints helps nobody.
 */
/**
 * Where a board sits when no DHCP server answered it: 169.254.<1 + mac[4] % 254>.<mac[5]>.
 * Must match BoardNet::recoveryAddress (firmware/Hotfire_Code/common/board_net.h),
 * firmware/tools/ota_upload.py and deploy/dhcp/generate_dhcp_config.py. Null for a malformed MAC.
 */
export declare function recoveryAddress(mac: string): string | null;
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