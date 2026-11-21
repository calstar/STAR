# openrocket-web: the document and the API

The contract between the Python port (`orweb/`), the API (`backend/`) and the UI
(`frontend/`). Units are SI throughout the wire (m, kg, s, rad *except* where a
key says `Deg`); the UI converts for display.

## The rocket document

A design is a tree of components, serialised exactly as the `.ork` file names
things so the two never drift apart: a component's `type` is its `.ork` element
name and its `params` keys are the `.ork` child-element names.

```jsonc
{
  "version": 1,
  "rocket": Component,            // type "rocket"
  "motorConfigs": [               // OpenRocket's flight configurations
    { "id": "uuid", "name": "", "default": true,
      "stages": { "0": true },    // stage number -> active
      "motors": {                 // mount component id -> motor
        "<mountId>": { "designation": "C6", "manufacturer": "Estes",
                       "digest": "…", "delay": 5.0,
                       "ignitionEvent": "automatic", "ignitionDelay": 0.0 } } }
  ],
  "selectedConfig": "uuid"
}
```

### Component

```jsonc
{
  "id": "uuid",
  "type": "nosecone",      // see the list below
  "name": "Nose cone",
  "params": { … },         // .ork element names
  "children": [Component]  // .ork <subcomponents>
}
```

Types: `rocket`, `stage`, `parallelstage`, `podset`, `nosecone`, `bodytube`,
`transition`, `trapezoidfinset`, `ellipticalfinset`, `freeformfinset`,
`tubefinset`, `launchlug`, `railbutton`, `innertube`, `tubecoupler`,
`centeringring`, `bulkhead`, `engineblock`, `masscomponent`, `shockcord`,
`parachute`, `streamer`.

Param value shapes:

| shape | example | used for |
|---|---|---|
| number | `"length": 0.1` | plain lengths, counts, angles (rad) |
| string | `"shape": "ogive"`, `"finish": "normal"` | enums, lower-case as in `.ork` |
| bool | `"aftshouldercapped": true` | |
| auto number | `"radius": {"auto": true, "value": 0.0125}` | anything `.ork` may write as `auto …`; `value` is the resolved number, and the UI sends `{"auto": false, "value": x}` to pin it |
| position | `"axialoffset": {"method": "top", "value": 0.032}` | methods `absolute`, `after`, `top`, `middle`, `bottom` |
| material | `"material": {"type": "bulk", "density": 680.0, "name": "Cardboard"}` | type `bulk` (kg/m³), `surface` (kg/m²), `line` (kg/m) |
| points | `"finpoints": [[0,0],[0.05,0.03],[0.07,0]]` | freeform fins, metres |
| override | `"overridemass": 0.012` absent = not overridden | `overridemass`, `overridecg`, `overridecd`, with `overridesubcomponents*` bools |

Params the port does not use (appearance, decals, presets) are carried through
untouched so a load–save round trip loses nothing.

How `orweb` fills in the details (`orweb/ork.py`, `orweb/build.py`):

- **Order matters.** `params` keep file order and are applied in that order, as
  OpenRocket's loader does (several setters clamp against what is already set).
- **Duplicates the savers write are folded in**: `position` into `axialoffset`,
  `rotation` (fins) and a launch lug's `radialdirection` into `angleoffset`,
  `fincount` into `instancecount`. Saving writes both forms again.
- **Other shapes**: a body's `"thickness": "filled"`; `"tabposition": {"method":
  "top"|"middle"|"bottom", "value"}`; `"motormount": {"ignitionevent",
  "ignitiondelay", "overhang"}` on a mount (its motors live in `motorConfigs`);
  `radialdirection`, `cant`, `clusterrotation` in rad. An auto param written
  `auto` with no number in the file (ring radii, recovery `cd`) has
  `"value": null`; `orweb.resolve_auto_values` fills those in.
- **Passthrough**: an element the port does not interpret is `{"_xml": "<raw>"}`
  (a list if repeated); the root's `"motorconfiguration": {"_configs": true}`
  marks where `motorConfigs` are written. Everything outside `<rocket>`
  (simulations, photo studio, preferences) and the zip's other entries (decals)
  are in `document["ork"]` = `{"version", "creator", "extra": [raw xml],
  "files": {path: base64}}`.
- **Motors** in `motorConfigs[].motors` may also carry `type`, `diameter`,
  `length`; `"delay": null` is a plugged motor. `selectedConfig: null` is
  OpenRocket's default configuration (no motors). Motors resolve by
  designation, manufacturer and digest against `orweb/data/motors.json`
  (OpenRocket's own curves for every example) or a `MotorRegistry`.

## The API (FastAPI, `:8004`, prefix `/api`)

The routes are `orweb.api`'s router. Standalone (`backend/main.py`, `:8004`) it is
mounted at `/api`; inside star-openrocket (`:8002`) at `/api/ork`, so there
`/api/ork/import` below is `/api/ork/ork/import`. `/examples` lists
`tests/rockets/` standalone and the five rockets packaged in `orweb/data/examples/`
everywhere else.

| method | path | body | returns |
|---|---|---|---|
| GET | `/api/health` | | `{"ok": true, "openrocket": "24.12"}` |
| GET | `/api/examples` | | `[{"name": "A simple model rocket"}]` |
| GET | `/api/examples/{name}` | | Document |
| POST | `/api/ork/import` | multipart `file` (.ork) | Document |
| POST | `/api/ork/export` | Document | `.ork` bytes |
| POST | `/api/analyze` | `{"document": Document, "conditions": Conditions}` | Analysis |
| GET | `/api/components/defaults/{type}` | | a fresh Component of that type, OpenRocket's defaults |
| GET | `/api/materials` | | `{"bulk": [{name, density}], "surface": […], "line": […]}` |
| GET | `/api/motors/search?q=&diameter=` | | `[{designation, manufacturer, digest, diameter, length, totalImpulse, burnTime, avgThrust}]` |

### Conditions

```jsonc
{ "mach": 0.3, "aoaDeg": 0.0, "rollRate": 0.0, "theta": 0.0, "configId": null }
```

Mach 0.3 / AoA 0 is OpenRocket's design-view default.

### Analysis

```jsonc
{
  "conditions": Conditions,
  "reference": { "length": 0.025, "area": 0.00049 },
  "length": 0.4254,                       // whole configuration, as the figure prints it
  "lengthAerodynamic": 0.4254,            // what the stability % is a percentage of
  "maxDiameter": 0.025,
  "cg":   { "x": 0.2598, "mass": 0.0713 },      // at launch, motors loaded
  "cgEmpty": { "x": 0.2055, "mass": 0.0482 },   // structure only
  "cp":   { "x": 0.3198, "cna": 11.97 },
  "stability": { "calibers": 2.40, "percent": 14.1 },  // (cp-cg)/refLength, /length
  "cd": { "total": 0.634, "friction": 0.43, "pressure": 0.073, "base": 0.132 },
  "components": [
    { "id": "uuid", "name": "Nose cone", "type": "nosecone",
      "x": 0.0, "length": 0.1, "mass": 0.0132, "cgx": 0.076,   // absolute x, from nose tip
      "cpx": 0.0464, "cna": 2.0, "cd": 0.06,       // cd is PER INSTANCE (one fin), as OpenRocket reports it;
      "cdFriction": 0.059, "cdPressure": 0.001, "cdBase": 0 }  // the rocket total already counts every instance
  ],
  "figure": Figure,
  "resolved": { "<componentId>": { "radius": 0.0125 } },  // the number each auto param resolved to
  "motors": [ … ], "inertia": { "launch": RigidBody, "structure": …, "burnout": …, "motor": … },
  "warnings": ["…"]
}
```

### Figure (the side view)

Absolute coordinates, x aft from the nose tip, y up, metres. The UI draws
these and nothing else, so the picture is exactly what the physics used.

```jsonc
{
  "bounds": { "xmin": 0, "xmax": 0.43, "ymin": -0.06, "ymax": 0.06 },
  "shapes": [
    { "id": "uuid", "kind": "body",     "points": [[x,y],…], "closed": true },   // outer profiles
    { "id": "uuid", "kind": "fin",      "points": [[x,y],…], "closed": true },
    { "id": "uuid", "kind": "internal", "points": [[x,y],…], "closed": true },   // inner tubes, rings, mass comps (dashed)
    { "id": "uuid", "kind": "recovery", "points": [[x,y],…], "closed": true },
    { "id": "uuid", "kind": "motor",    "points": [[x,y],…], "closed": true }
  ]
}
```
