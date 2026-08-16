/* 오프라인에서도 앱 껍데기는 열리도록 하는 최소한의 서비스 워커.
   네트워크 우선이라 새 버전을 올리면 즉시 반영된다. */
const CACHE = "review-app-v1";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // 같은 출처의 GET 요청(앱 껍데기)만 다룬다 — Spotify/Apps Script 요청은 건드리지 않는다
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // 성공한 응답만 캐시한다 — 배포 중 잠깐 뜨는 404를 저장해두면
        // 다음 오프라인 실행 때 그 404가 app.js 자리에 들어와 앱이 죽는다
        if (res.ok) {
          const copy = res.clone();
          // ?code=... 같은 일회용 주소가 캐시에 쌓이지 않도록 화면 진입은 한 키로 모은다
          const key = e.request.mode === "navigate" ? "./index.html" : e.request;
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((hit) => hit || (e.request.mode === "navigate" ? caches.match("./index.html") : undefined))
      )
  );
});
