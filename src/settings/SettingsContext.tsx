import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "dark" | "light";

export interface Settings {
  theme: Theme;
  fontSize: number;
}

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 28;
export const DEFAULT_SETTINGS: Settings = { theme: "dark", fontSize: 14 };

const STORAGE_KEY = "onno:settings";

function clampFontSize(n: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

/** Merge whatever was stored over the defaults, discarding invalid values. */
function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Settings>;
    return {
      theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : DEFAULT_SETTINGS.theme,
      fontSize: typeof raw.fontSize === "number" ? clampFontSize(raw.fontSize) : DEFAULT_SETTINGS.fontSize,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

interface SettingsContextValue {
  settings: Settings;
  update(patch: Partial<Settings>): void;
  reset(): void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // storage full or blocked; settings still apply for this session
    }
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.style.setProperty("--font-size", `${settings.fontSize}px`);
  }, [settings]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      next.fontSize = clampFontSize(next.fontSize);
      return next;
    });
  }, []);

  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  const value = useMemo(() => ({ settings, update, reset }), [settings, update, reset]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside <SettingsProvider>");
  return ctx;
}
