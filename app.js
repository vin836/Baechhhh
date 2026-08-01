const MQTT_URL = "wss://broker.hivemq.com:8884/mqtt";
const CONTROL_TOPIC = "axoled-student/baechhhh/20260721/video/control/v1";
const VIDEO_UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const IDLE_IMAGE_PATH = "assets/idle.jpg";

const videos = {
  1: { src: "assets/videos/node-1.mp4", name: "影片一" },
  2: { src: "assets/videos/node-2.mp4", name: "影片二" },
  3: { src: "assets/videos/node-3.mp4", name: "影片三" },
};

const stage = document.querySelector(".stage");
const mainVideo = document.querySelector("#mainVideo");
const idleImage = document.querySelector("#idleImage");
const connection = document.querySelector("#connection");
const connectionText = document.querySelector("#connectionText");
const soundSetup = document.querySelector("#soundSetup");
const enableSoundButton = document.querySelector("#enableSoundButton");
const soundError = document.querySelector("#soundError");

let currentNode = 0;
let idleTimer = null;
let soundUnlocked = false;

// 連線正常時整個提示隱藏（CSS 的 .connected 會把它藏起來），
// 待機畫面上就只剩背景圖。斷線才浮出紅色小標提醒工作人員。
function setConnection(state, label) {
  connection.classList.toggle("connected", state === "connected");
  connectionText.textContent = label;
}

async function showNode(node) {
  const selected = videos[node];
  if (!selected) return;
  if (currentNode === node && !stage.classList.contains("finished")) return;

  clearTimeout(idleTimer);
  currentNode = node;
  stage.classList.remove("finished");
  mainVideo.src = selected.src;
  mainVideo.muted = !soundUnlocked;
  mainVideo.volume = 1;
  mainVideo.load();
  stage.classList.add("has-video");
  document.body.classList.add("video-playing");
  try {
    await mainVideo.play();
  } catch {
    soundUnlocked = false;
    mainVideo.muted = true;
    soundSetup.classList.remove("hidden");
    soundError.textContent = "瀏覽器需要重新啟用聲音。";
    mainVideo.play().catch(() => {});
  }
}

function showIdle() {
  clearTimeout(idleTimer);
  currentNode = 0;
  mainVideo.pause();
  mainVideo.removeAttribute("src");
  mainVideo.load();
  stage.classList.remove("has-video", "finished");
  document.body.classList.remove("video-playing");
}

function showFinished() {
  mainVideo.pause();
  stage.classList.remove("has-video");
  stage.classList.add("finished");
  document.body.classList.remove("video-playing");
}

mainVideo.addEventListener("ended", showFinished);

async function enableSound() {
  enableSoundButton.disabled = true;
  enableSoundButton.textContent = "正在開啟…";
  soundError.textContent = "";

  try {
    const wasPlaying = currentNode !== 0 && !mainVideo.paused;

    if (wasPlaying) {
      mainVideo.muted = false;
      mainVideo.volume = 1;
      await mainVideo.play();
    } else {
      mainVideo.src = videos[1].src;
      mainVideo.muted = false;
      mainVideo.volume = 1;
      await mainVideo.play();
      mainVideo.pause();
      mainVideo.currentTime = 0;
      mainVideo.removeAttribute("src");
      mainVideo.load();
    }

    soundUnlocked = true;
    soundSetup.classList.add("hidden");
  } catch (error) {
    console.error("Sound unlock failed:", error);
    soundUnlocked = false;
    mainVideo.muted = true;
    soundError.textContent = "無法開啟聲音，請確認 iPad 音量後再試一次。";
  } finally {
    enableSoundButton.disabled = false;
    enableSoundButton.textContent = "開啟聲音並開始體驗";
  }
}

enableSoundButton.addEventListener("click", enableSound);

function handleControlMessage(rawMessage) {
  const [action, rawNode] = rawMessage.trim().toUpperCase().split("|");
  const node = Number(rawNode);

  if (action === "ON" && videos[node]) {
    clearTimeout(idleTimer);
    showNode(node);
    return;
  }

  if (action === "OFF") {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(showIdle, 250);
  }
}

function askServiceWorker(worker, type) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("Service worker timeout")), 30000);

    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      if (event.data?.ok) resolve(event.data);
      else reject(new Error(event.data?.error || "Video cache failed"));
    };

    worker.postMessage({ type }, [channel.port2]);
  });
}

// 待機背景圖可由管理頁更換。用 HEAD 比對 ETag，發現換了就換掉 img.src，
// 不重新整理整頁 —— 重整會中斷正在播的影片，也會讓聲音解鎖失效。
let idleImageSignature = "";

async function checkIdleImageUpdate() {
  try {
    const response = await fetch(IDLE_IMAGE_PATH, { method: "HEAD", cache: "no-store" });
    if (!response.ok) return;

    const signature =
      response.headers.get("ETag") ||
      `${response.headers.get("Last-Modified") || ""}:${response.headers.get("Content-Length") || ""}`;

    if (!idleImageSignature) {
      idleImageSignature = signature;
      return;
    }

    if (signature !== idleImageSignature) {
      idleImageSignature = signature;
      // 加上查詢字串繞過瀏覽器快取，強制抓新圖
      idleImage.src = `${IDLE_IMAGE_PATH}?v=${encodeURIComponent(signature)}`;
    }
  } catch {
    // 網路不通就算了，下一輪會再試
  }
}

async function prepareBackgroundCache() {
  if (!("serviceWorker" in navigator)) return;

  let hasController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hasController && !reloading) {
      reloading = true;
      window.location.reload();
    }
    hasController = true;
  });

  try {
    const registration = await navigator.serviceWorker.register("./sw.js", {
      scope: "./",
      updateViaCache: "none",
    });
    await navigator.serviceWorker.ready;

    const worker = registration.active || navigator.serviceWorker.controller;
    if (!worker) return;

    const status = await askServiceWorker(worker, "VIDEO_CACHE_STATUS");
    if (!status.ready) await askServiceWorker(worker, "CACHE_VIDEOS");

    const checkVideoUpdates = () =>
      askServiceWorker(worker, "CHECK_VIDEO_UPDATES").catch((error) =>
        console.error("Background video update check failed:", error),
      );

    window.setInterval(checkVideoUpdates, VIDEO_UPDATE_CHECK_INTERVAL_MS);
    window.setInterval(() => registration.update(), UPDATE_CHECK_INTERVAL_MS);
  } catch (error) {
    console.error("Background cache setup failed:", error);
  }
}

prepareBackgroundCache();

// 背景圖跟影片用同一個檢查週期（5 分鐘）
checkIdleImageUpdate();
window.setInterval(checkIdleImageUpdate, VIDEO_UPDATE_CHECK_INTERVAL_MS);

if (!window.mqtt) {
  setConnection("connecting", "連線元件載入失敗");
} else {
  const randomId = crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10);
  const clientId = `baechhhh-tablet-${randomId}`;
  const client = mqtt.connect(MQTT_URL, {
    clientId,
    clean: true,
    connectTimeout: 8000,
    reconnectPeriod: 2500,
    keepalive: 30,
  });

  client.on("connect", () => {
    setConnection("connected", "已連線");
    client.subscribe(CONTROL_TOPIC, { qos: 0 });
  });

  client.on("reconnect", () => setConnection("connecting", "重新連線中…"));
  client.on("offline", () => setConnection("connecting", "連線中斷"));
  client.on("error", () => setConnection("connecting", "連線中斷"));

  client.on("message", (topic, payload, packet) => {
    if (topic !== CONTROL_TOPIC) return;

    // A retained MQTT message is an old state replayed by the broker when this
    // page subscribes. Ignore it so refreshing the display always starts idle.
    if (packet.retain) {
      showIdle();
      return;
    }

    handleControlMessage(payload.toString());
  });
}
