"use client";

// 다크/화이트 테마 토글. <html data-theme>를 전환하고 localStorage에 저장.
import { useEffect, useState } from "react";

type Theme = "light" | "dark";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    // 초기 테마: FOUC 스크립트가 세팅한 data-theme를 읽어 상태 동기화
    const current = (document.documentElement.getAttribute("data-theme") as Theme) || "light";
    setTheme(current);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* ignore */
    }
    setTheme(next);
  }

  return (
    <button
      onClick={toggle}
      aria-label={theme === "dark" ? "화이트 모드로 전환" : "다크 모드로 전환"}
      title={theme === "dark" ? "화이트 모드" : "다크 모드"}
      className="rounded-md px-2 py-1 text-sm text-subtle ring-1 ring-border hover:bg-bg"
    >
      {theme === "dark" ? "☀" : "🌙"}
    </button>
  );
}
