/**
 * 경량 Markdown 렌더러 (외부 의존성 없이 ai_summary 표시용).
 * 지원: #~### 제목, - / * 목록, **굵게**, 빈 줄 문단. 그 외는 평문.
 * 신뢰 소스(자체 AI 파이프라인)만 렌더 — 임의 HTML은 주입하지 않는다.
 */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];

  const flushList = (key: number) => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`ul-${key}`} className="my-1 list-disc space-y-0.5 pl-5">
        {list.map((li, i) => (
          <li key={i}>{inline(li)}</li>
        ))}
      </ul>
    );
    list = [];
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (/^\s*[-*]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s+/, ""));
      return;
    }
    flushList(i);
    if (/^###\s+/.test(line)) {
      blocks.push(
        <h4 key={i} className="mt-2 text-sm font-bold text-text">
          {inline(line.replace(/^###\s+/, ""))}
        </h4>
      );
    } else if (/^##\s+/.test(line)) {
      blocks.push(
        <h3 key={i} className="mt-2 text-sm font-bold text-text">
          {inline(line.replace(/^##\s+/, ""))}
        </h3>
      );
    } else if (/^#\s+/.test(line)) {
      blocks.push(
        <h2 key={i} className="mt-2 text-base font-bold text-text">
          {inline(line.replace(/^#\s+/, ""))}
        </h2>
      );
    } else if (line.trim() === "") {
      // 문단 구분
    } else {
      blocks.push(
        <p key={i} className="text-sm leading-relaxed text-text">
          {inline(line)}
        </p>
      );
    }
  });
  flushList(lines.length);

  return <div className="space-y-1">{blocks}</div>;
}

/** **굵게** 인라인 처리 */
function inline(s: string): React.ReactNode {
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    /^\*\*[^*]+\*\*$/.test(p) ? (
      <strong key={i} className="font-semibold">
        {p.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{p}</span>
    )
  );
}
