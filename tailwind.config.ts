import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "./server/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"]
      },
      colors: {
        surface: {
          hull: "rgb(var(--surface-hull) / <alpha-value>)",
          deck: "rgb(var(--surface-deck) / <alpha-value>)",
          raised: "rgb(var(--surface-raised) / <alpha-value>)",
          overlay: "rgb(var(--surface-overlay) / <alpha-value>)"
        },
        border: {
          DEFAULT: "rgb(var(--border-default) / <alpha-value>)",
          strong: "rgb(var(--border-strong) / <alpha-value>)"
        },
        text: {
          DEFAULT: "rgb(var(--text-primary) / <alpha-value>)",
          muted: "rgb(var(--text-muted) / <alpha-value>)",
          subtle: "rgb(var(--text-subtle) / <alpha-value>)",
          inverse: "rgb(var(--text-inverse) / <alpha-value>)"
        },
        brand: {
          DEFAULT: "rgb(var(--brand-accent) / <alpha-value>)",
          hover: "rgb(var(--brand-hover) / <alpha-value>)",
          contrast: "rgb(var(--brand-contrast) / <alpha-value>)"
        },
        success: {
          DEFAULT: "rgb(var(--state-success) / <alpha-value>)",
          foreground: "rgb(var(--state-success-foreground) / <alpha-value>)"
        },
        warning: {
          DEFAULT: "rgb(var(--state-warning) / <alpha-value>)",
          foreground: "rgb(var(--state-warning-foreground) / <alpha-value>)"
        },
        critical: {
          DEFAULT: "rgb(var(--state-critical) / <alpha-value>)",
          foreground: "rgb(var(--state-critical-foreground) / <alpha-value>)"
        },
        info: {
          DEFAULT: "rgb(var(--state-info) / <alpha-value>)",
          foreground: "rgb(var(--state-info-foreground) / <alpha-value>)"
        },
        focus: "rgb(var(--focus-ring) / <alpha-value>)",
        selected: {
          DEFAULT: "rgb(var(--selected-surface) / <alpha-value>)",
          border: "rgb(var(--selected-border) / <alpha-value>)"
        },
        background: "rgb(var(--surface-hull) / <alpha-value>)",
        panel: "rgb(var(--surface-deck) / <alpha-value>)",
        panelAlt: "rgb(var(--surface-raised) / <alpha-value>)",
        muted: "rgb(var(--text-muted) / <alpha-value>)",
        accent: "rgb(var(--brand-accent) / <alpha-value>)",
        danger: "rgb(var(--state-critical) / <alpha-value>)"
      },
      spacing: {
        "control-sm": "var(--control-sm)",
        control: "var(--control-md)",
        "control-lg": "var(--control-lg)",
        gutter: "var(--space-gutter)",
        section: "var(--space-section)"
      },
      borderRadius: {
        control: "var(--radius-control)",
        panel: "var(--radius-panel)",
        overlay: "var(--radius-overlay)"
      },
      boxShadow: {
        panel: "var(--shadow-panel)",
        overlay: "var(--shadow-overlay)"
      },
      backgroundImage: {
        "brand-atmosphere": "var(--background-atmosphere)"
      }
    }
  },
  plugins: []
};

export default config;
