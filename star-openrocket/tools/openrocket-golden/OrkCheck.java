import info.openrocket.core.aerodynamics.BarrowmanCalculator;
import info.openrocket.core.aerodynamics.FlightConditions;
import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.core.file.motor.GeneralMotorLoader;
import info.openrocket.core.motor.ThrustCurveMotor;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.masscalc.MassCalculator;
import info.openrocket.core.masscalc.RigidBody;
import info.openrocket.core.rocketcomponent.FinSet;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.DeploymentConfiguration;
import info.openrocket.core.rocketcomponent.Parachute;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.simulation.SimulationOptions;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.startup.OpenRocketCore;
import info.openrocket.core.util.Coordinate;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;

/**
 * Load an .ork in OpenRocket itself and print, as one JSON line, what its design
 * view shows: CP and CNa at the given Mach (default 0.3, AoA 0), the CG and mass
 * of the structure and of the rocket at launch, and the structure's pitch inertia. Used by
 * tests/test_ork_openrocket.py to check the .ork export against the program
 * rather than against our port of it.
 *
 *   javac -cp OpenRocket-24.12.jar OrkCheck.java
 *   java -Djava.awt.headless=true -cp OpenRocket-24.12.jar:. OrkCheck rocket.ork [mach]
 *
 * Then one JSON line per parachute ("parachute") and per simulation's launch
 * conditions ("conditions"; wind sampled at the MSL altitudes given after the
 * Mach, as east/north components of where the air goes).
 *
 * Given a .eng or .rse instead, prints the digest OpenRocket's own motor loader
 * computes for each motor in it, one JSON line each.
 */
public class OrkCheck {
    public static void main(String[] args) throws Exception {
        if (args[0].endsWith(".eng") || args[0].endsWith(".rse")) {
            try (InputStream in = new FileInputStream(args[0])) {
                for (ThrustCurveMotor.Builder b : new GeneralMotorLoader().load(in, new File(args[0]).getName())) {
                    ThrustCurveMotor m = b.build();
                    System.out.printf("{\"designation\": \"%s\", \"digest\": \"%s\"}%n",
                        m.getDesignation(), m.getDigest());
                }
            }
            System.exit(0);
        }
        OpenRocketCore.initialize();
        GeneralRocketLoader loader = new GeneralRocketLoader(new File(args[0]));
        OpenRocketDocument doc = loader.load();
        double mach = args.length > 1 ? Double.parseDouble(args[1]) : 0.3;

        FlightConfiguration cfg = doc.getRocket().getSelectedConfiguration();
        FlightConditions fc = new FlightConditions(cfg);
        fc.setMach(mach);
        fc.setAOA(0);
        fc.setTheta(0);
        fc.setRollRate(0);
        Coordinate cp = new BarrowmanCalculator().getCP(cfg, fc, new WarningSet());
        RigidBody launch = MassCalculator.calculateLaunch(cfg);
        RigidBody structure = MassCalculator.calculateStructure(cfg);

        int finPoints = 0;
        double finArea = 0;
        for (RocketComponent c : doc.getRocket()) {
            if (c instanceof FinSet) {
                finPoints = ((FinSet) c).getFinPoints().length;
                finArea = ((FinSet) c).getPlanformArea();
            }
        }
        System.out.printf(
            "{\"cp\": %.12g, \"cna\": %.12g, \"refLength\": %.12g, \"cgLaunch\": %.12g, "
                + "\"massLaunch\": %.12g, \"cgStructure\": %.12g, \"massStructure\": %.12g, \"inertiaStructure\": %.12g, \"spinInertiaStructure\": %.12g, "
                + "\"hasMotor\": %b, \"finPoints\": %d, \"finArea\": %.12g, \"loadWarnings\": %d}%n",
            cp.x, cp.weight, fc.getRefLength(), launch.getCM().x, launch.getMass(),
            structure.getCM().x, structure.getMass(), structure.getLongitudinalInertia(), structure.getRotationalInertia(), cfg.hasMotors(), finPoints, finArea,
            loader.getWarnings().size());

        for (RocketComponent c : doc.getRocket()) {
            if (c instanceof Parachute) {
                Parachute p = (Parachute) c;
                DeploymentConfiguration d = p.getDeploymentConfigurations().getDefault();
                System.out.printf("{\"parachute\": \"%s\", \"cd\": %.12g, \"diameter\": %.12g, "
                        + "\"event\": \"%s\", \"altitude\": %.12g, \"delay\": %.12g}%n",
                    p.getName(), p.getCD(), p.getDiameter(), d.getDeployEvent().name(),
                    d.getDeployAltitude(), d.getDeployDelay());
            }
        }
        for (Simulation sim : doc.getSimulations()) {
            SimulationOptions o = sim.getOptions();
            StringBuilder samples = new StringBuilder();
            for (int i = 2; i < args.length; i++) {
                double z = Double.parseDouble(args[i]);
                Coordinate w = o.getWindModelType().toStringValue().equals("MultiLevel")
                    ? o.getMultiLevelWindModel().getWindVelocity(0, z, z - o.getLaunchAltitude())
                    : o.getAverageWindModel().getWindVelocity(0, z);
                samples.append(String.format("%s[%.12g, %.12g, %.12g]", samples.length() > 0 ? ", " : "", z, w.x, w.y));
            }
            System.out.printf("{\"conditions\": \"%s\", \"rodLength\": %.12g, \"rodAngleDeg\": %.12g, "
                    + "\"rodDirectionDeg\": %.12g, \"windModel\": \"%s\", \"windLevels\": %d, "
                    + "\"averageSpeed\": %.12g, \"averageDirection\": %.12g, \"isa\": %b, "
                    + "\"temperature\": %.12g, \"pressure\": %.12g, \"launchAltitude\": %.12g, "
                    + "\"latitude\": %.12g, \"wind\": [%s]}%n",
                sim.getName(), o.getLaunchRodLength(), Math.toDegrees(o.getLaunchRodAngle()),
                Math.toDegrees(o.getLaunchRodDirection()), o.getWindModelType().toStringValue(),
                o.getMultiLevelWindModel().getLevels().size(), o.getAverageWindModel().getAverage(),
                o.getAverageWindModel().getDirection(), o.isISAAtmosphere(), o.getLaunchTemperature(),
                o.getLaunchPressure(), o.getLaunchAltitude(), o.getLaunchLatitude(), samples);
        }
        System.exit(0);
    }
}
