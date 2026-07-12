import type { Config } from "tailwindcss";

/**
 * 디자인 토큰 중앙화 (UI/UX 스토리보드 2장).
 * 색상은 CSS 변수(globals.css :root)에서 주입 → 한 곳만 고치면 전 화면 반영.
 * 하드코딩 HEX 금지: 컴포넌트는 반드시 이 토큰 클래스를 사용한다.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "var(--color-primary)", // #1F497D
        accent: "var(--color-accent)", // #2563EB
        success: "var(--color-success)", // #16A34A
        danger: "var(--color-danger)", // #DC2626
        muted: "var(--color-muted)", // #64748B
        bg: "var(--color-bg)", // #F8FAFC
        surface: "var(--color-surface)", // #FFFFFF
        text: "var(--color-text)", // #0F172A
        subtle: "var(--color-text-subtle)", // #64748B
        border: "var(--color-border)",
        priority: "var(--color-priority-bg)", // 우선 고객사 공고 배경(FR-18)
        // D-day 3구간(마감 임박도) — 스토리보드 2.2
        dday: {
          urgent: "var(--color-dday-urgent)", // D0~3 #DC2626
          soon: "var(--color-dday-soon)", // D4~6 #EA580C
          near: "var(--color-dday-near)", // D7~9 #EAB308
          far: "var(--color-dday-far)", // D10+ #64748B
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
      },
      borderRadius: {
        card: "0.75rem",
      },
      boxShadow: {
        card: "0 1px 2px rgba(15,23,42,0.06), 0 1px 3px rgba(15,23,42,0.08)",
      },
    },
  },
  plugins: [],
};

export default config;
