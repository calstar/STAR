public class Launch {
    public static void main(String[] a) throws Exception {
        info.openrocket.core.startup.Application.SUPPORTED_JRE_VERSIONS = new int[]{17, 21};
        info.openrocket.swing.startup.SwingStartup.main(a);
    }
}
