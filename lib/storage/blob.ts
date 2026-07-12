// Supabase Storage 헬퍼 (서버 전용 — API 라우트에서만 import).
//   서버리스(Netlify/Vercel) 호환: 로컬 디스크 대신 Supabase Storage 버킷에 저장/서빙.
//   storage_path 규칙: "<bucket>/<key...>". 배치(attachments.mjs)는 버킷 프리픽스 없이
//   key 만 저장하므로, 알려진 버킷 프리픽스가 없으면 'attachments' 버킷으로 간주한다.
import { createClient } from "@supabase/supabase-js";

const KNOWN_BUCKETS = ["analysis-reports", "attachments"] as const;

function storage() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!).storage;
}

/** storage_path → { bucket, key } */
export function splitPath(rel: string): { bucket: string; key: string } {
  const first = rel.split("/")[0];
  if ((KNOWN_BUCKETS as readonly string[]).includes(first)) {
    return { bucket: first, key: rel.slice(first.length + 1) };
  }
  return { bucket: "attachments", key: rel }; // 배치 저장 규칙(프리픽스 없음)
}

async function ensureBucket(bucket: string) {
  const s = storage();
  const { data } = await s.getBucket(bucket);
  if (!data) await s.createBucket(bucket, { public: false });
}

/** 버킷 프리픽스 포함 storage_path 로 업로드(upsert). */
export async function uploadBlob(rel: string, buf: Buffer, contentType: string) {
  const { bucket, key } = splitPath(rel);
  await ensureBucket(bucket);
  const { error } = await storage().from(bucket).upload(key, buf, { contentType, upsert: true });
  if (error) throw new Error(error.message);
}

export async function downloadBlob(rel: string): Promise<Buffer> {
  const { bucket, key } = splitPath(rel);
  const { data, error } = await storage().from(bucket).download(key);
  if (error || !data) throw new Error(error?.message ?? "파일 없음");
  return Buffer.from(await data.arrayBuffer());
}

/** Storage 객체 키 안전화(ASCII 전용 — 한글 등 비ASCII는 제거, 확장자 보존). 표시명은 DB(file_name)로 유지. */
export function asciiKey(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).replace(/[^.\w]/g, "") : "";
  let base = (dot > 0 ? name.slice(0, dot) : name)
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\\/:*?"<>|\s]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (!base) base = "file";
  return (base + ext).slice(0, 120);
}
