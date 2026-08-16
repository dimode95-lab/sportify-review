/* 이번주 한줄평 — 한 주간 새로 좋아요한 Spotify 곡에 한줄평을 남기는 앱 */
(() => {
  "use strict";

  const CFG = window.APP_CONFIG;
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
    try { return JSON.parse(localStorage.getItem(LS.drafts) || "{}"); } catch (e) { return {}; }
  }
  function setDraft(trackId, text) {
    const d = getDrafts();
    if (text) d[trackId] = text; else delete d[trackId];
    localStorage.setItem(LS.drafts, JSON.stringify(d));
  }
  function clearDrafts(trackIds) {
    const d = getDrafts();
    trackIds.forEach((id) => delete d[id]);
    localStorage.setItem(LS.drafts, JSON.stringify(d));
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
    showLoading("이번 주 좋아요 곡을 불러오는 중…");
    const days = getSettings().days;
    try {
      const [likes, reviewed] = await Promise.all([
        demoMode ? Promise.resolve({ songs: DEMO_SONGS, truncated: false }) : fetchRecentLikes(days),
        demoMode ? Promise.resolve({ ids: new Set(), remoteOk: true }) : fetchReviewedIds(),
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
    show("main");
    $("config-banner").hidden = apiConfigured() || demoMode;

    const doneCount = totalCount - fresh.length;
    const notes = [];
    if (!remoteOk && !demoMode) notes.push("기록 서버 연결 안 됨");
    if (truncated) notes.push(`최근 ${MAX_PAGES * 50}곡까지만 표시`);
    $("summary").textContent = totalCount
      ? `최근 ${days}일 새 좋아요 ${totalCount}곡 · 한줄평 완료 ${doneCount}곡` + (notes.length ? ` (${notes.join(", ")})` : "")
      : "";

    const list = $("song-list");
    list.innerHTML = "";
    const empty = $("empty-state");

    if (!fresh.length) {
      empty.hidden = false;
      empty.innerHTML = totalCount
        ? "최근 좋아요한 곡에 전부 한줄평을 남겼어요 🎉"
        : `최근 ${days}일간 새로 좋아요한 곡이 없어요 🎧<br>⚙ 설정에서 기간을 늘려볼 수 있어요.`;
      $("btn-save-all").hidden = true;
      return;
    }
    empty.hidden = true;

    const drafts = getDrafts();
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
        <div class="review-row">
          <textarea class="review-input" rows="1" placeholder="한 줄 감상…" maxlength="300"></textarea>
          <button class="save-btn" disabled>저장</button>
        </div>`;

      const input = card.querySelector(".review-input");
      const btn = card.querySelector(".save-btn");
      const autosize = () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; };

      input.value = drafts[song.track_id] || ""; // 쓰다 만 글 복원
      btn.disabled = !input.value.trim();

      input.addEventListener("input", () => {
        btn.disabled = !input.value.trim();
        autosize();
        setDraft(song.track_id, input.value.trim());
        updateSaveAll();
      });
      btn.addEventListener("click", () => saveReviews([song], card));
      list.appendChild(card);
      if (input.value) autosize(); // DOM에 붙은 뒤라야 높이가 잡힌다
    }
    updateSaveAll();
  }

  function updateSaveAll() {
    const pending = [...document.querySelectorAll(".song-card:not(.saved)")]
      .filter((c) => c.querySelector(".review-input").value.trim()).length;
    const btn = $("btn-save-all");
    btn.hidden = pending < 2;
    btn.textContent = `작성한 한줄평 모두 저장 (${pending}곡)`;
  }

  function cardFor(trackId) {
    return document.querySelector(`.song-card[data-track-id="${CSS.escape(trackId)}"]`);
  }

  async function saveReviews(songs, singleCard) {
    const payload = [];
    for (const song of songs) {
      const card = singleCard || cardFor(song.track_id);
      if (!card || card.classList.contains("saved")) continue;
      const text = card.querySelector(".review-input").value.trim();
      if (!text) continue;
      payload.push({
        track_id: song.track_id,
        name: song.name,
        artists: song.artists,
        album: song.album,
        release_date: song.release_date,
        added_at: song.added_at,
        url: song.url,
        review: text,
      });
    }
    if (!payload.length) return;

    if (demoMode) {
      const ids = payload.map((p) => p.track_id);
      clearDrafts(ids);
      markSaved(ids);
      toast("(데모) 저장된 셈 치기 완료");
      return;
    }

    try {
      if (!apiConfigured()) { toast("먼저 ⚙ 설정에서 저장 서버를 연결해 주세요."); $("settings-dialog").showModal(); return; }
      const buttons = payload.map((p) => cardFor(p.track_id)).filter(Boolean).map((c) => c.querySelector(".save-btn"));
      buttons.forEach((b) => { b.disabled = true; b.textContent = "저장 중…"; });
      const r = await api("add", { reviews: payload });
      const ids = payload.map((p) => p.track_id);
      addSubmitted(ids);
      clearDrafts(ids);
      markSaved(ids);
      toast(`한줄평 ${(r.added || 0) + (r.updated || 0)}곡 저장 완료 ✓`);
    } catch (e) {
      document.querySelectorAll(".song-card:not(.saved) .save-btn").forEach((b) => {
        b.textContent = "저장";
        b.disabled = !b.closest(".song-card").querySelector(".review-input").value.trim();
      });
      toast("저장 실패: " + friendlyError(e), 4000);
    }
  }

  function markSaved(trackIds) {
    for (const id of trackIds) {
      const card = cardFor(id);
      if (!card) continue;
      card.classList.add("saved");
      card.querySelector(".review-input").disabled = true;
      const btn = card.querySelector(".save-btn");
      btn.disabled = true;
      btn.textContent = "✓ 저장됨";
      btn.classList.add("done");
    }
    const doneNow = document.querySelectorAll(".song-card.saved").length;
    const total = currentSongs.length;
    if (doneNow >= total && total > 0) {
      $("summary").textContent = `오늘 몫 끝! 한줄평 ${doneNow}곡 저장 완료 🎉`;
    }
    updateSaveAll();
  }

  /* ---------- 지난 기록 ---------- */

  async function loadHistory() {
    if (demoMode) { show("history"); $("history-list").innerHTML = `<p class="empty">데모 모드에서는 기록이 없어요.</p>`; return; }
    if (!apiConfigured()) { toast("먼저 ⚙ 설정에서 저장 서버를 연결해 주세요."); return; }
    showLoading("지난 기록을 불러오는 중…");
    try {
      const data = await api("list", { limit: 50 });
      show("history");
      const list = $("history-list");
      list.innerHTML = "";
      if (!data.reviews.length) {
        list.innerHTML = `<p class="empty">아직 저장된 한줄평이 없어요.</p>`;
        return;
      }
      for (const r of data.reviews) {
        const div = document.createElement("div");
        div.className = "history-item";
        div.innerHTML = `
          <div class="song-title">${escapeHtml(r.track_name)} <span class="song-sub">— ${escapeHtml(r.artists)}</span></div>
          <div class="history-review">${escapeHtml(r.review)}</div>
          <div class="history-date">${escapeHtml(String(r.saved_at).slice(0, 10))}</div>`;
        list.appendChild(div);
      }
    } catch (e) {
      show("main");
      toast("기록 불러오기 실패: " + friendlyError(e), 4000);
    }
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
