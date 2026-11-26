export interface TerminalThemePalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const CONDUCTOR_TERMINAL_DARK_THEME: TerminalThemePalette = {
  background: "#0f1115",
  foreground: "#e4e4e7",
  cursor: "#818cf8",
  cursorAccent: "#0f1115",
  selectionBackground: "rgba(99, 102, 241, 0.35)",
  selectionInactiveBackground: "rgba(99, 102, 241, 0.18)",
  black: "#27272a",
  red: "#f87171",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#71717a",
  brightRed: "#fca5a5",
  brightGreen: "#6ee7b7",
  brightYellow: "#fcd34d",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};

export const CONDUCTOR_TERMINAL_LIGHT_THEME: TerminalThemePalette = {
  background: "#ffffff",
  foreground: "#18181b",
  cursor: "#4f46e5",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(99, 102, 241, 0.22)",
  selectionInactiveBackground: "rgba(99, 102, 241, 0.12)",
  black: "#18181b",
  red: "#dc2626",
  green: "#059669",
  yellow: "#b45309",
  blue: "#2563eb",
  magenta: "#7c3aed",
  cyan: "#0891b2",
  white: "#e4e4e7",
  brightBlack: "#71717a",
  brightRed: "#ef4444",
  brightGreen: "#10b981",
  brightYellow: "#d97706",
  brightBlue: "#3b82f6",
  brightMagenta: "#8b5cf6",
  brightCyan: "#06b6d4",
  brightWhite: "#fafafa",
};

export function getConductorTerminalTheme(isDark: boolean): TerminalThemePalette {
  return isDark ? CONDUCTOR_TERMINAL_DARK_THEME : CONDUCTOR_TERMINAL_LIGHT_THEME;
}

export function detectDarkColorScheme(): boolean {
  const g = globalThis as unknown as {
    matchMedia?: (query: string) => { matches: boolean };
  };
  if (typeof g.matchMedia !== "function") {
    return true;
  }
  return g.matchMedia("(prefers-color-scheme: dark)").matches;
}
