import { LANGUAGES, languageByCode, looksKorean, translate } from "./translator.js";
import {
  loadState, saveState, loadSettings, saveSettings,
  newRoom, newMessage, exportBackup, parseBackup,
} from "./store.js";

const $ = (id) => document.getElementById(id);

const state = loadState();
let settings = loadSettings();
let editingRoomId = null; // null이면 새 채팅방 생성 중

const el = {
  app: $("app"), backdrop: $("backdrop"),
  roomList: $("room-list"), roomName: $("room-name"), roomMeta: $("room-meta"),
  messages: $("messages"), input: $("input"), send: $("btn-send"),
  dlgRoom: $("dlg-room"), dlgSettings: $("dlg-settings"), toast: $("toast"),
};

const activeRoom = () => state.rooms.find((r) => r.id === state.activeRoomId) ?? state.rooms[0];

function persist() {
  if (!saveState(state)) toast("저장 공간이 부족합니다. 설정에서 기록을 내보낸 뒤 오래된 채팅방을 정리해 주세요.");
}

let toastTimer;
function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* ---------- 렌더링 ---------- */

function renderRooms() {
  el.roomList.replaceChildren(...state.rooms.map((room) => {
    const lang = languageByCode(room.lang);
    const li = h("li", room.id === state.activeRoomId ? "active" : "");
    li.dataset.id = room.id;
    const info = h("div", "room-info");
    const last = room.messages.at(-1);
    info.append(h("strong", "", room.name), h("span", "", last ? last.source : `한국어 ↔ ${lang.label}`));
    li.append(h("div", "room-badge", lang.code), info);
    return li;
  }));
}

function renderHead() {
  const room = activeRoom();
  const lang = languageByCode(room.lang);
  el.roomName.textContent = room.name;
  el.roomMeta.textContent = `한국어 ↔ ${lang.label}`;
  el.input.placeholder = `한국어 또는 ${lang.label}로 입력하세요`;
}

function messageNode(msg) {
  const side = msg.direction === "ko->target" ? "me" : "partner";
  const node = h("article", `msg ${side} ${msg.status === "done" ? "" : msg.status}`);
  node.dataset.id = msg.id;
  node.append(h("p", "msg-source", msg.source));

  if (msg.status === "pending") {
    const bubble = h("div", "bubble");
    bubble.append(h("span", "dots", "번역 중"));
    node.append(bubble);
    return node;
  }

  node.append(h("div", "bubble", msg.status === "done" ? msg.translation : msg.error));
  if (msg.status === "done" && msg.note) node.append(h("p", "msg-note", msg.note));

  const tools = h("div", "msg-tools");
  const action = (name, label) => {
    const btn = h("button", "", label);
    btn.type = "button";
    btn.dataset.action = name;
    return btn;
  };
  if (msg.status === "done") {
    const lang = languageByCode(activeRoom().lang).label;
    tools.append(h("span", "dir", msg.direction === "ko->target" ? `한국어 → ${lang}` : `${lang} → 한국어`));
    tools.append(action("copy", "복사"));
  }
  tools.append(action("retry", msg.status === "done" ? "다시 번역" : "재시도"), action("delete", "삭제"));
  node.append(tools);
  return node;
}

function renderMessages({ scroll = true } = {}) {
  const room = activeRoom();
  if (!room.messages.length) {
    const empty = h("div", "empty");
    const lang = languageByCode(room.lang).label;
    empty.append(
      h("strong", "", "비즈니스 문맥에 맞춰 번역합니다"),
      h("p", "", `한국어를 입력하면 ${lang}로, ${lang}를 입력하면 한국어로 번역합니다. 직역이 아니라 실제 업무 메일·메신저에서 쓰는 자연스러운 표현으로 다듬습니다.`),
    );
    el.messages.replaceChildren(empty);
    return;
  }
  el.messages.replaceChildren(...room.messages.map(messageNode));
  if (scroll) el.messages.scrollTop = el.messages.scrollHeight;
}

function renderAll() {
  renderRooms();
  renderHead();
  renderMessages();
}

/* ---------- 번역 ---------- */

async function runTranslation(room, msg) {
  msg.status = "pending";
  msg.error = "";
  if (room.id === state.activeRoomId) renderMessages();

  try {
    const history = room.messages.slice(0, room.messages.indexOf(msg));
    const result = await translate({
      apiKey: settings.apiKey, model: settings.model, room, text: msg.source, history,
    });
    Object.assign(msg, { status: "done", direction: result.direction, translation: result.translation, note: result.note });
  } catch (err) {
    Object.assign(msg, { status: "error", error: err.message || "알 수 없는 오류가 발생했습니다." });
  }

  // 번역 중에 메시지나 채팅방이 삭제됐을 수 있다.
  if (!state.rooms.includes(room) || !room.messages.includes(msg)) return;
  persist();
  renderRooms();
  if (room.id === state.activeRoomId) renderMessages();
}

function send() {
  const text = el.input.value.trim();
  if (!text) return;
  if (!settings.apiKey) {
    toast("먼저 API 키를 입력해 주세요.");
    openSettings();
    return;
  }
  const room = activeRoom();
  const msg = newMessage(text, looksKorean(text) ? "ko->target" : "target->ko");
  room.messages.push(msg);
  el.input.value = "";
  autosize();
  persist();
  runTranslation(room, msg);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("번역문을 복사했습니다.");
  } catch {
    toast("복사하지 못했습니다. 길게 눌러 직접 복사해 주세요.");
  }
}

/* ---------- 채팅방 ---------- */

function selectRoom(id) {
  state.activeRoomId = id;
  persist();
  closeSidebar();
  renderAll();
}

function openRoomDialog(room) {
  editingRoomId = room?.id ?? null;
  $("dlg-room-title").textContent = room ? "채팅방 설정" : "새 채팅방";
  $("room-f-name").value = room?.name ?? "";
  $("room-f-lang").value = room?.lang ?? "EN";
  $("room-f-tone").value = room?.tone ?? "neutral";
  $("room-f-context").value = room?.context ?? "";
  $("room-f-glossary").value = room?.glossary ?? "";
  $("room-f-delete").hidden = !room;
  el.dlgRoom.showModal();
}

function saveRoomDialog() {
  const lang = $("room-f-lang").value;
  const fields = {
    name: $("room-f-name").value.trim() || `${languageByCode(lang).label} 채팅방`,
    lang,
    tone: $("room-f-tone").value,
    context: $("room-f-context").value.trim(),
    glossary: $("room-f-glossary").value.trim(),
  };
  if (editingRoomId) {
    Object.assign(state.rooms.find((r) => r.id === editingRoomId), fields);
  } else {
    const room = newRoom(fields);
    state.rooms.unshift(room);
    state.activeRoomId = room.id;
    closeSidebar();
  }
  persist();
  renderAll();
}

function deleteRoom() {
  const room = state.rooms.find((r) => r.id === editingRoomId);
  if (!room || !confirm(`'${room.name}' 채팅방과 기록을 모두 삭제할까요?`)) return;
  state.rooms.splice(state.rooms.indexOf(room), 1);
  if (!state.rooms.length) state.rooms.push(newRoom({ name: "영어 거래처", lang: "EN" }));
  if (state.activeRoomId === room.id) state.activeRoomId = state.rooms[0].id;
  el.dlgRoom.close("cancel");
  persist();
  renderAll();
}

/* ---------- 설정 · 백업 ---------- */

function openSettings() {
  $("set-f-key").value = settings.apiKey;
  $("set-f-model").value = settings.model;
  el.dlgSettings.showModal();
}

function downloadBackup() {
  const url = URL.createObjectURL(new Blob([exportBackup(state)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `biz-translator-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importBackup(file) {
  try {
    const rooms = parseBackup(await file.text());
    for (const room of rooms) {
      const index = state.rooms.findIndex((r) => r.id === room.id);
      if (index >= 0) state.rooms[index] = room;
      else state.rooms.push(room);
    }
    persist();
    renderAll();
    toast(`채팅방 ${rooms.length}개를 가져왔습니다.`);
  } catch (err) {
    toast(err.message || "백업 파일을 읽지 못했습니다.");
  }
}

/* ---------- 기타 UI ---------- */

function openSidebar() { el.app.classList.add("sidebar-open"); el.backdrop.hidden = false; }
function closeSidebar() { el.app.classList.remove("sidebar-open"); el.backdrop.hidden = true; }

function autosize() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, 160)}px`;
  el.input.style.overflowY = el.input.scrollHeight > 160 ? "auto" : "hidden";
}

function bindEvents() {
  $("btn-new-room").addEventListener("click", () => openRoomDialog(null));
  $("btn-room-settings").addEventListener("click", () => openRoomDialog(activeRoom()));
  $("btn-settings").addEventListener("click", openSettings);
  $("btn-open-sidebar").addEventListener("click", openSidebar);
  $("btn-close-sidebar").addEventListener("click", closeSidebar);
  el.backdrop.addEventListener("click", closeSidebar);

  el.roomList.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) selectRoom(li.dataset.id);
  });

  el.messages.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const room = activeRoom();
    const msg = room.messages.find((m) => m.id === btn.closest(".msg").dataset.id);
    if (!msg) return;
    if (btn.dataset.action === "copy") copyText(msg.translation);
    if (btn.dataset.action === "retry") runTranslation(room, msg);
    if (btn.dataset.action === "delete") {
      room.messages.splice(room.messages.indexOf(msg), 1);
      persist();
      renderRooms();
      renderMessages({ scroll: false });
    }
  });

  el.send.addEventListener("click", send);
  el.input.addEventListener("input", autosize);
  el.input.addEventListener("keydown", (e) => {
    // 한글 조합 중 Enter는 전송하지 않는다. 터치 기기에서는 Enter가 줄바꿈이다.
    const touch = matchMedia("(pointer: coarse)").matches;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !touch) {
      e.preventDefault();
      send();
    }
  });

  for (const btn of document.querySelectorAll(".dlg-cancel")) {
    btn.addEventListener("click", () => btn.closest("dialog").close("cancel"));
  }

  // 저장은 폼 submit에서 처리한다 (취소·Esc는 submit을 일으키지 않는다).
  el.dlgRoom.querySelector("form").addEventListener("submit", saveRoomDialog);
  $("room-f-delete").addEventListener("click", deleteRoom);

  el.dlgSettings.querySelector("form").addEventListener("submit", () => {
    settings = { ...settings, apiKey: $("set-f-key").value.trim(), model: $("set-f-model").value };
    if (!saveSettings(settings)) toast("설정을 저장하지 못했습니다.");
    else toast("설정을 저장했습니다.");
  });
  $("set-f-export").addEventListener("click", downloadBackup);
  $("set-f-import").addEventListener("click", () => $("set-f-file").click());
  $("set-f-file").addEventListener("change", (e) => {
    const [file] = e.target.files;
    if (file) importBackup(file);
    e.target.value = "";
  });
}

function init() {
  $("room-f-lang").replaceChildren(...LANGUAGES.map((l) => {
    const opt = h("option", "", `${l.label} (${l.name})`);
    opt.value = l.code;
    return opt;
  }));
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) document.documentElement.classList.add("is-ios");

  bindEvents();
  persist(); // 중단됐던 번역을 '오류' 상태로 정리한 결과를 저장
  renderAll();
  autosize();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => { /* 오프라인 캐시 없이도 동작 */ });
  }
  if (!settings.apiKey) openSettings();
}

init();
