/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#003087',
          dark:    '#001f5b',
          light:   '#0057e7',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Helvetica Neue', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
