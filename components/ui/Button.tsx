import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "accent" | "ghost" | "danger";

const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-white hover:bg-primary/90",
  accent: "bg-accent text-white hover:bg-accent/90",
  danger: "bg-danger text-white hover:bg-danger/90",
  ghost: "bg-transparent text-text ring-1 ring-border hover:bg-bg",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${className}`}
      {...props}
    />
  );
}
