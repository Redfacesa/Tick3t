/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: '#FF4B4B',
        ink: '#0a0a0a',
        mist: '#f4f4f5',
      },
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
        display: ['"Syne"', '"DM Sans"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
