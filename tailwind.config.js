/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/**/*.html'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', 'monospace'],
        sans: ['"Onest"', '"Space Grotesk"', 'sans-serif'],
        display: ['"Major Mono Display"', '"JetBrains Mono"', 'monospace'],
        tech: ['"Share Tech Mono"', '"JetBrains Mono"', 'monospace'],
      },
      colors: {
        dark: '#030303',
        light: '#f5f5f5',
        accent: '#ffffff',
        grayish: '#888888',
        surface: '#111111',
      },
    },
  },
  plugins: [],
};
