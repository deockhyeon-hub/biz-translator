import { LANGUAGES, languageByCode, looksKorean, translate } from "./translator.js";
import {
  loadState, saveState, loadSettings, saveSettings,
  newRoom, newMessage, exportBackup, parseBackup,
  collectChanges, mergeFromServer,
} from "./store.js";
import * as api from "./api.js";

const $ = (id) => document.getElementById(id);

let auth = api.loadAuth();          // { token, user, expiresAt }
let state = null;                    // 로그인 후 채워진다
let settings = loadSettings();
let editingRoomId = null;            // null이면 새 채팅방 생성 중
let authMode = "login";              // "login" | "signup"
let syncing = false;
let syncTimer = null;

const el = {
  app: $("app"), backdrop: $("backdrop"), auth: $("auth"),
  roomList: $("room-list"), roomName: $("room-name"), roomMeta: $("room-meta"),
  messages: $("messages"), input: $("input"), send: $("btn-send"),
  dlgRoom: $("dlg-room"), dlgSettings: $("dlg-settings"), toast: $("toast"),
};

const liveRooms = () => state.rooms.filter((r) => !r.deleted);
const liveMessages = (room) => room.messages.filter((m) => !m.deleted);

function activeRoom() {
  const rooms = liveRooms();
  return rooms.find((r) => r.id === state.activeRoomId) ?? rooms[0];
}

const touch = (item) => { item.updatedAt = Date.now(); };

function persist({ sync = true } = {}) {
  if (!saveState(auth?.user?.id, state)) {
    toast("저장 공간이 부족합니다. 설정에서 기록을 내보낸 뒤 오래된 채팅방을 정리해 주세요.");
  }
  if (sync) scheduleSync();
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

/* ---------- 동기화 ---------- */

function scheduleSync() {
  if (!auth?.token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { runSync(); }, 1200);
}

async function runSync({ silent = true } = {}) {
  if (!auth?.token || syncing || !state) return;
  syncing = true;
  try {
    const since = state.lastSyncAt || 0;

    const changes = collectChanges(state, since);
    if (changes.rooms.length || changes.messages.length) {
      await api.syncPush(auth.token, changes);
    }

    const pulled = await api.syncPull(auth.token, since);
    const maxSeen = mergeFromServer(state, pulled);
    state.lastSyncAt = Math.max(since, maxSeen);

    // 현재 방이 다른 기기에서 삭제됐을 수 있다.
    if (!activeRoom()) {
      if (!liveRooms().length) state.rooms.push(newRoom({ name: "영어 거래처", lang: "EN" }));
      state.activeRoomId = liveRooms()[0].id;
    }

    saveState(auth.user.id, state);
    renderAll();
  } catch (err) {
    if (err.status === 401) {
      handleSignedOut("로그인이 만료되었습니다. 다시 로그인해 주세요.");
      return;
    }
    if (!silent) toast(err.message || "동기화하지 못했습니다.");
  } finally {
    syncing = false;
  }
}

/* ---------- 렌더링 ---------- */

function renderRooms() {
  el.roomList.replaceChildren(...liveRooms().map((room) => {
    const lang = languageByCode(room.lang);
    const li = h("li", room.id === state.activeRoomId ? "active" : "");
    li.dataset.id = room.id;
    const info = h("div", "room-info");
    const last = liveMessages(room).at(-1);
    info.append(h("strong", "", room.name), h("span", "", last ? last.source : `한국어 ↔ ${lang.label}`));
    li.append(h("div", "room-badge", lang.code), info);
    return li;
  }));
}

function renderHead() {
  const room = activeRoom();
  if (!room) return;
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
  if (!room) return;
  const list = liveMessages(room);
  if (!list.length) {
    const empty = h("div", "empty");
    const lang = languageByCode(room.lang).label;
    empty.append(
      h("strong", "", "비즈니스 문맥에 맞춰 번역합니다"),
      h("p", "", `한국어를 입력하면 ${lang}로, ${lang}를 입력하면 한국어로 번역합니다. 직역이 아니라 실제 업무 메일·메신저에서 쓰는 자연스러운 표현으로 다듬습니다.`),
    );
    el.messages.replaceChildren(empty);
    return;
  }
  el.messages.replaceChildren(...list.map(messageNode));
  if (scroll) el.messages.scrollTop = el.messages.scrollHeight;
}

function renderAll() {
  if (!state) return;
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
    const history = liveMessages(room).slice(0, liveMessages(room).indexOf(msg));
    const result = await translate({
      token: auth.token, model: settings.model, room, text: msg.source, history,
    });
    Object.assign(msg, {
      status: "done",
      direction: result.direction,
      translation: result.translation,
      note: result.note,
      error: "",
    });
  } catch (err) {
    if (err.status === 401) {
      handleSignedOut("로그인이 만료되었습니다. 다시 로그인해 주세요.");
      return;
    }
    Object.assign(msg, { status: "error", error: err.message || "알 수 없는 오류가 발생했습니다." });
  }

  // 번역 중에 메시지나 채팅방이 삭제됐을 수 있다.
  if (!state.rooms.includes(room) || !room.messages.includes(msg)) return;
  touch(msg);
  persist();
  renderRooms();
  if (room.id === state.activeRoomId) renderMessages();
}

function send() {
  const text = el.input.value.trim();
  if (!text) return;
  const room = activeRoom();
  if (!room) return;
  const msg = newMessage(text, looksKorean(text) ? "ko->target" : "target->ko");
  room.messages.push(msg);
  el.input.value = "";
  autosize();
  persist({ sync: false });
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
  persist({ sync: false });
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
    const room = state.rooms.find((r) => r.id === editingRoomId);
    Object.assign(room, fields);
    touch(room);
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
  room.deleted = true;
  touch(room);
  if (!liveRooms().length) state.rooms.push(newRoom({ name: "영어 거래처", lang: "EN" }));
  if (state.activeRoomId === room.id) state.activeRoomId = liveRooms()[0].id;
  el.dlgRoom.close("cancel");
  persist();
  renderAll();
}

/* ---------- 설정 · 백업 ---------- */

function openSettings() {
  $("set-f-model").value = settings.model;
  $("set-account-email").textContent = auth?.user?.email ?? "";
  $("set-account-role").textContent = auth?.user?.role === "admin" ? "관리자" : "직원";
  $("set-admin").hidden = auth?.user?.role !== "admin";
  $("set-invite-result").hidden = true;
  $("set-invite-result").textContent = "";
  el.dlgSettings.showModal();
}

async function issueInvites() {
  try {
    const count = Number($("set-invite-count").value) || 1;
    const data = await api.createInvites(auth.token, { count, expiresDays: 30 });
    const box = $("set-invite-result");
    box.hidden = false;
    box.textContent = `${data.codes.join("\n")}\n\n30일 안에 사용해야 합니다. 한 코드는 한 명만 쓸 수 있습니다.`;
  } catch (err) {
    toast(err.message || "초대 코드를 만들지 못했습니다.");
  }
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
      touch(room);
      for (const m of room.messages) touch(m);
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

/* ---------- 로그인 ---------- */

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  $("auth-title").textContent = signup ? "회원가입" : "로그인";
  $("auth-sub").textContent = signup
    ? "가입 후에는 PC와 휴대폰 어디서 열어도 같은 기록을 씁니다."
    : "로그인하면 이 계정의 채팅방과 기록을 그대로 이어서 씁니다.";
  $("auth-signup-fields").hidden = !signup;
  $("auth-submit").textContent = signup ? "가입하고 시작하기" : "로그인";
  $("auth-toggle").textContent = signup ? "이미 계정이 있습니다. 로그인" : "계정이 없습니다. 회원가입";
  $("auth-password").autocomplete = signup ? "new-password" : "current-password";
  showAuthError("");
}

function showAuthError(message) {
  const box = $("auth-error");
  box.textContent = message;
  box.hidden = !message;
}

function showAuthScreen(message) {
  el.auth.hidden = false;
  el.app.hidden = true;
  if (message) showAuthError(message);
  $("auth-email").focus();
}

function hideAuthScreen() {
  el.auth.hidden = true;
  el.app.hidden = false;
}

async function submitAuth(event) {
  event.preventDefault();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const btn = $("auth-submit");
  btn.disabled = true;
  showAuthError("");

  try {
    const payload = authMode === "signup"
      ? {
          email,
          password,
          name: $("auth-name").value.trim(),
          invite: $("auth-invite").value.trim(),
        }
      : { email, password };
    const data = authMode === "signup" ? await api.signup(payload) : await api.login(payload);
    auth = { token: data.token, user: data.user, expiresAt: data.expiresAt };
    api.saveAuth(auth);
    $("auth-password").value = "";
    startApp();
  } catch (err) {
    showAuthError(err.message || "로그인하지 못했습니다.");
  } finally {
    btn.disabled = false;
  }
}

function handleSignedOut(message) {
  api.clearAuth();
  auth = null;
  state = null;
  clearTimeout(syncTimer);
  showAuthScreen(message || "");
  setAuthMode("login");
}

async function signOut() {
  const token = auth?.token;
  el.dlgSettings.close("cancel");
  handleSignedOut("로그아웃했습니다.");
  if (token) api.logout(token).catch(() => { /* 서버 정리는 실패해도 무방 */ });
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
  $("auth-form").addEventListener("submit", submitAuth);
  $("auth-toggle").addEventListener("click", () => setAuthMode(authMode === "signup" ? "login" : "signup"));

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
      msg.deleted = true;
      touch(msg);
      persist();
      renderRooms();
      renderMessages({ scroll: false });
    }
  });

  el.send.addEventListener("click", send);
  el.input.addEventListener("input", autosize);
  el.input.addEventListener("keydown", (e) => {
    // 한글 조합 중 Enter는 전송하지 않는다. 터치 기기에서는 Enter가 줄바꿈이다.
    const touchDevice = matchMedia("(pointer: coarse)").matches;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !touchDevice) {
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
    settings = { ...settings, model: $("set-f-model").value };
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
  $("set-f-logout").addEventListener("click", signOut);
  $("set-invite-create").addEventListener("click", issueInvites);

  // 다른 기기에서 바뀐 내용을 가져온다.
  window.addEventListener("focus", () => { runSync(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") runSync();
  });
}

function startApp() {
  hideAuthScreen();
  state = loadState(auth.user.id);
  saveState(auth.user.id, state);
  renderAll();
  autosize();
  runSync({ silent: false });
}

function init() {
  $("room-f-lang").replaceChildren(...LANGUAGES.map((l) => {
    const opt = h("option", "", `${l.label} (${l.name})`);
    opt.value = l.code;
    return opt;
  }));
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) document.documentElement.classList.add("is-ios");

  bindEvents();
  setAuthMode("login");

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => { /* 오프라인 캐시 없이도 동작 */ });
  }

  if (auth?.token) startApp();
  else showAuthScreen();
}

init();
