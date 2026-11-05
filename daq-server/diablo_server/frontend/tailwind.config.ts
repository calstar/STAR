import type { Config } from 'tailwindcss'

/**
 * The DAQ in the STAR design tools' monochrome -- feed-twin's console, which
 * started as a copy of this app and is now the look both share.
 *
 * Chrome is true black/white/gray (every neutral has R=G=B) and colour is kept
 * for what it means: red past MEOP and for the aborts, amber past NOP, green
 * for open and connected, and each channel's own trace colour on the plots.
 *
 * The gray and blue/sky scales are redefined here rather than rewritten in
 * every view: across this app gray is chrome and blue is "selected", never
 * data, so pointing both at neutrals makes every page monochrome at once and
 * leaves the semantic hues (red, amber, yellow, green, emerald, cyan) alone.
 * feed-twin/frontend/src/index.css carries the same values for Tailwind v4.
 */
const gray = {
  50: '#fafafa',
  100: '#f2f2f2',
  200: '#e0e0e0',
  300: '#c8c8c8',
  400: '#a3a3a3',
  500: '#7a7a7a',
  600: '#575757',
  700: '#383838',
  800: '#232323',
  900: '#121212',
  950: '#080808',
}

/** "Selected". 600 stays dark enough to carry white text. */
const selected = {
  50: '#fafafa',
  100: '#f2f2f2',
  200: '#e6e6e6',
  300: '#dcdcdc',
  400: '#d0d0d0',
  500: '#bdbdbd',
  600: '#4a4a4a',
  700: '#3a3a3a',
  800: '#2c2c2c',
  900: '#1a1a1a',
  950: '#0e0e0e',
}

const config: Config = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    // Square, like the instruments. A dot that wants to be round says
    // rounded-full; nothing else curves.
    borderRadius: {
      none: '0px',
      sm: '0px',
      DEFAULT: '0px',
      md: '0px',
      lg: '0px',
      xl: '0px',
      '2xl': '0px',
      '3xl': '0px',
      full: '9999px',
    },
    extend: {
      colors: {
        // Sensor system palette -- these colour *traces*, kept.
        gn2: '#27AE60',
        fuel: '#3498DB',
        lox: '#E74C3C',
        'gse-low': '#F39C12',
        'gse-mid': '#9B59B6',
        background: '#000000',
        card: '#0b0b0b',
        text: '#ededed',
        'text-muted': '#7a7a7a',

        gray,
        slate: gray,
        zinc: gray,
        neutral: gray,
        blue: selected,
        sky: selected,
        indigo: selected,

        line: '#1f1f1f',
        'line-strong': '#333333',
        ink: {
          DEFAULT: '#ededed',
          2: '#bdbdbd',
          3: '#7a7a7a',
          4: '#4d4d4d',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['"SF Mono"', '"JetBrains Mono"', 'ui-monospace', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        // Nothing floats or glows; the eye goes to the numbers.
        sm: 'none',
        DEFAULT: 'none',
        md: 'none',
        lg: 'none',
        xl: 'none',
        '2xl': 'none',
        inner: 'none',
      },
    },
  },
  plugins: [],
  darkMode: 'class',
}
export default config
