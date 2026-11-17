// Browser sign-in: Cognito hosted UI, authorization code flow with PKCE (no client secret in the browser).
const tokenKey = "health-chat.accessToken";
const stateKey = "health-chat.oauthState";
const verifierKey = "health-chat.pkce";
const $ = (selector) => document.querySelector(selector);

let config = null;

function base64Url(bytes) {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function redirectUri() {
  return `${location.origin}/`;
}

function domainUrl() {
  return config.domain.startsWith("https://") ? config.domain.replace(/\/$/, "") : `https://${config.domain}`;
}

async function signIn() {
  const verifier = randomString(48);
  const state = randomString(16);
  sessionStorage.setItem(verifierKey, verifier);
  sessionStorage.setItem(stateKey, state);
  const url = new URL("/oauth2/authorize", domainUrl());
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: "openid email",
    redirect_uri: redirectUri(),
    state,
    code_challenge_method: "S256",
    code_challenge: await challengeFor(verifier),
  }).toString();
  location.assign(url);
}

function signOut() {
  sessionStorage.removeItem(tokenKey);
  const url = new URL("/logout", domainUrl());
  url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: redirectUri() }).toString();
  location.assign(url);
}

async function finishSignIn() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return false;
  const expectedState = sessionStorage.getItem(stateKey);
  const verifier = sessionStorage.getItem(verifierKey);
  history.replaceState({}, "", "/");
  sessionStorage.removeItem(stateKey);
  sessionStorage.removeItem(verifierKey);
  if (!expectedState || params.get("state") !== expectedState || !verifier) {
    throw new Error("Sign-in state did not match. Try signing in again.");
  }
  const response = await fetch(new URL("/oauth2/token", domainUrl()), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });
  if (!response.ok) throw new Error("Token exchange failed. Try signing in again.");
  const tokens = await response.json();
  sessionStorage.setItem(tokenKey, tokens.access_token);
  return true;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = sessionStorage.getItem(tokenKey);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    sessionStorage.removeItem(tokenKey);
    throw new Error("Signed out. Sign in again.");
  }
  return response;
}

function show(element, visible) {
  element.hidden = !visible;
}

async function runModelCheck() {
  const button = $("#run-smoke");
  const result = $("#smoke-result");
  button.disabled = true;
  result.textContent = "Checking…";
  try {
    const response = await api("/api/smoke", { method: "POST" });
    const body = await response.json();
    result.textContent = body.ok ? "Model replied correctly." : `Model check failed (${response.status}).`;
  } catch (error) {
    result.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function renderQueries(queries) {
  const box = $("#queries");
  box.replaceChildren();
  if (!queries.length) return;
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = `Queries run (${queries.length})`;
  details.append(summary);
  for (const q of queries) {
    const pre = document.createElement("pre");
    pre.className = "sql";
    pre.textContent = `${q.ok ? `${q.row_count} rows, ${q.bytes_scanned} bytes scanned` : `Refused or failed: ${q.error}`}\n${q.sql}`;
    details.append(pre);
  }
  box.append(details);
}

// ---- Chat history ------------------------------------------------------------------------------
// The current chat is identified by conversation_id. Turns the server could not save are kept in
// localStorage and resent on each visit, so a failed save is not lost.
const pendingKey = "health-chat.pendingSaves";
let conversation = { id: null, subject: "" };
const pendingTimers = new Map();

function newConversationId() {
  return crypto.randomUUID();
}

function loadPending() {
  try { return JSON.parse(localStorage.getItem(pendingKey) || "[]"); } catch { return []; }
}

function storePending(list) {
  try { localStorage.setItem(pendingKey, JSON.stringify(list)); } catch { /* storage may be unavailable */ }
}

function addPending(turn) {
  const list = loadPending().filter((t) => t.turn_id !== turn.turn_id);
  list.push(turn);
  storePending(list);
}

function removePending(turnId) {
  storePending(loadPending().filter((t) => t.turn_id !== turnId));
}

function showBanner(text) {
  const banner = $("#save-banner");
  banner.textContent = text;
  banner.hidden = !text;
}

async function resendTurn(turn, attemptsLeft) {
  try {
    const response = await api("/api/history/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(turn),
    });
    if (response.ok) {
      removePending(turn.turn_id);
      clearTimeout(pendingTimers.get(turn.turn_id));
      pendingTimers.delete(turn.turn_id);
      showBanner(loadPending().length ? "Some answers are still not saved; they will be retried." : "");
      return;
    }
  } catch {
    // Network or sign-in problem: try again on the next round.
  }
  if (attemptsLeft > 1) {
    const timer = setTimeout(() => resendTurn(turn, attemptsLeft - 1), 15000);
    pendingTimers.set(turn.turn_id, timer);
  } else {
    showBanner("An answer could not be saved to your history. It is kept in this browser and will be retried when you next open the page.");
  }
}

function renderTurn(turn) {
  const wrap = document.createElement("div");
  wrap.className = "turn";
  const q = document.createElement("div");
  q.className = "q";
  q.textContent = turn.question;
  const a = document.createElement("div");
  a.className = "a";
  a.textContent = turn.answer;
  wrap.append(q, a);
  if (turn.queries && turn.queries.length) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `Queries run (${turn.queries.length})`;
    details.append(summary);
    for (const query of turn.queries) {
      const pre = document.createElement("pre");
      pre.className = "sql";
      pre.textContent = `${query.ok ? `${query.row_count} rows` : `Failed: ${query.error}`}\n${query.sql}`;
      details.append(pre);
    }
    wrap.append(details);
  }
  return wrap;
}

async function openConversation(id) {
  const response = await api(`/api/history/${id}`);
  if (!response.ok) {
    showBanner("That chat could not be opened.");
    return;
  }
  const body = await response.json();
  const turns = body.turns || [];
  conversation = { id, subject: turns[0]?.subject || "" };
  $("#chat-title").textContent = conversation.subject || "Chat";
  const thread = $("#thread");
  thread.replaceChildren(...turns.map(renderTurn));
  $("#answer").textContent = "";
  renderQueries([]);
}

function startNewChat() {
  conversation = { id: null, subject: "" };
  $("#chat-title").textContent = "New chat";
  $("#thread").replaceChildren();
  $("#answer").textContent = "";
  renderQueries([]);
}

async function loadChatList() {
  const list = $("#chat-list");
  try {
    const response = await api("/api/history");
    if (!response.ok) {
      list.replaceChildren(Object.assign(document.createElement("li"), { className: "muted", textContent: "History is not available here." }));
      return;
    }
    const { conversations } = await response.json();
    if (!conversations.length) {
      list.replaceChildren(Object.assign(document.createElement("li"), { className: "muted", textContent: "No chats in the last 4 months yet." }));
      return;
    }
    list.replaceChildren(...conversations.map((c) => {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.textContent = c.subject;
      link.addEventListener("click", () => openConversation(c.conversation_id));
      const when = document.createElement("span");
      when.className = "muted";
      when.textContent = `  ${new Date(c.last_asked_at).toLocaleDateString()}`;
      li.append(link, when);
      return li;
    }));
  } catch {
    list.replaceChildren(Object.assign(document.createElement("li"), { className: "muted", textContent: "The list could not be loaded." }));
  }
}

async function askQuestion(event) {
  event.preventDefault();
  const question = $("#question").value.trim();
  const status = $("#ask-status");
  const button = $("#ask-button");
  if (!question) return;
  button.disabled = true;
  status.textContent = "Thinking…";
  $("#answer").textContent = "";
  renderQueries([]);
  try {
    if (!conversation.id) conversation = { id: newConversationId(), subject: question.slice(0, 80) };
    const response = await api("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, conversation_id: conversation.id, subject: conversation.subject }),
    });
    const body = await response.json();
    if (!response.ok) {
      $("#answer").textContent = body.error || `Request failed (${response.status}).`;
    } else {
      $("#answer").textContent = body.answer;
      renderQueries(body.queries || []);
      $("#thread").append(renderTurn({ question, answer: body.answer, queries: body.queries || [] }));
      $("#chat-title").textContent = conversation.subject || "Chat";
      if (body.history_enabled && body.saved === false && body.turn) {
        addPending(body.turn);
        showBanner("Your answer is shown, but it is not saved yet. Retrying.");
        resendTurn(body.turn, 20);
      } else if (body.history_enabled) {
        showBanner("");
        loadChatList();
      }
    }
    status.textContent = "";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

// ---- Diet import status ----------------------------------------------------------------------
function describeDiet(status) {
  const ok = status.last_success;
  const attempt = status.last_attempt;
  const lines = [];
  if (ok) {
    const when = new Date(ok.run_at).toLocaleString();
    lines.push(`Last successful import: ${when} (${ok.active_days} days, ${ok.first_day} to ${ok.last_day}). Stuntman snapshot taken ${new Date(ok.stuntman_snapshot_export_time).toLocaleString()}.`);
  } else {
    lines.push("No diet import has finished yet.");
  }
  if (attempt && attempt.status === "failed") {
    lines.push(`The last attempt failed at ${new Date(attempt.last_attempt_at).toLocaleString()} (${attempt.trigger}). The data above is from the last successful import.`);
  }
  return lines.join(" ");
}

async function loadDietStatus() {
  const el = $("#diet-status");
  try {
    const response = await api("/api/diet/status");
    if (!response.ok) {
      el.textContent = "Diet import status is not available here.";
      return null;
    }
    const status = await response.json();
    el.textContent = describeDiet(status);
    return status;
  } catch (error) {
    el.textContent = error.message;
    return null;
  }
}

async function refreshDiet() {
  const button = $("#refresh-diet");
  const note = $("#refresh-status");
  const before = await loadDietStatus();
  const beforeTime = before?.last_success?.run_at ?? null;
  button.disabled = true;
  note.textContent = "Started. This takes a few minutes.";
  try {
    const response = await api("/api/diet/refresh", { method: "POST" });
    if (!response.ok) {
      note.textContent = "The refresh could not be started.";
      return;
    }
    // Poll the status for up to about 10 minutes, then stop and leave the status line to show the result.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20000));
      const status = await loadDietStatus();
      if (status?.last_success?.run_at !== beforeTime && status?.last_success) {
        note.textContent = "Done.";
        return;
      }
      if (status?.last_attempt?.status === "failed" && status.last_attempt.last_attempt_at > (before?.last_attempt?.last_attempt_at ?? "")) {
        note.textContent = "The refresh failed. See the status above.";
        return;
      }
    }
    note.textContent = "Still running. Check the status above later.";
  } catch (error) {
    note.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

// ---- Progress photos ----------------------------------------------------------------------------
// Files are read in the browser: the camera's date (EXIF), an analysis copy (re-encoded JPEG, no location), and HEIC
// decoding (libheif, loaded only when a HEIC is used). The original file is uploaded unchanged.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_PENDING = 20;
let pending = [];
let exifModule = null;
let heifModule = null;

function inferType(name, mime) {
  if (["image/jpeg", "image/png", "image/heic", "image/heif"].includes(mime)) return mime;
  const ext = (name.toLowerCase().split(".").pop() || "");
  return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif" }[ext] || null;
}

function isHeicType(type) {
  return type === "image/heic" || type === "image/heif";
}

// Same rules as src/photo-dates.ts (the server checks the stored date again).
function parseRawExifDate(raw) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) \d{2}:\d{2}:\d{2}$/.exec(String(raw || "").trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function chooseDate(exifRaw, fileDate, today) {
  const fromExif = parseRawExifDate(exifRaw);
  let date = today;
  let source = "today";
  if (fromExif) {
    date = fromExif;
    source = "metadata";
  } else if (fileDate && !Number.isNaN(fileDate.getTime())) {
    date = fileDate.toLocaleDateString("en-CA");
    source = "file";
  }
  const warning = date > today ? "This date is in the future. Please check it." : Number(date.slice(0, 4)) < 2000 ? "This date is before 2000. Please check it." : "";
  return { date, source, warning };
}

// Reads the camera's own date and location. Returns a note when something could not be read, so the page can say why.
async function readCaptureDate(file) {
  const result = { exifRaw: null, location: null, note: "" };
  try {
    if (!exifModule) exifModule = await import("/vendor/exifr.mjs");
    const parsed = await exifModule.parse(file, { pick: ["DateTimeOriginal"] });
    const d = parsed && parsed.DateTimeOriginal;
    if (d instanceof Date && !Number.isNaN(d.getTime())) {
      // The library reads the camera's local time as this computer's local time, so the local parts are the camera's date.
      // Written in the camera's raw form so the same rule as the server reads it.
      const pad = (n) => String(n).padStart(2, "0");
      result.exifRaw = `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} 00:00:00`;
    }
  } catch (error) {
    result.note = `camera date not read (${error.name}: ${error.message})`;
  }
  try {
    const gps = await exifModule.gps(file);
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) result.location = { lat: gps.latitude, lon: gps.longitude };
  } catch {
    // No location in this photo; that is fine.
  }
  return result;
}

async function decodeHeic(file) {
  if (!heifModule) heifModule = await import("/vendor/libheif.mjs");
  const libheif = await heifModule.default();
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(new Uint8Array(await file.arrayBuffer()));
  const image = images[0];
  if (!image) throw new Error("no image in file");
  const width = image.get_width();
  const height = image.get_height();
  const data = new Uint8ClampedArray(width * height * 4);
  await new Promise((resolve, reject) => image.display({ data, width, height }, (out) => (out ? resolve() : reject(new Error("display failed")))));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(new ImageData(data, width, height), 0, 0);
  if (image.free) image.free();
  return canvas;
}

// Makes the analysis copy first. If it fails, nothing is uploaded, so no half-saved photo is left behind.
async function makeAnalysisCopy(file, type) {
  let source;
  try {
    source = isHeicType(type) ? await decodeHeic(file) : await createImageBitmap(file);
  } catch (error) {
    throw new Error(`This photo could not be read in this browser (${error.name}: ${error.message}). Export a JPEG from Photos and drop that instead.`);
  }
  const width = source.width;
  const height = source.height;
  const scale = Math.min(1, 1024 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not make the analysis copy"))), "image/jpeg", 0.85));
}

async function addFiles(files) {
  const today = new Date().toLocaleDateString("en-CA");
  for (const file of Array.from(files).slice(0, MAX_PENDING - pending.length)) {
    const type = inferType(file.name, file.type);
    if (!type) {
      $("#photo-status").textContent = `${file.name}: only JPG, PNG, and HEIC are accepted.`;
      continue;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      $("#photo-status").textContent = `${file.name}: larger than 10 MB.`;
      continue;
    }
    const read = await readCaptureDate(file);
    const chosen = chooseDate(read.exifRaw, new Date(file.lastModified), today);
    const preview = isHeicType(type) ? null : URL.createObjectURL(file);
    pending.push({ file, type, date: chosen.date, source: chosen.source, warning: chosen.warning, status: read.note, location: read.location, preview });
  }
  renderPending();
}

function renderPending() {
  const box = $("#photo-pending");
  box.replaceChildren(...pending.map((item, index) => {
    const row = document.createElement("div");
    row.className = "pending-row";
    if (item.preview) {
      const img = document.createElement("img");
      img.src = item.preview;
      img.alt = "";
      img.className = "thumb-small";
      row.append(img);
    }
    const name = document.createElement("span");
    name.textContent = item.file.name;
    const date = document.createElement("input");
    date.type = "date";
    date.value = item.date;
    date.addEventListener("change", () => {
      item.date = date.value;
      item.source = "manual";
      item.warning = "";
      renderPending();
    });
    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = { metadata: "date from photo", file: "date from file", today: "date not found, today used", manual: "date typed" }[item.source];
    row.append(name, date, label);
    if (item.warning) {
      const w = document.createElement("span");
      w.className = "warn";
      w.textContent = item.warning;
      row.append(w);
    }
    if (item.location) {
      const place = document.createElement("span");
      place.className = "muted";
      place.textContent = `place ${item.location.lat.toFixed(3)}, ${item.location.lon.toFixed(3)}`;
      row.append(place);
    }
    if (item.status) {
      const st = document.createElement("span");
      st.className = "muted";
      st.textContent = item.status;
      row.append(st);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      pending.splice(index, 1);
      renderPending();
    });
    row.append(remove);
    return row;
  }));
  $("#photo-upload").hidden = pending.length === 0;
}

async function postForm(form, body) {
  const data = new FormData();
  for (const [k, v] of Object.entries(form.fields)) data.append(k, v);
  data.append("file", body);
  const response = await fetch(form.url, { method: "POST", body: data });
  if (!response.ok) throw new Error(`Upload was refused (${response.status}).`);
}

async function uploadOne(item) {
  const copy = await makeAnalysisCopy(item.file, item.type);
  const named = new File([item.file], item.file.name, { type: item.type });
  const forms = await (await api("/api/photos/upload-form", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date_taken: item.date, original_type: item.type }),
  })).json();
  if (forms.error) throw new Error(forms.error);
  await postForm(forms.original, named);
  await postForm(forms.analysis, copy);
  const saved = await api("/api/photos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: forms.id,
      date_taken: forms.date_taken,
      date_source: item.source,
      original_key: forms.original.key,
      analysis_key: forms.analysis.key,
      original_type: item.type,
      location: item.location,
      setting: $("#photo-setting").value || null,
      note: $("#photo-note").value || null,
    }),
  });
  if (!saved.ok) throw new Error((await saved.json()).error || "The photo could not be recorded.");
}

async function uploadAll() {
  const button = $("#photo-upload");
  const status = $("#photo-status");
  button.disabled = true;
  let saved = 0;
  for (const item of [...pending]) {
    item.status = "Uploading…";
    renderPending();
    try {
      await uploadOne(item);
      item.status = "Saved";
      saved += 1;
    } catch (error) {
      item.status = error.message;
    }
    renderPending();
  }
  pending = pending.filter((item) => item.status !== "Saved");
  status.textContent = `${saved} saved.`;
  renderPending();
  button.disabled = false;
  if (saved > 0) loadPhotos();
}

function setupPhotoDrop() {
  const zone = $("#photo-drop");
  const input = $("#photo-file");
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") input.click(); });
  input.addEventListener("change", () => { addFiles(input.files); input.value = ""; });
  for (const type of ["dragenter", "dragover"]) zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add("over"); });
  for (const type of ["dragleave", "drop"]) zone.addEventListener(type, () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
  $("#photo-upload").addEventListener("click", uploadAll);
}

async function thumbUrl(id) {
  const response = await api(`/api/photos/${id}/thumb`);
  if (!response.ok) throw new Error("thumbnail");
  return URL.createObjectURL(await response.blob());
}

// Thumbnails are fetched only when their card scrolls into view, and the list is loaded only when the section is open.
// Each thumbnail is a separate request, so a long library costs nothing until it is looked at.
const photoUrls = [];
const thumbObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      thumbObserver.unobserve(entry.target);
      loadThumb(entry.target);
    }
  }, { rootMargin: "200px" })
  : null;

async function loadThumb(img) {
  try {
    img.src = await thumbUrl(img.dataset.id);
    photoUrls.push(img.src);
  } catch {
    img.alt = "no preview";
  }
}

let photosStale = true;

async function loadPhotos() {
  if (!$("#photos-open").open) {
    photosStale = true;
    return;
  }
  photosStale = false;
  const list = $("#photo-list");
  thumbObserver?.disconnect();
  for (const url of photoUrls.splice(0)) URL.revokeObjectURL(url);
  try {
    const response = await api("/api/photos");
    if (!response.ok) {
      list.replaceChildren(Object.assign(document.createElement("div"), { className: "muted", textContent: "Photos are not available here." }));
      return;
    }
    const { photos } = await response.json();
    if (!photos.length) {
      list.replaceChildren(Object.assign(document.createElement("div"), { className: "muted", textContent: "No photos yet." }));
      return;
    }
    list.replaceChildren(...photos.map((p) => {
      const card = document.createElement("label");
      card.className = "photo-card";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = p.id;
      box.className = "photo-pick";
      const img = document.createElement("img");
      img.alt = "";
      img.className = "thumb";
      img.dataset.id = p.id;
      if (thumbObserver) thumbObserver.observe(img);
      else loadThumb(img);
      const caption = document.createElement("span");
      caption.className = "muted";
      const place = p.location ? ` · ${p.location.lat.toFixed(3)}, ${p.location.lon.toFixed(3)}` : "";
      caption.textContent = `${p.date_taken}${place}${p.setting ? ` · ${p.setting}` : ""}`;
      card.append(box, img, caption);
      return card;
    }));
  } catch {
    list.replaceChildren(Object.assign(document.createElement("div"), { className: "muted", textContent: "The photo list could not be loaded." }));
  }
}
$("#photos-open").addEventListener("toggle", () => {
  if ($("#photos-open").open && photosStale) loadPhotos();
});

async function comparePhotos() {
  const ids = [...document.querySelectorAll(".photo-pick:checked")].map((b) => b.value);
  const status = $("#compare-status");
  const result = $("#compare-result");
  result.textContent = "";
  if (ids.length < 2) {
    status.textContent = "Select at least two photos.";
    return;
  }
  status.textContent = "Comparing…";
  try {
    // The comparison is saved in the current chat, like any answer. A new chat starts if none is open.
    if (!conversation.id) conversation = { id: newConversationId(), subject: "Photo comparison" };
    const response = await api("/api/photos/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, conversation_id: conversation.id, subject: conversation.subject }),
    });
    const body = await response.json();
    if (!response.ok) {
      result.textContent = body.error || "The comparison failed.";
    } else {
      result.textContent = body.answer;
      $("#thread").append(renderTurn({ question: `Compare ${ids.length} photos`, answer: body.answer, queries: [] }));
      $("#chat-title").textContent = conversation.subject || "Chat";
      if (body.history_enabled && body.saved === false && body.turn) {
        addPending(body.turn);
        showBanner("The comparison is shown, but it is not saved yet. Retrying.");
        resendTurn(body.turn, 20);
      } else if (body.history_enabled) {
        showBanner("");
        loadChatList();
      }
    }
    status.textContent = "";
  } catch (error) {
    status.textContent = error.message;
  }
}

async function start() {
  config = await (await fetch("/config.json")).json();
  $("#sign-in").addEventListener("click", () => signIn().catch((error) => ($("#status").textContent = error.message)));
  $("#sign-out").addEventListener("click", signOut);
  $("#run-smoke").addEventListener("click", runModelCheck);
  $("#ask-form").addEventListener("submit", askQuestion);
  $("#new-chat").addEventListener("click", startNewChat);
  $("#refresh-diet").addEventListener("click", refreshDiet);
  setupPhotoDrop();
  $("#photo-compare").addEventListener("click", comparePhotos);

  for (const turn of loadPending()) resendTurn(turn, 20);
  try {
    await finishSignIn();
  } catch (error) {
    $("#status").textContent = error.message;
  }
  if (sessionStorage.getItem(tokenKey)) {
    try {
      await api("/api/me");
    } catch {
      // api() already cleared the token; the page below shows the signed-out state.
    }
  }
  const stillSignedIn = Boolean(sessionStorage.getItem(tokenKey));
  show($("#sign-in"), !stillSignedIn);
  show($("#sign-out"), stillSignedIn);
  show($("#app"), stillSignedIn);
  if (stillSignedIn) {
    loadChatList();
    loadDietStatus();
    loadPhotos();
  }
  $("#status").textContent = stillSignedIn ? "Signed in." : "Not signed in.";
}

start().catch((error) => {
  $("#status").textContent = `Could not start: ${error.message}`;
});
