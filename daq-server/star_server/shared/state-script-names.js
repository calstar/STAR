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
export function slugify(name) {
    return name.trim().toUpperCase().replace(/\s+/g, '_');
}
/** Usable as a bare identifier. Must match fsw::script::is_valid_slug. */
export function isValidSlug(slug) {
    return /^[A-Z][A-Z0-9_]*$/.test(slug);
}
/** A bare <name>.script filename — no separators, no "..". Matches is_valid_script_filename. */
export function isValidScriptFilename(name) {
    return /^[A-Za-z0-9_-]+\.script$/.test(name);
}
/** Comment-stripped source, so a name inside a `#` comment is not reported. */
function stripComments(src) {
    return src.split('\n').map((l) => {
        const hash = l.indexOf('#');
        return hash >= 0 ? l.slice(0, hash) : l;
    });
}
const PATTERNS = [
    { re: /\b(?:open_valve|close_valve)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, ns: 'actuator' },
    { re: /\bpressure\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, ns: 'sensor' },
    { re: /\btransition_to\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, ns: 'state' },
];
/** Every name reference in a script, with the namespace its position puts it in. */
export function scanScriptNames(src) {
    const out = [];
    stripComments(src).forEach((text, i) => {
        for (const { re, ns } of PATTERNS) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(text)) !== null)
                out.push({ slug: m[1], ns, line: i + 1 });
        }
    });
    return out;
}
/**
 * Rewrite every reference to `fromSlug` in ONE namespace.
 *
 * Scoped to the namespace on purpose. A bare `text.replaceAll('FUEL_VENT', ...)` when renaming the
 * *state* Fuel Vent would also rewrite `open_valve(FUEL_VENT)` into a valve that does not exist —
 * and since validation would then reject it, an unrelated state rename would silently make a
 * working state unenterable. Both names exist on the shipped server profile today.
 */
export function renameScriptSlug(src, ns, fromSlug, toSlug) {
    const calls = ns === 'actuator' ? '(?:open_valve|close_valve)' : ns === 'sensor' ? 'pressure' : 'transition_to';
    const esc = fromSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(\\b${calls}\\s*\\(\\s*)${esc}(\\s*\\))`, 'g');
    return src.replace(re, `$1${toSlug}$2`);
}
/** Slug-level problems only. Says nothing about syntax — that is state_script_check's job. */
export function checkScriptNames(src, tables) {
    const out = [];
    for (const ref of scanScriptNames(src)) {
        const table = ref.ns === 'actuator' ? tables.actuators : ref.ns === 'sensor' ? tables.sensors : tables.states;
        if (!table.has(ref.slug)) {
            const near = [...table].find((s) => levenshteinAtMostOne(s, ref.slug));
            out.push({
                line: ref.line,
                message: `no ${ref.ns} named ${ref.slug}${near ? ` — did you mean ${near}?` : ''}`,
            });
            continue;
        }
        if (ref.ns === 'state' && !tables.allowedTransitions.has(ref.slug)) {
            out.push({
                line: ref.line,
                message: `this state is not allowed to transition to ${ref.slug} — the Transitions table does not permit it`,
            });
        }
    }
    return out;
}
/** One substitution, insertion or deletion apart. Enough for FUEL_VNT vs FUEL_VENT. */
function levenshteinAtMostOne(a, b) {
    if (a === b)
        return false;
    if (Math.abs(a.length - b.length) > 1)
        return false;
    if (a.length === b.length) {
        let diff = 0;
        for (let i = 0; i < a.length; i++)
            if (a[i] !== b[i] && ++diff > 1)
                return false;
        return diff === 1;
    }
    const short = a.length < b.length ? a : b;
    const long = a.length < b.length ? b : a;
    let i = 0;
    let j = 0;
    let skipped = false;
    while (i < short.length && j < long.length) {
        if (short[i] === long[j]) {
            i++;
            j++;
        }
        else if (!skipped) {
            skipped = true;
            j++;
        }
        else {
            return false;
        }
    }
    return true;
}
//# sourceMappingURL=state-script-names.js.map