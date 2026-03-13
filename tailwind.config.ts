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
      colors: {
        background: "#05070d",
        panel: "#0c1322",
        panelAlt: "#111a2c",
        border: "#1f2a44",
        text: "#e9f1ff",
        muted: "#8aa0c8",
        accent: "#33d1ff",
        success: "#22c55e",
        warning: "#f59e0b",
        danger: "#ef4444"
      },
      boxShadow: {
        panel: "0 12px 40px rgba(0, 0, 0, 0.35)"
      },
      backgroundImage: {
        "hostpanel-grid": "radial-gradient(circle at top left, rgba(51, 209, 255, 0.07), transparent 55%), radial-gradient(circle at 20% 20%, rgba(16, 185, 129, 0.06), transparent 40%)"
      }
    }
  },
  plugins: []
};

export default config;
