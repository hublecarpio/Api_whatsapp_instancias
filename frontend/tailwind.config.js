/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}'
  ],
  theme: {
    extend: {
      colors: {
        dark: {
          bg: '#0A0F1C',
          surface: '#111827',
          card: '#1F2937',
          border: '#374151',
          hover: '#2D3748'
        },
        neon: {
          blue: '#00D4FF',
          'blue-light': '#33DDFF',
          'blue-dark': '#00A3CC',
          glow: 'rgba(0, 212, 255, 0.3)'
        },
        accent: {
          success: '#10B981',
          warning: '#F59E0B',
          error: '#EF4444',
          info: '#3B82F6'
        }
      },
      boxShadow: {
        'neon': '0 0 20px rgba(0, 212, 255, 0.3)',
        'neon-sm': '0 0 10px rgba(0, 212, 255, 0.2)',
        'dark-lg': '0 10px 40px rgba(0, 0, 0, 0.5)',
        'dark-md': '0 4px 20px rgba(0, 0, 0, 0.4)'
      },
      animation: {
        'pulse-neon': 'pulse-neon 2s ease-in-out infinite',
        'slide-in': 'slide-in 0.3s ease-out',
        'slide-out': 'slide-out 0.3s ease-in',
        'fade-in': 'fade-in 0.2s ease-out'
      },
      keyframes: {
        'pulse-neon': {
          '0%, 100%': { boxShadow: '0 0 20px rgba(0, 212, 255, 0.3)' },
          '50%': { boxShadow: '0 0 30px rgba(0, 212, 255, 0.5)' }
        },
        'slide-in': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(0)' }
        },
        'slide-out': {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-100%)' }
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' }
        }
      },
      spacing: {
        'safe-bottom': 'env(safe-area-inset-bottom)',
        'safe-top': 'env(safe-area-inset-top)',
        'topbar': '56px'
      },
      screens: {
        'xs': '375px',
        'sm': '640px',
        'md': '768px',
        'lg': '1024px',
        'xl': '1280px'
      }
    }
  },
  plugins: []
};
