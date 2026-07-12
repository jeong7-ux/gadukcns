import type { ReactNode } from "react";

export function PageHeader({
  title,
  screen,
  desc,
  action,
}: {
  title: string;
  screen?: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-text">{title}</h1>
          {screen && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              {screen}
            </span>
          )}
        </div>
        {desc && <p className="mt-1 text-xs text-subtle">{desc}</p>}
      </div>
      {action}
    </div>
  );
}
