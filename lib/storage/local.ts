// 로컬 파일 저장 헬퍼 (서버 전용 — API 라우트에서만 import). 프로젝트 storage/ 하위에 저장.
import path from "path";
import fs from "fs/promises";

// 저장 루트: 기본은 프로젝트 storage/. 호스팅(Render/Railway 등)에서는 영구 디스크
// 마운트 경로를 STORAGE_DIR 로 지정한다(예: /var/data). 절대경로/상대경로 모두 허용.
export const STORAGE_ROOT = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(process.cwd(), "storage");

/** 경로 조작(traversal) 방지 + storage 루트로 안전 결합 */
export function safeResolve(rel: string): string {
  const full = path.resolve(STORAGE_ROOT, rel);
  if (full !== STORAGE_ROOT && !full.startsWith(STORAGE_ROOT + path.sep)) {
    throw new Error("잘못된 경로");
  }
  return full;
}

export async function saveLocal(rel: string, data: Buffer): Promise<string> {
  const full = safeResolve(rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
  return rel;
}

export async function readLocal(rel: string): Promise<Buffer> {
  return fs.readFile(safeResolve(rel));
}

/** 파일명 안전화(경로 구분자·특수문자 제거). 한글은 유지. */
export function safeName(s: string): string {
  return s.replace(/[\/\\?%*:|"<>]/g, "_").replace(/\s+/g, "_").slice(0, 120);
}

export function contentType(rel: string): string {
  const l = rel.toLowerCase();
  if (l.endsWith(".html") || l.endsWith(".htm")) return "text/html; charset=utf-8";
  if (l.endsWith(".pdf")) return "application/pdf";
  if (l.endsWith(".hwp")) return "application/x-hwp";
  if (l.endsWith(".hwpx")) return "application/haansofthwpx";
  return "application/octet-stream";
}
