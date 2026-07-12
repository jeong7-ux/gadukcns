import type { ReactNode } from "react";

type Tone = "primary" | "accent" | "success" | "danger" | "muted";

const TONE: Record<Tone, string> = {
  primary: "bg-primary/10 text-primary ring-1 ring-primary/20",
  accent: "bg-accent/10 text-accent ring-1 ring-accent/20",
  success: "bg-success/10 text-success ring-1 ring-success/30",
  danger: "bg-danger/10 text-danger ring-1 ring-danger/30",
  muted: "bg-muted/10 text-muted ring-1 ring-muted/30",
};

export function Pill({
  tone = "muted",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}
