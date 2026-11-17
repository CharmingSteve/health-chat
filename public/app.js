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
// The browser makes a smaller analysis copy by drawing the photo onto a canvas. Drawing re-encodes the image,
// which drops the metadata, so the model never receives the location. The original is uploaded separately.
async function makeAnalysisCopy(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not make the analysis copy"))), "image/jpeg", 0.85));
}

async function postForm(form, file, contentType) {
  const data = new FormData();
  for (const [k, v] of Object.entries(form.fields)) data.append(k, v);
  data.append("file", file);
  const response = await fetch(form.url, { method: "POST", body: data });
  if (!response.ok) throw new Error(`Upload was refused (${response.status}).`);
}

async function uploadPhoto(event) {
  event.preventDefault();
  const status = $("#photo-status");
  const file = $("#photo-file").files[0];
  const date = $("#photo-date").value;
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    status.textContent = "That file is larger than 10 MB.";
    return;
  }
  $("#photo-upload").disabled = true;
  try {
    status.textContent = "Preparing…";
    const forms = await (await api("/api/photos/upload-form", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date_taken: date || undefined, original_type: file.type }),
    })).json();
    if (forms.error) throw new Error(forms.error);
    status.textContent = "Uploading…";
    await postForm(forms.original, file, file.type);
    const analysis = await makeAnalysisCopy(file);
    await postForm(forms.analysis, analysis, "image/jpeg");
    const saved = await api("/api/photos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: forms.id,
        date_taken: forms.date_taken,
        original_key: forms.original.key,
        analysis_key: forms.analysis.key,
        original_type: file.type,
        setting: $("#photo-setting").value || null,
        note: $("#photo-note").value || null,
      }),
    });
    if (!saved.ok) throw new Error((await saved.json()).error || "The photo could not be recorded.");
    status.textContent = "Saved.";
    $("#photo-form").reset();
    $("#photo-date").value = new Date().toLocaleDateString("en-CA");
    loadPhotos();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    $("#photo-upload").disabled = false;
  }
}

async function loadPhotos() {
  const list = $("#photo-list");
  try {
    const response = await api("/api/photos");
    if (!response.ok) {
      list.replaceChildren(Object.assign(document.createElement("li"), { className: "muted", textContent: "Photos are not available here." }));
      return;
    }
    const { photos } = await response.json();
    if (!photos.length) {
      list.replaceChildren(Object.assign(document.createElement("li"), { className: "muted", textContent: "No photos yet." }));
      return;
    }
    list.replaceChildren(...photos.map((p) => {
      const li = document.createElement("li");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = p.id;
      box.className = "photo-pick";
      const label = document.createElement("span");
      label.textContent = ` ${p.date_taken}${p.setting ? ` · ${p.setting}` : ""}${p.note ? ` · ${p.note}` : ""}`;
      li.append(box, label);
      return li;
    }));
  } catch {
    list.replaceChildren(Object.assign(document.createElement("li"), { className: "muted", textContent: "The photo list could not be loaded." }));
  }
}

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
    const response = await api("/api/photos/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const body = await response.json();
    result.textContent = response.ok ? body.answer : body.error || "The comparison failed.";
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
  $("#photo-form").addEventListener("submit", uploadPhoto);
  $("#photo-compare").addEventListener("click", comparePhotos);
  $("#photo-date").value = new Date().toLocaleDateString("en-CA");
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
