/* 이번주 한줄평 — 한 주간 새로 좋아요한 Spotify 곡에 한줄평을 남기는 앱 */
(() => {
  "use strict";

  const CFG = window.APP_CONFIG;
  const Review = window.ReviewModel;
  // 등록된 리다이렉트 URI와 정확히 일치해야 하므로 index.html은 떼고 계산한다
  const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, "");
  const MAX_PAGES = 20; // 1000곡. 이보다 많이 좋아요한 기간이면 잘렸다고 알려준다

  const LS = {
    accessToken: "sp_access_token",
    expiresAt: "sp_expires_at",
    refreshToken: "sp_refresh_token",
    verifier: "rv_pkce_verifier",
    settings: "rv_settings",
    submitted: "rv_submitted_ids",
    drafts: "rv_drafts",
  };

  const $ = (id) => document.getElementById(id);
  const views = { login: $("login-view"), main: $("main-view"), history: $("history-view") };

  let demoMode = false;
  let currentSongs = []; // 화면에 떠 있는(아직 저장 안 된) 곡들
  let saving = false;
  let demoReviews = [];
  let mainTotal = 0;

  /* ---------- 설정 ---------- */

  function getSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(LS.settings) || "{}"); } catch (e) { /* 무시 */ }
    return { scriptUrl: s.scriptUrl || "", secret: s.secret || "", days: Number(s.days) || CFG.defaultDays };
  }
  function saveSettings(s) { localStorage.setItem(LS.settings, JSON.stringify(s)); }
  function apiConfigured() { const s = getSettings(); return !!(s.scriptUrl && s.secret); }

  function getSubmitted() {
    try { return new Set(JSON.parse(localStorage.getItem(LS.submitted) || "[]")); } catch (e) { return new Set(); }
  }
  function addSubmitted(ids) {
    const set = getSubmitted();
    ids.forEach((id) => set.add(id));
    // 무한히 자라지 않게 최근 500개만 유지
    localStorage.setItem(LS.submitted, JSON.stringify([...set].slice(-500)));
  }

  /* ---------- 작성 중인 한줄평(임시 보관) ----------
     화면을 다시 그리거나 앱이 백그라운드에서 종료돼도 쓰던 글이 날아가지 않게 한다. */

  function getDrafts() {
    try {
      const value = JSON.parse(localStorage.getItem(demoMode ? "rv_demo_drafts" : LS.drafts) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (e) { return {}; }
  }
  function setDraft(trackId, value) {
    const d = getDrafts();
    // 수정 중 비운 입력도 남겨야 이전 평점이 뜻하지 않게 복원되지 않는다.
    d[trackId] = Review.draft(value);
    localStorage.setItem(demoMode ? "rv_demo_drafts" : LS.drafts, JSON.stringify(d));
  }
  function clearDrafts(trackIds) {
    const d = getDrafts();
    trackIds.forEach((id) => delete d[id]);
    localStorage.setItem(demoMode ? "rv_demo_drafts" : LS.drafts, JSON.stringify(d));
  }

  function draftKey(trackId, editing = false) { return editing ? "edit:" + trackId : trackId; }

  function editorHtml() {
    return `<div class="rating-heading"><span>내 평점 · <output class="rating-value" aria-live="polite">미평가</output></span><button type="button" class="rating-clear">평점 지우기</button></div>
      <div class="rating-stars" role="group" aria-label="0.5점부터 5점까지 선택. 별의 왼쪽 반은 반 점, 오른쪽 반은 온 점. 방향키로 0.5점씩 조절">
        ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="rating-star" data-star="${n}" aria-label="${n - 0.5}점 또는 ${n}점 선택" aria-pressed="false">☆</button>`).join("")}
      </div><p class="rating-hint">별의 왼쪽은 반 점, 오른쪽은 온 점</p>
      <div class="review-row"><textarea class="review-input" aria-label="한줄평 (선택)" rows="1" placeholder="한 줄 감상… (선택)" maxlength="300"></textarea><button class="save-btn" disabled>저장</button></div>`;
  }

  function editorValue(card) { return { review: card.querySelector(".review-input").value, rating: Review.rating(card._rating) }; }

  function updateEditor(card) {
    const value = editorValue(card);
    card.querySelector(".rating-value").textContent = value.rating === null ? "미평가" : `${value.rating.toFixed(1)} / 5`;
    const glyphs = Review.stars(value.rating);
    card.querySelectorAll(".rating-star").forEach((button, i) => {
      button.innerHTML = glyphs[i];
      button.setAttribute("aria-pressed", String(i + 1 === Math.ceil(value.rating)));
    });
    card.querySelector(".rating-clear").disabled = saving || value.rating === null || card.classList.contains("saved");
    card.querySelector(".save-btn").disabled = saving || !Review.hasContent(value) || card.classList.contains("saved");
  }

  function bindEditor(card, key, initial, onSave) {
    const drafts = getDrafts();
    const value = Review.draft(Object.prototype.hasOwnProperty.call(drafts, key) ? drafts[key] : initial);
    const input = card.querySelector(".review-input");
    card._rating = value.rating;
    card._draftKey = key;
    input.value = value.review;
    const changed = () => {
      setDraft(key, editorValue(card));
      updateEditor(card);
      input.style.height = "auto";
      input.style.height = input.scrollHeight + "px";
      updateSaveAll();
    };
    input.addEventListener("input", changed);
    card.querySelectorAll(".rating-star").forEach((button) => {
      button.addEventListener("click", (e) => {
        const n = Number(button.dataset.star);
        const rect = button.getBoundingClientRect();
        card._rating = e.detail > 0 || e.pointerType ? Review.pointerRating(n, e.clientX, rect.left, rect.width) : n;
        changed();
      });
      button.addEventListener("keydown", (e) => {
        if (!["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const step = ["ArrowLeft", "ArrowDown"].includes(e.key) ? -0.5 : 0.5;
        card._rating = e.key === "Home" ? 0.5 : e.key === "End" ? 5 : Math.max(0.5, Math.min(5, (card._rating || 0) + step));
        changed();
      });
    });
    card.querySelector(".rating-clear").addEventListener("click", () => { card._rating = null; changed(); });
    card.querySelector(".save-btn").addEventListener("click", onSave);
    updateEditor(card);
    if (input.value) { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; }
  }

  function setSaving(value) {
    saving = value;
    document.querySelectorAll(".song-card, .history-item.editing").forEach((card) => {
      card.querySelectorAll("button, textarea").forEach((el) => { el.disabled = value || card.classList.contains("saved"); });
      updateEditor(card);
    });
    ["btn-history", "btn-refresh", "btn-back", "btn-settings", "btn-open-settings"].forEach((id) => { $(id).disabled = value; });
    document.querySelectorAll(".history-edit-btn").forEach((btn) => { btn.disabled = value; });
    updateSaveAll();
  }

  async function persistReviews(payload) {
    if (demoMode) {
      payload.forEach((p) => {
        const old = demoReviews.find((r) => r.track_id === p.track_id) || {};
        const next = { ...old, ...p, track_name: p.name ?? old.track_name, spotify_url: p.url ?? old.spotify_url, saved_at: savedAtLocal() };
        demoReviews = [next, ...demoReviews.filter((r) => r.track_id !== p.track_id)];
      });
      return payload.map((p) => p.track_id);
    }
    // 구버전 서버는 모르는 평점을 조용히 버리므로 전송 전에 지원 여부를 확인한다.
    const server = await api("ping");
    if (server.rating_step !== 0.5) throw new Error("저장 서버 업데이트가 필요해요. 입력 내용은 이 기기에 보관했어요.");
    const result = await api("add", { reviews: payload });
    if (!Array.isArray(result.saved_ids)) throw new Error("저장 확인을 받지 못했어요. 입력을 유지했으니 다시 시도해 주세요.");
    return result.saved_ids;
  }

  /* ---------- 화면 유틸 ---------- */

  function show(name) {
    Object.entries(views).forEach(([k, el]) => { el.hidden = k !== name; });
    $("loading").hidden = true;
  }
  function showLoading(msg) {
    Object.values(views).forEach((el) => { el.hidden = true; });
    $("loading-msg").textContent = msg || "불러오는 중…";
    $("loading").hidden = false;
  }

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function daysAgoLabel(iso) {
    const d = Math.floor((Date.now() - Date.parse(iso)) / 864e5);
    if (d <= 0) return "오늘";
    if (d === 1) return "어제";
    return `${d}일 전`;
  }

  function savedAtLocal() {
    // 자정 무렵 수정한 기록도 서버와 같은 한국 날짜로 바로 표시한다.
    return new Date(Date.now() + 9 * 3600e3).toISOString().replace("Z", "+09:00");
  }

  // 로그인이 풀린 게 아니라 잠깐 실패한 것들은 로그인 화면으로 보내지 않는다
  function friendlyError(e) {
    if (e && e.transient) return e.message;
    if (e instanceof TypeError) return "네트워크에 연결할 수 없어요.";
    return (e && e.message) || "알 수 없는 오류가 발생했어요.";
  }

  function showErrorState(msg) {
    show("main");
    $("config-banner").hidden = apiConfigured() || demoMode;
    $("song-list").innerHTML = "";
    $("summary").textContent = "";
    $("btn-save-all").hidden = true;
    const empty = $("empty-state");
    empty.hidden = false;
    empty.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = msg;
    const btn = document.createElement("button");
    btn.className = "ghost";
    btn.textContent = "다시 시도";
    btn.style.marginTop = "18px";
    btn.addEventListener("click", loadMain);
    empty.append(p, btn);
  }

  /* ---------- Spotify OAuth (Authorization Code + PKCE) ---------- */

  function b64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function randomString(len) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const vals = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(vals, (v) => chars[v % chars.length]).join("");
  }

  async function startLogin() {
    const verifier = randomString(64);
    localStorage.setItem(LS.verifier, verifier);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const params = new URLSearchParams({
      client_id: CFG.clientId,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: "user-library-read",
      code_challenge_method: "S256",
      code_challenge: b64url(digest),
    });
    location.href = "https://accounts.spotify.com/authorize?" + params.toString();
  }

  function saveTokens(d) {
    localStorage.setItem(LS.accessToken, d.access_token);
    // 만료 1분 전을 기한으로 잡아 여유를 둔다
    localStorage.setItem(LS.expiresAt, String(Date.now() + (d.expires_in - 60) * 1000));
    if (d.refresh_token) localStorage.setItem(LS.refreshToken, d.refresh_token);
  }
  function clearTokens() {
    [LS.accessToken, LS.expiresAt, LS.refreshToken].forEach((k) => localStorage.removeItem(k));
  }
  function clearAccessTokenOnly() {
    [LS.accessToken, LS.expiresAt].forEach((k) => localStorage.removeItem(k));
  }

  async function exchangeCode(code) {
    const verifier = localStorage.getItem(LS.verifier);
    if (!verifier) throw new Error("인증 정보가 유실됐어요. 다시 로그인해 주세요.");
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CFG.clientId,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) throw new Error("토큰 교환 실패 (" + res.status + ")");
    saveTokens(await res.json());
    localStorage.removeItem(LS.verifier);
  }

  /** 토큰 갱신. 성공하면 새 access token, 정말 만료/취소된 경우 null.
   *  네트워크·서버 문제(일시적)면 던진다 — 이때 refresh token은 지우지 않는다. */
  async function refreshAccessToken() {
    const rt = localStorage.getItem(LS.refreshToken);
    if (!rt) return null;
    let res;
    try {
      res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: CFG.clientId }),
      });
    } catch (e) {
      throw Object.assign(new Error("네트워크에 연결할 수 없어요."), { transient: true });
    }
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) { clearTokens(); return null; }
      throw Object.assign(new Error("Spotify 인증 서버가 응답하지 않아요 (" + res.status + ")"), { transient: true });
    }
    saveTokens(await res.json());
    return localStorage.getItem(LS.accessToken);
  }

  async function getAccessToken() {
    const at = localStorage.getItem(LS.accessToken);
    const exp = Number(localStorage.getItem(LS.expiresAt) || 0);
    if (at && Date.now() < exp) return at;
    return refreshAccessToken();
  }

  /* ---------- Spotify: 최근 좋아요 곡 ---------- */

  async function fetchRecentLikes(days) {
    let token = await getAccessToken();
    if (!token) throw Object.assign(new Error("auth"), { authNeeded: true });

    const cutoff = Date.now() - days * 864e5;
    const out = [];
    let url = "https://api.spotify.com/v1/me/tracks?limit=50";
    let pages = 0;
    let retriedAuth = false;

    while (url && pages < MAX_PAGES) {
      let res;
      try {
        res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
      } catch (e) {
        throw Object.assign(new Error("네트워크에 연결할 수 없어요."), { transient: true });
      }

      if (res.status === 401) {
        // access token만 죽었을 수 있으니 갱신해서 한 번 더 시도한다
        if (!retriedAuth) {
          retriedAuth = true;
          clearAccessTokenOnly();
          token = await refreshAccessToken();
          if (token) continue;
        }
        clearTokens();
        throw Object.assign(new Error("auth"), { authNeeded: true });
      }
      if (res.status === 429) throw Object.assign(new Error("Spotify 요청이 많아요. 잠시 후 다시 시도해 주세요."), { transient: true });
      if (!res.ok) throw Object.assign(new Error("Spotify 오류 (" + res.status + ")"), { transient: true });

      const data = await res.json();
      for (const item of data.items || []) {
        const t = item && item.track;
        if (!t || !t.id) continue;
        if (Date.parse(item.added_at) < cutoff) return { songs: out, truncated: false }; // 최신순이라 여기서 끝
        const images = (t.album && t.album.images) || [];
        out.push({
          track_id: t.id,
          name: t.name || "",
          artists: (t.artists || []).map((a) => a.name).join(", "),
          album: (t.album && t.album.name) || "",
          release_date: (t.album && t.album.release_date) || "",
          added_at: item.added_at,
          url: (t.external_urls && t.external_urls.spotify) || "",
          cover: (images[1] && images[1].url) || (images[0] && images[0].url) || "",
        });
      }
      url = data.next;
      pages++;
    }
    return { songs: out, truncated: !!url };
  }

  /* ---------- 저장 서버 (Apps Script) ---------- */

  async function api(action, extra = {}) {
    const { scriptUrl, secret } = getSettings();
    if (!scriptUrl || !secret) throw Object.assign(new Error("설정 필요"), { needConfig: true });
    // Content-Type을 text/plain으로 보내야 CORS preflight 없이 Apps Script에 닿는다
    const res = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret, action, ...extra }),
    });
    if (!res.ok) throw new Error("저장 서버 오류 (" + res.status + ")");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "저장 서버 오류");
    return data;
  }

  async function fetchReviewedIds() {
    const local = getSubmitted();
    if (!apiConfigured()) return { ids: local, remoteOk: false };
    try {
      const data = await api("ids");
      (data.ids || []).forEach((id) => local.add(id));
      return { ids: local, remoteOk: true };
    } catch (e) {
      return { ids: local, remoteOk: false };
    }
  }

  /* ---------- 메인 화면 ---------- */

  async function loadMain() {
    if (saving) return;
    showLoading("이번 주 좋아요 곡을 불러오는 중…");
    const days = getSettings().days;
    try {
      const [likes, reviewed] = await Promise.all([
        demoMode ? Promise.resolve({ songs: DEMO_SONGS, truncated: false }) : fetchRecentLikes(days),
        demoMode ? Promise.resolve({ ids: new Set(demoReviews.map((r) => r.track_id)), remoteOk: true }) : fetchReviewedIds(),
      ]);
      const fresh = likes.songs.filter((s) => !reviewed.ids.has(s.track_id));
      currentSongs = fresh;
      renderMain(likes.songs.length, fresh, days, reviewed.remoteOk, likes.truncated);
    } catch (e) {
      if (e.authNeeded) { showLogin("로그인이 만료됐어요. 다시 로그인해 주세요."); return; }
      showErrorState(friendlyError(e));
    }
  }

  function renderMain(totalCount, fresh, days, remoteOk, truncated) {
    mainTotal = totalCount;
    show("main");
    $("config-banner").hidden = apiConfigured() || demoMode;

    const doneCount = totalCount - fresh.length;
    const notes = [];
    if (!remoteOk && !demoMode) notes.push("기록 서버 연결 안 됨");
    if (truncated) notes.push(`최근 ${MAX_PAGES * 50}곡까지만 표시`);
    $("summary").textContent = totalCount
      ? `최근 ${days}일 새 좋아요 ${totalCount}곡 · 기록 완료 ${doneCount}곡` + (notes.length ? ` (${notes.join(", ")})` : "")
      : "";

    const list = $("song-list");
    list.innerHTML = "";
    const empty = $("empty-state");

    if (!fresh.length) {
      empty.hidden = false;
      empty.innerHTML = totalCount
        ? "최근 좋아요한 곡에 전부 기록을 남겼어요 🎉"
        : `최근 ${days}일간 새로 좋아요한 곡이 없어요 🎧<br>⚙ 설정에서 기간을 늘려볼 수 있어요.`;
      $("btn-save-all").hidden = true;
      return;
    }
    empty.hidden = true;

    for (const song of fresh) {
      const card = document.createElement("div");
      card.className = "song-card";
      card.dataset.trackId = song.track_id;
      card.innerHTML = `
        <div class="song-head">
          ${song.cover
            ? `<img class="cover" src="${escapeHtml(song.cover)}" alt="" loading="lazy" />`
            : `<div class="cover">♪</div>`}
          <div class="song-meta">
            <div class="song-title">${escapeHtml(song.name)}</div>
            <div class="song-sub">${escapeHtml(song.artists)}${song.album ? " · " + escapeHtml(song.album) : ""}</div>
          </div>
          <div class="song-when">${daysAgoLabel(song.added_at)}</div>
        </div>
        ${editorHtml()}`;
      list.appendChild(card);
      bindEditor(card, draftKey(song.track_id), null, () => saveReviews([song], card));
    }
    updateSaveAll();
  }

  function updateSaveAll() {
    const pending = [...document.querySelectorAll(".song-card:not(.saved)")]
      .filter((c) => Review.hasContent(editorValue(c))).length;
    const btn = $("btn-save-all");
    btn.hidden = pending < 2;
    btn.disabled = saving;
    btn.textContent = `작성한 기록 모두 저장 (${pending}곡)`;
  }

  function cardFor(trackId) {
    return document.querySelector(`.song-card[data-track-id="${CSS.escape(trackId)}"]`);
  }

  async function saveReviews(songs, singleCard) {
    if (saving) return;
    const payload = [];
    for (const song of songs) {
      const card = singleCard || cardFor(song.track_id);
      if (!card || card.classList.contains("saved")) continue;
      const value = editorValue(card);
      if (!Review.hasContent(value)) continue;
      payload.push({
        track_id: song.track_id,
        name: song.name,
        artists: song.artists,
        album: song.album,
        release_date: song.release_date,
        added_at: song.added_at,
        url: song.url,
        review: value.review.trim(),
        rating: value.rating,
      });
    }
    if (!payload.length) return;

    try {
      if (!demoMode && !apiConfigured()) { toast("먼저 ⚙ 설정에서 저장 서버를 연결해 주세요."); $("settings-dialog").showModal(); return; }
      setSaving(true);
      const buttons = payload.map((p) => cardFor(p.track_id)).filter(Boolean).map((c) => c.querySelector(".save-btn"));
      buttons.forEach((b) => { b.disabled = true; b.textContent = "저장 중…"; });
      const confirmed = new Set(await persistReviews(payload));
      const ids = payload.map((p) => p.track_id).filter((id) => confirmed.has(id));
      if (!demoMode) addSubmitted(ids);
      clearDrafts(ids);
      markSaved(ids);
      toast(ids.length === payload.length ? `${demoMode ? "(데모) " : ""}기록 ${ids.length}곡 저장 완료 ✓` : `${ids.length}곡 저장됨. 나머지 입력은 유지했어요. 다시 저장해 주세요.`, 4000);
    } catch (e) {
      toast("저장 실패: " + friendlyError(e), 4000);
    } finally {
      document.querySelectorAll(".song-card:not(.saved) .save-btn").forEach((b) => { b.textContent = "저장"; });
      setSaving(false);
    }
  }

  function markSaved(trackIds) {
    for (const id of trackIds) {
      const card = cardFor(id);
      if (!card) continue;
      card.classList.add("saved");
      card.querySelectorAll("button, textarea").forEach((el) => { el.disabled = true; });
      const btn = card.querySelector(".save-btn");
      btn.disabled = true;
      btn.textContent = "✓ 저장됨";
      btn.classList.add("done");
    }
    const doneNow = document.querySelectorAll(".song-card.saved").length;
    const total = currentSongs.length;
    $("summary").textContent = doneNow >= total && total > 0
      ? `오늘 몫 끝! 기록 ${mainTotal}곡 완료 🎉`
      : `최근 ${getSettings().days}일 새 좋아요 ${mainTotal}곡 · 기록 완료 ${mainTotal - total + doneNow}곡`;
    updateSaveAll();
  }

  /* ---------- 지난 기록 ---------- */

  async function loadHistory() {
    if (saving) return;
    if (!demoMode && !apiConfigured()) { toast("먼저 ⚙ 설정에서 저장 서버를 연결해 주세요."); return; }
    showLoading("지난 기록을 불러오는 중…");
    try {
      const data = demoMode ? { reviews: demoReviews } : await api("list", { limit: 50 });
      show("history");
      const list = $("history-list");
      list.innerHTML = "";
      if (!data.reviews.length) {
        list.innerHTML = `<p class="empty">아직 저장된 기록이 없어요.</p>`;
        return;
      }
      for (const r of data.reviews) {
        const div = document.createElement("div");
        div.className = "history-item";
        list.appendChild(div);
        renderHistoryItem(div, r);
      }
    } catch (e) {
      show("main");
      toast("기록 불러오기 실패: " + friendlyError(e), 4000);
    }
  }

  function renderHistoryItem(card, record) {
    const rating = Review.rating(record.rating);
    card.classList.remove("editing");
    card.innerHTML = `<div class="song-title">${escapeHtml(record.track_name)} <span class="song-sub">— ${escapeHtml(record.artists)}</span></div>
      <div class="history-rating">${rating === null ? "미평가" : Review.stars(rating).join("") + ` <span>${rating.toFixed(1)} / 5</span>`}</div>
      <div class="history-review">${escapeHtml(record.review || "한줄평 없음")}</div>
      <div class="history-footer"><div class="history-date">${escapeHtml(String(record.saved_at).slice(0, 10))}</div><button type="button" class="save-btn history-edit-btn">${rating === null ? "평점 추가 · 수정" : "수정"}</button></div>`;
    card.querySelector(".history-edit-btn").addEventListener("click", () => {
      if (saving) return;
      card.classList.add("editing");
      card.innerHTML = `<div class="song-title">${escapeHtml(record.track_name)} <span class="song-sub">— ${escapeHtml(record.artists)}</span></div>${editorHtml()}<button type="button" class="link-btn history-cancel">취소</button>`;
      const key = draftKey(record.track_id, true);
      bindEditor(card, key, { review: record.review, rating }, async () => {
        if (saving) return;
        const value = editorValue(card);
        if (!Review.hasContent(value)) return;
        try {
          setSaving(true);
          card.querySelector(".save-btn").textContent = "저장 중…";
          // 곡 정보는 서버의 원본을 유지하고 사용자가 고친 두 항목만 전송한다.
          const confirmed = await persistReviews([{ track_id: record.track_id, review: value.review.trim(), rating: value.rating }]);
          if (!confirmed.includes(record.track_id)) throw new Error("저장이 확인되지 않았어요. 다시 시도해 주세요.");
          clearDrafts([key]);
          Object.assign(record, { review: value.review.trim(), rating: value.rating, saved_at: savedAtLocal() });
          renderHistoryItem(card, record);
          toast("기록을 수정했어요 ✓");
        } catch (e) {
          card.querySelector(".save-btn").textContent = "저장";
          toast("저장 실패: " + friendlyError(e), 4000);
        } finally { setSaving(false); }
      });
      card.querySelector(".history-cancel").addEventListener("click", () => { clearDrafts([key]); renderHistoryItem(card, record); });
    });
  }

  /* ---------- 로그인 화면 ---------- */

  function showLogin(msg) {
    show("login");
    $("login-msg").textContent = msg || "";
  }

  /* ---------- 설정 다이얼로그 ---------- */

  function openSettings() {
    const s = getSettings();
    $("set-url").value = s.scriptUrl;
    $("set-secret").value = s.secret;
    $("set-days").value = s.days;
    $("test-result").textContent = "";
    $("settings-dialog").showModal();
  }

  function bindEvents() {
    $("btn-login").addEventListener("click", () => startLogin().catch((e) => toast(friendlyError(e), 4000)));
    $("btn-refresh").addEventListener("click", loadMain);
    $("btn-history").addEventListener("click", loadHistory);
    $("btn-back").addEventListener("click", loadMain);
    $("btn-settings").addEventListener("click", openSettings);
    $("btn-open-settings").addEventListener("click", openSettings);
    $("btn-save-all").addEventListener("click", () => saveReviews(currentSongs));

    $("btn-save-settings").addEventListener("click", () => {
      const prev = getSettings();
      const next = {
        scriptUrl: $("set-url").value.trim(),
        secret: $("set-secret").value.trim(),
        days: Math.min(30, Math.max(1, Number($("set-days").value) || CFG.defaultDays)),
      };
      saveSettings(next);
      toast("설정 저장 완료");
      // dialog는 form method=dialog 로 자동으로 닫힘.
      // 목록을 다시 불러오는 건 기간이 바뀌었을 때뿐 — 쓰던 글을 지키기 위해서다
      // (기간이 그대로면 서버 주소만 바뀌어도 화면은 유지된다)
      if (next.days !== prev.days || views.main.hidden) setTimeout(loadMain, 150);
    });

    $("btn-test").addEventListener("click", async () => {
      const el = $("test-result");
      el.textContent = "연결 확인 중…";
      // 아직 저장 안 된 입력값으로 바로 테스트
      const tmp = { scriptUrl: $("set-url").value.trim(), secret: $("set-secret").value.trim() };
      if (!tmp.scriptUrl || !tmp.secret) { el.textContent = "URL과 비밀 토큰을 먼저 입력해 주세요."; return; }
      try {
        const res = await fetch(tmp.scriptUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ secret: tmp.secret, action: "ping" }),
        });
        const data = await res.json();
        el.textContent = data.ok ? `연결 성공 ✓ (저장된 한줄평 ${data.reviews}건)` : "연결 실패: " + (data.error || "알 수 없는 오류");
      } catch (e) {
        el.textContent = "연결 실패: " + friendlyError(e);
      }
    });

    $("btn-logout").addEventListener("click", () => {
      clearTokens();
      $("settings-dialog").close();
      showLogin("Spotify 연결을 해제했어요.");
    });
  }

  /* ---------- 데모 데이터 (?demo=1) ---------- */

  const DEMO_SONGS = [
    { track_id: "demo1", name: "Ready, Get Set, Go!", artists: "PEPPERTONES", album: "Sounds Good!", release_date: "2005-11-10", added_at: new Date(Date.now() - 1 * 864e5).toISOString(), url: "", cover: "" },
    { track_id: "demo2", name: "기억을 걷는 시간", artists: "NELL", album: "Separation Anxiety", release_date: "2008-04-17", added_at: new Date(Date.now() - 2 * 864e5).toISOString(), url: "", cover: "" },
    { track_id: "demo3", name: "Tik Tak Tok", artists: "실리카겔", album: "POWER ANDRE 99", release_date: "2023-12-06", added_at: new Date(Date.now() - 4 * 864e5).toISOString(), url: "", cover: "" },
  ];

  /* ---------- 서비스 워커 ---------- */

  function registerSW() {
    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("sw.js").catch(() => { /* 오프라인 캐시는 없어도 동작 */ });
    }
  }

  /* ---------- 시작 ---------- */

  async function init() {
    bindEvents();
    registerSW();

    const params = new URLSearchParams(location.search);
    if (params.get("demo") === "1") {
      demoMode = true;
      loadMain();
      return;
    }
    if (params.get("error")) {
      history.replaceState({}, "", REDIRECT_URI);
      showLogin("Spotify 로그인이 취소됐어요: " + params.get("error"));
      return;
    }
    if (params.get("code")) {
      showLoading("로그인 처리 중…");
      try {
        await exchangeCode(params.get("code"));
        history.replaceState({}, "", REDIRECT_URI);
      } catch (e) {
        history.replaceState({}, "", REDIRECT_URI);
        showLogin(friendlyError(e));
        return;
      }
    }

    // 토큰 갱신은 네트워크를 타므로 실패해도 빈 화면이 되지 않게 감싼다
    let token = null;
    try {
      token = await getAccessToken();
    } catch (e) {
      showLogin(friendlyError(e) + " 연결 후 다시 열어주세요.");
      return;
    }
    if (!token) { showLogin(); return; }
    loadMain();
  }

  init();
})();
