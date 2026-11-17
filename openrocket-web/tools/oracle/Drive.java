import java.awt.*; import java.awt.event.*; import java.io.File; import javax.imageio.ImageIO;
public class Drive {
  public static void main(String[] a) throws Exception {
    Robot r = new Robot(); r.setAutoDelay(60);
    for (String cmd : a) {
      String[] p = cmd.split(":");
      switch (p[0]) {
        case "click": r.mouseMove(Integer.parseInt(p[1]), Integer.parseInt(p[2])); r.mousePress(InputEvent.BUTTON1_DOWN_MASK); r.mouseRelease(InputEvent.BUTTON1_DOWN_MASK); break;
        case "dbl": r.mouseMove(Integer.parseInt(p[1]), Integer.parseInt(p[2])); for (int i=0;i<2;i++){r.mousePress(InputEvent.BUTTON1_DOWN_MASK); r.mouseRelease(InputEvent.BUTTON1_DOWN_MASK);} break;
        case "esc": r.keyPress(KeyEvent.VK_ESCAPE); r.keyRelease(KeyEvent.VK_ESCAPE); break;
        case "sleep": Thread.sleep(Long.parseLong(p[1])); break;
        case "shot": ImageIO.write(r.createScreenCapture(new Rectangle(Toolkit.getDefaultToolkit().getScreenSize())), "png", new File(p[1])); break;
      }
    }
    System.exit(0);
  }
}
