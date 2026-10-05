/**
 * Layer X's type and tokens, bundled with the app: nothing is fetched from a font CDN. Import this
 * once, from the Layer X root (or the dev gallery); lx/ui components do not import it themselves,
 * so their unit tests run without a CSS pipeline.
 */
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './theme.css';
