const CACHE_PREFIX = "baechhhh-video-";
const CACHE_NAME = `${CACHE_PREFIX}2026-08-01-v9`;

// 八張卡片。和 app.js 的 VIDEO_COUNT、韌體的 kPuzzleCount 要一致。
const VIDEO_COUNT = 8;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./assets/idle.jpg",
  "./vendor/mqtt.min.js",
];

const VIDEO_PATHS = Array.from(
  { length: VIDEO_COUNT },
  (_, index) => `./assets/videos/node-${index + 1}.mp4`,
);

// 待機背景圖。可由管理頁更換，所以走「網路優先」而不是快取優先 ——
// 快取優先的話管理頁換了圖，iPad 這邊會一直拿到舊的。
const IDLE_IMAGE_PATH = "./assets/idle.jpg";

const absoluteUrl = (path) => new URL(path, self.registration.scope).href;

async function fetchAndCacheAppShell() {
  const cache = await caches.open(CACHE_NAME);

  for (const path of APP_SHELL) {
    const url = absoluteUrl(path);
    const response = await fetch(url, { cache: "reload" });
    if (!response.ok) throw new Error(`Could not cache ${path}: HTTP ${response.status}`);
    await cache.put(url, response);
  }
}

// 尚未上傳的影片會回 404。這是正常狀態（八格不一定都放滿），
// 所以只跳過該檔，不能讓整批快取失敗 —— 否則一格沒放就全部離線功能都沒了。
async function fetchAndCacheVideos(forceRefresh = false) {
  const cache = await caches.open(CACHE_NAME);
  let cached = 0;

  for (const path of VIDEO_PATHS) {
    const url = absoluteUrl(path);
    try {
      const response = await fetch(url, {
        cache: forceRefresh ? "reload" : "default",
      });
      if (response.ok) {
        await cache.put(url, response);
        cached += 1;
      }
    } catch {
      // 網路問題，下一輪檢查會再試
    }
  }

  return cached;
}

// 「準備好」的定義：線上存在的影片都已快取。
// 不能要求八支全部命中 —— 只放三支影片是完全合理的佈展方式。
async function videoCacheReady() {
  const cache = await caches.open(CACHE_NAME);
  const matches = await Promise.all(
    VIDEO_PATHS.map((path) => cache.match(absoluteUrl(path))),
  );
  return matches.some(Boolean);
}

function responseSignature(response) {
  if (!response) return "";
  return (
    response.headers.get("ETag") ||
    `${response.headers.get("Last-Modified") || ""}:${response.headers.get("Content-Length") || ""}`
  );
}

async function checkVideoUpdates() {
  const cache = await caches.open(CACHE_NAME);
  let updated = 0;

  for (const path of VIDEO_PATHS) {
    const url = absoluteUrl(path);
    try {
      const cached = await cache.match(url);
      // 尚未上傳的影片會回 404，跳過即可
      const liveHeaders = await fetch(url, { method: "HEAD", cache: "no-store" });
      if (!liveHeaders.ok) continue;

      if (!cached || responseSignature(cached) !== responseSignature(liveHeaders)) {
        const freshVideo = await fetch(url, { cache: "reload" });
        if (freshVideo.ok) {
          await cache.put(url, freshVideo);
          updated += 1;
        }
      }
    } catch {
      // 單支影片的網路錯誤不該中斷其他七支的檢查
    }
  }

  return updated;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await fetchAndCacheAppShell();
      await fetchAndCacheVideos(true);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const reply = (message) => event.ports[0]?.postMessage(message);

  if (event.data?.type === "VIDEO_CACHE_STATUS") {
    event.waitUntil(
      videoCacheReady()
        .then((ready) => reply({ ok: true, ready }))
        .catch((error) => reply({ ok: false, error: error.message })),
    );
  }

  if (event.data?.type === "CACHE_VIDEOS" || event.data?.type === "REFRESH_VIDEOS") {
    const forceRefresh = event.data.type === "REFRESH_VIDEOS";
    event.waitUntil(
      fetchAndCacheVideos(forceRefresh)
        .then(() => reply({ ok: true, ready: true }))
        .catch((error) => reply({ ok: false, error: error.message })),
    );
  }

  if (event.data?.type === "CHECK_VIDEO_UPDATES") {
    event.waitUntil(
      checkVideoUpdates()
        .then((updated) => reply({ ok: true, updated }))
        .catch((error) => reply({ ok: false, error: error.message })),
    );
  }
});

function parseRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");
  if (!match) return null;

  let start = match[1] === "" ? null : Number(match[1]);
  let end = match[2] === "" ? null : Number(match[2]);

  if (start === null && end !== null) {
    start = Math.max(size - end, 0);
    end = size - 1;
  } else {
    start ??= 0;
    end ??= size - 1;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

async function getCompleteVideo(request) {
  const cache = await caches.open(CACHE_NAME);
  let response = await cache.match(request.url);

  if (!response) {
    const headers = new Headers(request.headers);
    headers.delete("range");
    response = await fetch(new Request(request.url, { headers, cache: "no-cache" }));
    if (response.ok) await cache.put(request.url, response.clone());
  }

  return response;
}

async function serveVideo(request) {
  const response = await getCompleteVideo(request);
  if (!response || !response.ok || !request.headers.has("range")) return response;

  const bytes = await response.arrayBuffer();
  const range = parseRange(request.headers.get("range"), bytes.byteLength);

  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${bytes.byteLength}` },
    });
  }

  const chunk = bytes.slice(range.start, range.end + 1);
  return new Response(chunk, {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
      "Content-Length": String(chunk.byteLength),
      "Content-Type": response.headers.get("Content-Type") || "video/mp4",
    },
  });
}

// 網路優先。抓得到就用新的並更新快取；抓不到（離線）才退回快取。
// 快取一律存不帶查詢字串的網址，離線時 ?v=xxx 的請求也命中得到。
async function serveIdleImage(request) {
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = absoluteUrl(IDLE_IMAGE_PATH);

  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok) {
      await cache.put(cacheKey, response.clone());
      return response;
    }
  } catch {
    // 離線，往下走快取
  }

  const cached = await cache.match(cacheKey);
  return cached || Response.error();
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;

  const isVideo = VIDEO_PATHS.some((path) => requestUrl.href === absoluteUrl(path));
  if (isVideo) {
    event.respondWith(serveVideo(request));
    return;
  }

  // 背景圖：網路優先，成功就順便更新快取；離線才退回快取版本。
  // 比對 pathname 而非完整網址 —— app.js 會加 ?v=<etag> 繞過瀏覽器快取。
  if (requestUrl.pathname === new URL(absoluteUrl(IDLE_IMAGE_PATH)).pathname) {
    event.respondWith(serveIdleImage(request));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request)),
  );
});
