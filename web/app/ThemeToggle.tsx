"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

// Also read by the pre-paint script in layout.tsx.
const KEY = "theme";

function current(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function ThemeToggle() {
  // Unknown until mounted: the server cannot see the OS setting or localStorage.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(current());
    // Follow the OS while the user has not picked a side.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (!document.documentElement.dataset.theme) setTheme(current());
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function flip() {
    const next: Theme = current() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {}
    setTheme(next);
  }

  const label = theme === "dark" ? "Switch to day mode" : "Switch to night mode";
  return (
    <button type="button" className="themetoggle" onClick={flip} aria-label={label} title={label}>
      {theme === null ? "" : theme === "dark" ? "☀" : "☾"}
    </button>
  );
}
