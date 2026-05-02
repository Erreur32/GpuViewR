/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: ["class", '[data-mode="dark"]'],
  theme: {
    extend: {
      colors: {
        // Bridge to CSS variables: useful for utility classes mixing with theme
        brand: {
          50: '#eef6ff', 100: '#d9eaff', 200: '#bcdaff', 300: '#8ec1ff',
          400: '#599dff', 500: '#2f7bff', 600: '#1a5fef', 700: '#1549c9',
          800: '#163ea0', 900: '#16387f',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
