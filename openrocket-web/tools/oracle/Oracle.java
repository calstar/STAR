import info.openrocket.core.aerodynamics.AerodynamicForces;
import info.openrocket.core.aerodynamics.BarrowmanCalculator;
import info.openrocket.core.aerodynamics.FlightConditions;
import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.masscalc.CMAnalysisEntry;
import info.openrocket.core.masscalc.MassCalculator;
import info.openrocket.core.masscalc.RigidBody;
import info.openrocket.core.motor.MotorConfiguration;
import info.openrocket.core.motor.ThrustCurveMotor;
import info.openrocket.core.rocketcomponent.FinSet;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.MassObject;
import info.openrocket.core.rocketcomponent.RingComponent;
import info.openrocket.core.rocketcomponent.Transition;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.rocketcomponent.SymmetricComponent;
import info.openrocket.core.startup.OpenRocketCore;
import info.openrocket.core.util.Coordinate;

import java.io.File;
import java.util.Locale;
import java.util.Map;

/**
 * The oracle: load an .ork in OpenRocket 24.12 itself and print, as one JSON
 * document, every number the Python port must reproduce for the design view.
 *
 * This is the only Java in openrocket-web, and it runs in tests only: a port can
 * be checked only against the program it ports, never against itself.
 *
 *   javac -cp OpenRocket-24.12.jar Oracle.java
 *   java -Djava.awt.headless=true -cp OpenRocket-24.12.jar:. Oracle rocket.ork
 *
 * Output: {"rocket": {...}, "components": [...], "cm": [...], "aero": [...], "aeroRoll": [...]}
 * Aero is sampled over a Mach x AoA grid at OpenRocket's default flight
 * conditions (FlightConditions' own atmosphere), roll and pitch rates zero.
 * aeroRoll repeats it at AoA 4 deg over roll rates and theta (roll damping and
 * forcing, and the per-fin sin^2(theta - angle) weighting).
 */
public class Oracle {
    static final double[] MACHS = {0.05, 0.3, 0.6, 0.8, 0.95, 1.05, 1.3, 2.0, 3.0};
    static final double[] AOAS_DEG = {0.0, 2.0, 8.0};

    static String q(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }

    static String n(double v) {
        if (Double.isNaN(v) || Double.isInfinite(v)) return "null";
        return String.format(Locale.ROOT, "%.15g", v);
    }

    static String body(RigidBody b) {
        return "{\"mass\": " + n(b.getMass()) + ", \"cgx\": " + n(b.getCM().x)
            + ", \"Ixx\": " + n(b.getIxx()) + ", \"Iyy\": " + n(b.getIyy()) + ", \"Izz\": " + n(b.getIzz()) + "}";
    }

    public static void main(String[] args) throws Exception {
        OpenRocketCore.initialize();
        OpenRocketDocument doc = new GeneralRocketLoader(new File(args[0])).load();
        FlightConfiguration cfg = doc.getRocket().getSelectedConfiguration();
        StringBuilder out = new StringBuilder("{");

        FlightConditions ref = new FlightConditions(cfg);
        out.append("\"rocket\": {\"name\": ").append(q(doc.getRocket().getName()))
            .append(", \"refLength\": ").append(n(ref.getRefLength()))
            .append(", \"refArea\": ").append(n(ref.getRefArea()))
            .append(", \"lengthAero\": ").append(n(cfg.getLengthAerodynamic()))
            .append(", \"launch\": ").append(body(MassCalculator.calculateLaunch(cfg)))
            .append(", \"structure\": ").append(body(MassCalculator.calculateStructure(cfg)))
            .append(", \"burnout\": ").append(body(MassCalculator.calculateBurnout(cfg)))
            .append(", \"motor\": ").append(body(MassCalculator.calculateMotor(cfg)))
            .append(", \"selectedConfig\": ").append(q(String.valueOf(cfg.getId().key)))
            .append(", \"length\": ").append(n(cfg.getLength()))
            .append("}");

        out.append(", \"components\": [");
        boolean first = true;
        for (RocketComponent c : doc.getRocket()) {
            if (!first) out.append(", ");
            first = false;
            out.append("{\"name\": ").append(q(c.getName()))
                .append(", \"id\": ").append(q(String.valueOf(c.getID())))
                .append(", \"type\": ").append(q(c.getClass().getSimpleName()))
                .append(", \"active\": ").append(cfg.isComponentActive(c))
                .append(", \"length\": ").append(n(c.getLength()))
                .append(", \"mass\": ").append(n(c.getComponentMass()))
                .append(", \"cgx\": ").append(n(c.getComponentCG().x))
                .append(", \"cgy\": ").append(n(c.getComponentCG().y))
                .append(", \"cgz\": ").append(n(c.getComponentCG().z))
                .append(", \"longUnitInertia\": ").append(n(c.getLongitudinalUnitInertia()))
                .append(", \"rotUnitInertia\": ").append(n(c.getRotationalUnitInertia()))
                .append(", \"overrideMass\": ").append(c.isMassOverridden() ? n(c.getOverrideMass()) : "null")
                .append(", \"overrideCG\": ").append(c.isCGOverridden() ? n(c.getOverrideCGX()) : "null")
                .append(", \"relX\": ").append(n(c.getPosition().x))
                .append(", \"axialMethod\": ").append(q(c.getAxialMethod().name()))
                .append(", \"axialOffset\": ").append(n(c.getAxialOffset()))
                .append(", \"instanceCount\": ").append(c.getInstanceCount())
                .append(", \"locations\": [");
            Coordinate[] locs = c.getComponentLocations();
            for (int i = 0; i < locs.length; i++) {
                if (i > 0) out.append(", ");
                out.append("[").append(n(locs[i].x)).append(", ").append(n(locs[i].y)).append(", ").append(n(locs[i].z)).append("]");
            }
            out.append("]");
            if (c instanceof SymmetricComponent) {
                SymmetricComponent s = (SymmetricComponent) c;
                out.append(", \"foreRadius\": ").append(n(s.getForeRadius()))
                    .append(", \"aftRadius\": ").append(n(s.getAftRadius()))
                    .append(", \"wetArea\": ").append(n(s.getComponentWetArea()))
                    .append(", \"volume\": ").append(n(s.getComponentVolume()))
                    .append(", \"planformArea\": ").append(n(s.getComponentPlanformArea()))
                    .append(", \"planformCenter\": ").append(n(s.getComponentPlanformCenter()))
                    .append(", \"fullVolume\": ").append(n(s.getFullVolume()))
                    .append(", \"radii\": [");
                for (int i = 0; i <= 20; i++) {
                    if (i > 0) out.append(", ");
                    out.append(n(s.getRadius(s.getLength() * i / 20.0)));
                }
                out.append("]");
                if (c instanceof Transition) {
                    Transition t = (Transition) c;
                    out.append(", \"shape\": ").append(q(t.getShapeType().name()))
                        .append(", \"clipped\": ").append(t.isClipped())
                        .append(", \"shapeParameter\": ").append(n(t.getShapeParameter()));
                }
            }
            if (c instanceof MassObject) {
                out.append(", \"radius\": ").append(n(((MassObject) c).getRadius()));
            }
            if (c instanceof RingComponent) {
                RingComponent r = (RingComponent) c;
                out.append(", \"outerRadius\": ").append(n(r.getOuterRadius()))
                    .append(", \"innerRadius\": ").append(n(r.getInnerRadius()));
            }
            if (c instanceof FinSet) {
                FinSet f = (FinSet) c;
                out.append(", \"finArea\": ").append(n(f.getPlanformArea()))
                    .append(", \"span\": ").append(n(f.getSpan()))
                    .append(", \"finPoints\": [");
                Coordinate[] pts = f.getFinPoints();
                for (int i = 0; i < pts.length; i++) {
                    if (i > 0) out.append(", ");
                    out.append("[").append(n(pts[i].x)).append(", ").append(n(pts[i].y)).append("]");
                }
                out.append("], \"rootPoints\": [");
                Coordinate[] rp = f.getRootPoints();
                for (int i = 0; i < rp.length; i++) {
                    if (i > 0) out.append(", ");
                    out.append("[").append(n(rp[i].x)).append(", ").append(n(rp[i].y)).append("]");
                }
                out.append("]");
            }
            out.append("}");
        }
        out.append("]");

        out.append(", \"motors\": [");
        first = true;
        for (MotorConfiguration mc : cfg.getActiveMotors()) {
            if (!(mc.getMotor() instanceof ThrustCurveMotor)) continue;
            ThrustCurveMotor m = (ThrustCurveMotor) mc.getMotor();
            if (!first) out.append(", ");
            first = false;
            out.append("{\"mount\": ").append(q(String.valueOf(((RocketComponent) mc.getMount()).getID())))
                .append(", \"designation\": ").append(q(m.getDesignation()))
                .append(", \"manufacturer\": ").append(q(m.getManufacturer().getSimpleName()))
                .append(", \"digest\": ").append(q(m.getDigest()))
                .append(", \"diameter\": ").append(n(m.getDiameter()))
                .append(", \"length\": ").append(n(m.getLength()))
                .append(", \"x\": ").append(n(mc.getX()))
                .append(", \"motorCount\": ").append(mc.getMotorCount())
                .append(", \"ejectionDelay\": ").append(n(mc.getEjectionDelay()))
                .append(", \"ignitionDelay\": ").append(n(mc.getIgnitionDelay()))
                .append(", \"ignitionEvent\": ").append(q(mc.getIgnitionEvent().name()))
                .append(", \"motorType\": ").append(q(m.getMotorType().name()))
                .append(", \"commonName\": ").append(q(m.getCommonName()))
                .append(", \"delays\": [");
            double[] dl = m.getStandardDelays();
            for (int i = 0; i < dl.length; i++) {
                if (i > 0) out.append(", ");
                out.append(n(dl[i]));
            }
            out.append("]")
                .append(", \"time\": [");
            double[] t = m.getTimePoints();
            double[] th = m.getThrustPoints();
            Coordinate[] cg = m.getCGPoints();
            StringBuilder ts = new StringBuilder(), ths = new StringBuilder(), cgs = new StringBuilder(), ms = new StringBuilder();
            for (int i = 0; i < t.length; i++) {
                String sep = i > 0 ? ", " : "";
                ts.append(sep).append(n(t[i]));
                ths.append(sep).append(n(th[i]));
                cgs.append(sep).append(n(cg[i].x));
                ms.append(sep).append(n(cg[i].weight));
            }
            out.append(ts).append("], \"thrust\": [").append(ths).append("], \"cgx\": [").append(cgs)
                .append("], \"mass\": [").append(ms).append("]}");
        }
        out.append("]");

        out.append(", \"cm\": [");
        first = true;
        for (Map.Entry<Integer, CMAnalysisEntry> e : MassCalculator.getCMAnalysis(cfg).entrySet()) {
            CMAnalysisEntry a = e.getValue();
            if (!first) out.append(", ");
            first = false;
            String id = a.source instanceof RocketComponent ? String.valueOf(((RocketComponent) a.source).getID()) : null;
            out.append("{\"name\": ").append(q(a.name)).append(", \"id\": ").append(q(id))
                .append(", \"eachMass\": ").append(n(a.eachMass))
                .append(", \"cgx\": ").append(n(a.totalCM.x))
                .append(", \"totalMass\": ").append(n(a.totalCM.weight)).append("}");
        }
        out.append("]");

        out.append(", \"aero\": [");
        first = true;
        BarrowmanCalculator calc = new BarrowmanCalculator();
        for (double mach : MACHS) {
            for (double aoaDeg : AOAS_DEG) {
                if (!first) out.append(", ");
                first = false;
                aeroPoint(out, calc, cfg, mach, aoaDeg, 0, 0, false);
            }
        }
        out.append("]");

        // Roll and theta: roll forcing/damping (cant), per-fin sin^2(theta - angle).
        out.append(", \"aeroRoll\": [");
        first = true;
        for (double mach : ROLL_MACHS) {
            for (double roll : ROLL_RATES) {
                for (double theta : THETAS) {
                    if (!first) out.append(", ");
                    first = false;
                    aeroPoint(out, calc, cfg, mach, ROLL_AOA_DEG, roll, theta, true);
                }
            }
        }
        out.append("]}");
        System.out.println(out);
        System.exit(0);
    }

    static final double[] ROLL_MACHS = {0.3, 1.2, 2.0};
    static final double[] ROLL_RATES = {0.0, 0.05, 6.0, 300.0};
    static final double[] THETAS = {0.0, 0.4};
    static final double ROLL_AOA_DEG = 4.0;

    static void aeroPoint(StringBuilder out, BarrowmanCalculator calc, FlightConfiguration cfg,
                          double mach, double aoaDeg, double rollRate, double theta, boolean withRoll) {
                FlightConditions fc = new FlightConditions(cfg);
                fc.setMach(mach);
                fc.setAOA(Math.toRadians(aoaDeg));
                fc.setTheta(theta);
                fc.setRollRate(rollRate);
                WarningSet w = new WarningSet();
                Map<RocketComponent, AerodynamicForces> fa = calc.getForceAnalysis(cfg, fc, w);
                out.append("{\"mach\": ").append(n(mach)).append(", \"aoaDeg\": ").append(n(aoaDeg));
                if (withRoll) {
                    out.append(", \"rollRate\": ").append(n(rollRate)).append(", \"theta\": ").append(n(theta));
                }
                out.append(", \"velocity\": ").append(n(fc.getVelocity()))
                    .append(", \"warnings\": ").append(w.size())
                    .append(", \"forces\": [");
                boolean f1 = true;
                for (Map.Entry<RocketComponent, AerodynamicForces> e : fa.entrySet()) {
                    AerodynamicForces f = e.getValue();
                    if (!f1) out.append(", ");
                    f1 = false;
                    out.append("{\"id\": ").append(q(String.valueOf(e.getKey().getID())))
                        .append(", \"name\": ").append(q(e.getKey().getName()))
                        .append(", \"cpx\": ").append(n(f.getCP().x))
                        .append(", \"cna\": ").append(n(f.getCP().weight))
                        .append(", \"CN\": ").append(n(f.getCN()))
                        .append(", \"Cm\": ").append(n(f.getCm()))
                        .append(", \"CD\": ").append(n(f.getCD()))
                        .append(", \"CDaxial\": ").append(n(f.getCDaxial()))
                        .append(", \"frictionCD\": ").append(n(f.getFrictionCD()))
                        .append(", \"pressureCD\": ").append(n(f.getPressureCD()))
                        .append(", \"baseCD\": ").append(n(f.getBaseCD()))
                        .append(", \"overrideCD\": ").append(n(f.getOverrideCD()))
                        .append(", \"Croll\": ").append(n(f.getCroll()))
                        .append(", \"CrollDamp\": ").append(n(f.getCrollDamp()))
                        .append(", \"CrollForce\": ").append(n(f.getCrollForce()))
                        .append("}");
                }
                out.append("]}");
    }
}
