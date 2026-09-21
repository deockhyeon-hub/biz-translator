// 상태 저장소: 채팅방/기록과 설정을 이 기기의 localStorage에 보관한다.
// API 키는 설정 쪽에만 두어 백업 파일에 섞이지 않게 한다.

const STATE_KEY = "biztr.state.v1";
const SETTINGS_KEY = "biztr.settings.v1";

const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // 용량 초과 또는 저장소 차단
  }
}

export function newRoom({ name, lang = "EN", tone = "neutral", context = "", glossary = "" } = {}) {
  return { id: uid(), name: name || "새 채팅방", lang, tone, context, glossary, messages: [], createdAt: Date.now() };
}

export function newMessage(source, direction) {
  return { id: uid(), source, direction, translation: "", note: "", status: "pending", error: "", ts: Date.now() };
}

function normalizeRooms(rooms) {
  if (!Array.isArray(rooms)) return [];
  return rooms
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      ...newRoom(r),
      id: typeof r.id === "string" ? r.id : uid(),
      createdAt: Number(r.createdAt) || Date.now(),
      messages: (Array.isArray(r.messages) ? r.messages : [])
        .filter((m) => m && typeof m.source === "string")
        .map((m) => ({
          id: typeof m.id === "string" ? m.id : uid(),
          source: m.source,
          direction: m.direction === "target->ko" ? "target->ko" : "ko->target",
          translation: typeof m.translation === "string" ? m.translation : "",
          note: typeof m.note === "string" ? m.note : "",
          // 새로고침으로 끊긴 요청은 재시도할 수 있게 오류로 돌린다.
          status: m.status === "done" ? "done" : "error",
          error: m.status === "done" ? "" : (m.error || "번역이 중단되었습니다."),
          ts: Number(m.ts) || Date.now(),
        })),
    }));
}

export function loadState() {
  const saved = read(STATE_KEY, null);
  const rooms = normalizeRooms(saved?.rooms);
  if (!rooms.length) rooms.push(newRoom({ name: "영어 거래처", lang: "EN" }));
  const activeRoomId = rooms.some((r) => r.id === saved?.activeRoomId) ? saved.activeRoomId : rooms[0].id;
  return { rooms, activeRoomId };
}

export const saveState = (state) => write(STATE_KEY, state);

export function loadSettings() {
  return { apiKey: "", model: "claude-opus-5", ...read(SETTINGS_KEY, {}) };
}

export const saveSettings = (settings) => write(SETTINGS_KEY, settings);

export function exportBackup(state) {
  return JSON.stringify({ app: "biz-translator", version: 1, exportedAt: new Date().toISOString(), rooms: state.rooms }, null, 2);
}

export function parseBackup(json) {
  const data = JSON.parse(json);
  if (data?.app !== "biz-translator") throw new Error("이 앱의 백업 파일이 아닙니다.");
  const rooms = normalizeRooms(data.rooms);
  if (!rooms.length) throw new Error("백업에 채팅방이 없습니다.");
  return rooms;
}
