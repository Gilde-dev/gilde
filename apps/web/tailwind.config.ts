import type { Config } from 'tailwindcss';

// Tokens are space-separated sRGB channels in globals.css, so opacity modifiers (bg-foreground/50) keep working.
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;
const semantic = (name: string) => ({
  DEFAULT: token(name),
  foreground: token(`${name}-foreground`),
  soft: token(`${name}-soft`),
  solid: token(`${name}-solid`),
});
const px = (size: number, line: number, weight?: string) =>
  [`${size}px`, { lineHeight: `${line}px`, ...(weight ? { fontWeight: weight } : {}) }] as [string, { lineHeight: string; fontWeight?: string }];

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: token('background'),
        foreground: token('foreground'),
        surface: token('surface'),
        sidebar: token('sidebar'),
        lane: token('lane'),
        card: { DEFAULT: token('card'), foreground: token('foreground') },
        popover: { DEFAULT: token('popover'), foreground: token('foreground') },
        muted: { DEFAULT: token('muted'), foreground: token('muted-foreground') },
        border: { DEFAULT: token('border'), subtle: token('border-subtle') },
        input: token('input'),
        ring: token('ring'),
        primary: { DEFAULT: token('primary'), foreground: token('primary-foreground') },
        accent: { DEFAULT: token('accent'), foreground: token('accent-foreground'), soft: token('accent-soft') },
        success: semantic('success'),
        warning: semantic('warning'),
        danger: semantic('danger'),
        info: semantic('info'),
        running: semantic('running'),
        pr: semantic('pr'),
      },
      backgroundImage: { 'primary-gradient': 'var(--primary-gradient)' },
      boxShadow: { sm: 'var(--shadow-sm)', DEFAULT: 'var(--shadow-sm)', md: 'var(--shadow-md)', lg: 'var(--shadow-md)' },
      // Actual pixels: the root font size is 16px (globals.css), so the default spacing scale is 4px.
      fontSize: {
        'display-xl': px(40, 52, '600'),
        'display-lg': px(32, 44, '600'),
        'display-md': px(28, 36, '600'),
        'display-sm': px(24, 32, '600'),
        lg: px(17, 24),
        md: px(15, 20),
        base: px(15, 20),
        sm: px(13, 18),
        label: px(12, 16, '500'),
        xs: px(12, 16),
        xl: px(20, 28),
        '2xl': px(24, 32),
        '3xl': px(32, 44),
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        // Compatibility alias: headings are Figtree now; remove when no `font-serif` is left.
        serif: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      borderRadius: { sm: '6px', md: '10px', lg: '12px', xl: '16px' },
    },
  },
  plugins: [],
};

export default config;
