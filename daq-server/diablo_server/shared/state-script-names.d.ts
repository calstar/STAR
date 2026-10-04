/**
 * Name checking for dynamic-state scripts, without a parser.
 *
 * The sequencer has the only parser, in C++, because it is the thing that executes scripts. The
 * backend spawns `state_script_check` (the same code, as a hermetic binary) for syntax. What is
 * left for the browser is the error people actually make — a typo'd valve or state name — and that
 * needs a lookup, not a grammar.
 *
 * ── Why scanning by regex is SAFE here, and would not be in another language ───────────────────
 *
 * Names in this language resolve POSITIONALLY: the argument of open_valve/close_valve is an
 * actuator role, of pressure() a PT sensor role, of transition_to() a state. Nothing else is a
 * name. So a pattern anchored to the call it sits in cannot confuse namespaces — and that matters
 * concretely, because on the shipped `server` profile FUEL_VENT is BOTH a valve and a state, and
 * on `digital-twin` FUEL_UPSTREAM is both a valve and a sensor. A bare search for the token would
 * be ambiguous; a search for `transition_to(FUEL_VENT)` is not.
 *
 * The blind spot is honest and bounded: a slug sitting inside a syntactically broken line may not
 * match, and this says nothing about syntax at all. `state_script_check` covers both, a
 * keystroke-debounce later, and the sequencer re-checks everything at load and is the authority.
 */
/** Canonical config name -> slug: trim, uppercase, collapse whitespace runs to one underscore.
 *  Must match fsw::script::slugify exactly. */
export declare function slugify(name: string): string;
/** Usable as a bare identifier. Must match fsw::script::is_valid_slug. */
export declare function isValidSlug(slug: string): boolean;
/** A bare <name>.script filename — no separators, no "..". Matches is_valid_script_filename. */
export declare function isValidScriptFilename(name: string): boolean;
export type ScriptNamespace = 'actuator' | 'sensor' | 'state';
export interface ScriptNameRef {
    slug: string;
    ns: ScriptNamespace;
    /** 1-based, for the editor gutter. */
    line: number;
}
/** Every name reference in a script, with the namespace its position puts it in. */
export declare function scanScriptNames(src: string): ScriptNameRef[];
/**
 * Rewrite every reference to `fromSlug` in ONE namespace.
 *
 * Scoped to the namespace on purpose. A bare `text.replaceAll('FUEL_VENT', ...)` when renaming the
 * *state* Fuel Vent would also rewrite `open_valve(FUEL_VENT)` into a valve that does not exist —
 * and since validation would then reject it, an unrelated state rename would silently make a
 * working state unenterable. Both names exist on the shipped server profile today.
 */
export declare function renameScriptSlug(src: string, ns: ScriptNamespace, fromSlug: string, toSlug: string): string;
export interface ScriptNameTables {
    actuators: Set<string>;
    sensors: Set<string>;
    states: Set<string>;
    /** State slugs reachable from the state that owns this script. */
    allowedTransitions: Set<string>;
}
export interface ScriptNameIssue {
    line: number;
    message: string;
}
/** Slug-level problems only. Says nothing about syntax — that is state_script_check's job. */
export declare function checkScriptNames(src: string, tables: ScriptNameTables): ScriptNameIssue[];
//# sourceMappingURL=state-script-names.d.ts.map