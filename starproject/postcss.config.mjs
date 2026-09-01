// Tailwind v4 is wired through PostCSS (matches the repo's other frontends,
// which use Tailwind v4 via @tailwindcss/vite — here it's the Next/PostCSS path).
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
