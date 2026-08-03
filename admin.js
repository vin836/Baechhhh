"use strict";

const OWNER = "vin836";
const REPOSITORY = "Baechhhh";
const BRANCH = "main";
const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
const TRANSCODE_WORKFLOW_FILE = "transcode-video.yml";
const TOKEN_STORAGE_KEY = "baechhhh-video-upload-token";
const JOB_STORAGE_KEY = "baechhhh-video-transcode-job";
const UPLOAD_CHUNK_BYTES = 12 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const JOB_POLL_INTERVAL_MS = 10000;
const JOB_TIMEOUT_MS = 60 * 60 * 1000;

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "mkv", "avi", "webm", "mpeg", "mpg"]);

// 八張卡片。和 app.js 的 VIDEO_COUNT、韌體的 kPuzzleCount 要一致。
const VIDEO_COUNT = 8;
const VIDEO_NODES = Array.from({ length: VIDEO_COUNT }, (_, index) => index + 1);
const VIDEO_PATHS = Object.fromEntries(
  VIDEO_NODES.map((node) => [node, `assets/videos/node-${node}.mp4`]),
);

// ---- 待機背景圖 ----
// 圖片不用像影片那樣送 GitHub Actions 轉檔 —— 在瀏覽器裡用 canvas 縮圖後
// 直接 PUT 上去就好，省掉等 CI 的好幾分鐘。
const IDLE_IMAGE_PATH = "assets/idle.jpg";
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "heic", "heif"]);
const MAX_IMAGE_SOURCE_BYTES = 50 * 1024 * 1024;
// iPad 展示用，超過 2560 寬沒有意義，只會拖慢載入
const IMAGE_MAX_WIDTH = 2560;
const IMAGE_MAX_HEIGHT = 1440;
const IMAGE_JPEG_QUALITY = 0.86;

const state = {
  token: "",
  node: 1,
  selectedFile: null,
  selectedPreviewUrl: "",
  metadata: new Map(),
  busy: false,
  pendingJob: null,
  pollTimer: 0,
  // 背景圖
  selectedImage: null,
  selectedImagePreviewUrl: "",
  imageMetadata: undefined,
  imageBusy: false,
};

const elements = {
  bootScreen: document.querySelector("#bootScreen"),
  tokenScreen: document.querySelector("#tokenScreen"),
  managerScreen: document.querySelector("#managerScreen"),
  tokenForm: document.querySelector("#tokenForm"),
  tokenInput: document.querySelector("#tokenInput"),
  saveTokenButton: document.querySelector("#saveTokenButton"),
  tokenMessage: document.querySelector("#tokenMessage"),
  changeTokenButton: document.querySelector("#changeTokenButton"),
  currentNodeLabel: document.querySelector("#currentNodeLabel"),
  currentVideoInfo: document.querySelector("#currentVideoInfo"),
  currentVideo: document.querySelector("#currentVideo"),
  currentVideoMissing: document.querySelector("#currentVideoMissing"),
  videoFileInput: document.querySelector("#videoFileInput"),
  selectedFileName: document.querySelector("#selectedFileName"),
  newVideoPanel: document.querySelector("#newVideoPanel"),
  newVideo: document.querySelector("#newVideo"),
  newVideoHint: document.querySelector("#newVideoHint"),
  uploadSummary: document.querySelector("#uploadSummary"),
  uploadButton: document.querySelector("#uploadButton"),
  uploadMessage: document.querySelector("#uploadMessage"),
  jobProgress: document.querySelector("#jobProgress"),
  progressTrack: document.querySelector("#progressTrack"),
  progressBar: document.querySelector("#progressBar"),
  progressText: document.querySelector("#progressText"),
  nodeInputs: Array.from(document.querySelectorAll('input[name="node"]')),
  // 背景圖
  currentIdleImage: document.querySelector("#currentIdleImage"),
  currentIdleImageInfo: document.querySelector("#currentIdleImageInfo"),
  currentIdleImageMissing: document.querySelector("#currentIdleImageMissing"),
  imageFileInput: document.querySelector("#imageFileInput"),
  selectedImageName: document.querySelector("#selectedImageName"),
  newImagePanel: document.querySelector("#newImagePanel"),
  newImage: document.querySelector("#newImage"),
  newImageHint: document.querySelector("#newImageHint"),
  uploadImageButton: document.querySelector("#uploadImageButton"),
  imageMessage: document.querySelector("#imageMessage"),
};

function showOnly(screen) {
  elements.bootScreen.hidden = screen !== "boot";
  elements.tokenScreen.hidden = screen !== "token";
  elements.managerScreen.hidden = screen !== "manager";
}

function setMessage(element, text, kind = "info") {
  element.textContent = text;
  element.dataset.kind = kind;
  element.hidden = !text;
}

function setProgress(percent, text) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  elements.jobProgress.hidden = !text;
  elements.progressBar.style.width = `${safePercent}%`;
  elements.progressTrack.setAttribute("aria-valuenow", String(safePercent));
  elements.progressText.textContent = text || "";
}

function friendlyError(error) {
  if (error && error.status === 401) {
    return "Token 無效或已過期，請輸入新的 Token。";
  }
  if (error && error.status === 403) {
    return "這個 Token 權限不足。請確認 Contents 與 Actions 都設為 Read and write。";
  }
  if (error && error.status === 409) {
    return "GitHub 上的檔案剛被更新，請再試一次。";
  }
  if (error && error.status === 422) {
    return "GitHub 無法接受這次上傳，請稍後再試或重新選擇影片。";
  }
  if (error instanceof TypeError) {
    return "目前無法連上 GitHub，請檢查網路後再試一次。";
  }
  return error && error.message ? error.message : "發生問題，請稍後再試。";
}

function createApiError(response, data) {
  const error = new Error(data && data.message ? data.message : `GitHub 回傳 ${response.status}`);
  error.status = response.status;
  error.data = data;
  return error;
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", options.accept || "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${state.token}`);
  headers.set("X-GitHub-Api-Version", API_VERSION);

  if (options.body) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_ROOT}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
    cache: "no-store",
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!response.ok) {
    throw createApiError(response, data);
  }

  return data;
}

async function verifyToken() {
  await apiRequest(`/repos/${OWNER}/${REPOSITORY}`);
}

function humanFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "大小未知";
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${Math.ceil(bytes / 1024)} KB`;
}

function metadataPath(node) {
  return `/repos/${OWNER}/${REPOSITORY}/contents/${VIDEO_PATHS[node]}?ref=${encodeURIComponent(BRANCH)}`;
}

function commitsPath(node) {
  const path = encodeURIComponent(VIDEO_PATHS[node]);
  return `/repos/${OWNER}/${REPOSITORY}/commits?sha=${encodeURIComponent(BRANCH)}&path=${path}&per_page=1`;
}

async function loadVideoMetadata(node) {
  try {
    const metadata = await apiRequest(metadataPath(node));
    const commits = await apiRequest(commitsPath(node));
    const enrichedMetadata = {
      ...metadata,
      revision: Array.isArray(commits) && commits[0] ? commits[0].sha : BRANCH,
    };
    state.metadata.set(node, enrichedMetadata);
    return enrichedMetadata;
  } catch (error) {
    if (error.status === 404) {
      state.metadata.set(node, null);
      return null;
    }
    throw error;
  }
}

function rawVideoUrl(node, revision, contentSha) {
  const encodedPath = VIDEO_PATHS[node].split("/").map(encodeURIComponent).join("/");
  const version = encodeURIComponent(contentSha || Date.now());
  return `https://raw.githubusercontent.com/${OWNER}/${REPOSITORY}/${encodeURIComponent(revision)}/${encodedPath}?v=${version}`;
}

function setCurrentVideo(metadata, node = state.node) {
  if (!metadata) {
    elements.currentVideo.removeAttribute("src");
    elements.currentVideo.load();
    elements.currentVideo.hidden = true;
    elements.currentVideoMissing.hidden = false;
    elements.currentVideoInfo.textContent = "尚未上傳";
    return;
  }

  elements.currentVideo.pause();
  elements.currentVideo.removeAttribute("src");
  elements.currentVideo.load();
  elements.currentVideo.src = rawVideoUrl(node, metadata.revision || BRANCH, metadata.sha);
  elements.currentVideo.hidden = false;
  elements.currentVideoMissing.hidden = true;
  elements.currentVideoInfo.textContent = humanFileSize(metadata.size);
  elements.currentVideo.load();
}

function updateNodeText() {
  const activeNode = state.pendingJob ? state.pendingJob.node : state.node;
  elements.currentNodeLabel.textContent = String(state.node);
  elements.uploadSummary.textContent = state.pendingJob
    ? `GitHub 正在處理「影片 ${activeNode}」。完成後會自動更新。`
    : `轉檔完成後會替換「影片 ${state.node}」。`;

  if (state.pendingJob) {
    elements.uploadButton.textContent = `影片 ${activeNode} 正在自動轉檔…`;
  } else if (state.busy) {
    elements.uploadButton.textContent = `正在上傳影片 ${state.node}…`;
  } else {
    elements.uploadButton.textContent = `上傳並自動轉檔影片 ${state.node}`;
  }
}

function updateControls() {
  const locked = state.busy || Boolean(state.pendingJob);
  elements.nodeInputs.forEach((input) => {
    input.disabled = locked;
  });
  elements.videoFileInput.disabled = locked;
  elements.changeTokenButton.disabled = state.busy;
  elements.uploadButton.disabled = locked || !state.selectedFile;
  updateNodeText();
}

function clearSelectedFile() {
  if (state.selectedPreviewUrl) {
    URL.revokeObjectURL(state.selectedPreviewUrl);
  }
  state.selectedFile = null;
  state.selectedPreviewUrl = "";
  elements.videoFileInput.value = "";
  elements.selectedFileName.textContent = "尚未選擇影片";
  elements.newVideo.removeAttribute("src");
  elements.newVideo.load();
  elements.newVideo.hidden = false;
  elements.newVideoHint.textContent = "如果這個格式無法預覽，仍然可以上傳並自動轉檔。";
  elements.newVideoPanel.hidden = true;
  updateControls();
}

async function selectNode(node) {
  state.node = node;
  clearSelectedFile();
  if (!state.pendingJob) {
    setMessage(elements.uploadMessage, "");
    setProgress(0, "");
  }
  updateNodeText();

  elements.currentVideoInfo.textContent = "讀取中…";
  const cached = state.metadata.get(node);
  if (cached !== undefined) {
    setCurrentVideo(cached, node);
    return;
  }

  try {
    setCurrentVideo(await loadVideoMetadata(node), node);
  } catch (error) {
    elements.currentVideoInfo.textContent = "無法讀取";
    setMessage(elements.uploadMessage, friendlyError(error), "error");
  }
}

function videoExtension(fileName) {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function validateVideo(file) {
  if (!file) {
    throw new Error("請先選擇一個影片。");
  }
  if (!VIDEO_EXTENSIONS.has(videoExtension(file.name)) && !file.type.startsWith("video/")) {
    throw new Error("請選擇影片檔案，例如 MP4、MOV、MKV、AVI 或 WebM。");
  }
  if (file.size <= 0) {
    throw new Error("這個影片是空的，請重新選擇。");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error("影片超過 1 GB，請先縮小檔案再上傳。");
  }
}

function chooseFile(file) {
  try {
    validateVideo(file);
  } catch (error) {
    clearSelectedFile();
    setMessage(elements.uploadMessage, error.message, "error");
    return;
  }

  if (state.selectedPreviewUrl) {
    URL.revokeObjectURL(state.selectedPreviewUrl);
  }

  state.selectedFile = file;
  state.selectedPreviewUrl = URL.createObjectURL(file);
  elements.selectedFileName.textContent = `${file.name} · ${humanFileSize(file.size)}`;
  elements.newVideo.hidden = false;
  elements.newVideo.src = state.selectedPreviewUrl;
  elements.newVideoPanel.hidden = false;
  elements.newVideo.load();
  setMessage(elements.uploadMessage, "");
  setProgress(0, "");
  updateControls();
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 32768;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function textToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text).buffer);
}

function createJobId() {
  const random = new Uint32Array(2);
  crypto.getRandomValues(random);
  return `${Date.now().toString(36)}-${random[0].toString(36)}${random[1].toString(36)}`;
}

function jobManifestPath(jobId) {
  return `.video-jobs/${jobId}.json`;
}

async function dispatchTranscodeWorkflow(jobId) {
  await apiRequest(
    `/repos/${OWNER}/${REPOSITORY}/actions/workflows/${encodeURIComponent(TRANSCODE_WORKFLOW_FILE)}/dispatches`,
    {
      method: "POST",
      body: JSON.stringify({
        ref: BRANCH,
        inputs: { job_id: jobId },
      }),
    },
  );
}

function setBusy(busy) {
  state.busy = busy;
  updateControls();
}

function savePendingJob(job) {
  try {
    localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(job));
  } catch {
    // The current page still tracks the job if browser storage is unavailable.
  }
}

function readPendingJob() {
  try {
    const value = localStorage.getItem(JOB_STORAGE_KEY);
    if (!value) {
      return null;
    }
    const job = JSON.parse(value);
    if (!job || !VIDEO_NODES.includes(job.node) || !job.commitSha || !job.startedAt) {
      localStorage.removeItem(JOB_STORAGE_KEY);
      return null;
    }
    return job;
  } catch {
    return null;
  }
}

function clearPendingJob() {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = 0;
  }
  state.pendingJob = null;
  try {
    localStorage.removeItem(JOB_STORAGE_KEY);
  } catch {
    // The in-memory job is still cleared.
  }
  updateControls();
}

async function createUploadBlob(buffer) {
  const result = await apiRequest(`/repos/${OWNER}/${REPOSITORY}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({
      content: bytesToBase64(buffer),
      encoding: "base64",
    }),
  });
  if (!result || !result.sha) {
    throw new Error("GitHub 沒有回傳上傳結果，請再試一次。");
  }
  return result.sha;
}

async function queueTranscodeJob(node, file, previousSha) {
  const totalChunks = Math.ceil(file.size / UPLOAD_CHUNK_BYTES);
  const chunks = [];

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * UPLOAD_CHUNK_BYTES;
    const end = Math.min(file.size, start + UPLOAD_CHUNK_BYTES);
    const progress = 5 + (index / totalChunks) * 65;
    setProgress(progress, `正在上傳第 ${index + 1}／${totalChunks} 段，請勿關閉此頁…`);
    setMessage(elements.uploadMessage, "影片會分段安全上傳，全部完成後才開始轉檔。");

    const buffer = await file.slice(start, end).arrayBuffer();
    const sha = await createUploadBlob(buffer);
    chunks.push({ sha, size: end - start });
  }

  setProgress(73, "影片上傳完成，正在啟動自動轉檔…");
  const jobId = createJobId();
  const manifest = {
    version: 1,
    id: jobId,
    node,
    original_name: file.name,
    content_type: file.type || "application/octet-stream",
    size: file.size,
    previous_video_sha: previousSha || "",
    requested_at: new Date().toISOString(),
    chunks,
  };
  const jobPath = jobManifestPath(jobId);
  const result = await apiRequest(`/repos/${OWNER}/${REPOSITORY}/contents/${jobPath}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Queue automatic transcode for video ${node}`,
      content: textToBase64(`${JSON.stringify(manifest, null, 2)}\n`),
      branch: BRANCH,
    }),
  });

  if (!result || !result.commit || !result.commit.sha) {
    throw new Error("影片已上傳，但無法啟動轉檔。請再試一次。");
  }

  let dispatchErrorStatus = 0;
  try {
    await dispatchTranscodeWorkflow(jobId);
  } catch (error) {
    // 工作單已安全寫入 GitHub；即使 Token 缺少 Actions 權限，也要保留
    // pendingJob 供頁面追蹤，並讓工作人員可從 Actions 手動補跑。
    dispatchErrorStatus = Number(error && error.status) || -1;
  }

  return {
    id: jobId,
    node,
    previousSha: previousSha || "",
    commitSha: result.commit.sha,
    startedAt: Date.now(),
    dispatchRequested: dispatchErrorStatus === 0,
    dispatchErrorStatus,
  };
}

async function findTranscodeRun(job) {
  try {
    const result = await apiRequest(
      `/repos/${OWNER}/${REPOSITORY}/actions/workflows/${encodeURIComponent(TRANSCODE_WORKFLOW_FILE)}/runs` +
        `?branch=${encodeURIComponent(BRANCH)}&per_page=20`,
    );
    if (!result || !Array.isArray(result.workflow_runs)) {
      return null;
    }
    const matchingCommit = result.workflow_runs.find((run) => run.head_sha === job.commitSha);
    if (matchingCommit) {
      return matchingCommit;
    }

    // fork 的 push 事件可能不會啟動 workflow，必須用 workflow_dispatch 補跑。
    // 手動 run 的 head_sha 不一定等於建立工作單的 commit，因此用開始時間作後備判定。
    const startedAt = Number(job.startedAt) || 0;
    return (
      result.workflow_runs.find(
        (run) =>
          run.event === "workflow_dispatch" &&
          Date.parse(run.created_at || "") >= startedAt - 2 * 60 * 1000,
      ) || null
    );
  } catch (error) {
    if (error.status === 401) {
      throw error;
    }
    return null;
  }
}

async function isJobManifestPending(jobId) {
  try {
    await apiRequest(
      `/repos/${OWNER}/${REPOSITORY}/contents/${jobManifestPath(jobId)}?ref=${encodeURIComponent(BRANCH)}`,
    );
    return true;
  } catch (error) {
    if (error.status === 404) {
      return false;
    }
    throw error;
  }
}

function scheduleJobPoll(delay = JOB_POLL_INTERVAL_MS) {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
  }
  state.pollTimer = window.setTimeout(pollPendingJob, delay);
}

async function finishPendingJob(metadata, job) {
  clearPendingJob();
  state.metadata.set(job.node, metadata);
  setCurrentVideo(metadata, job.node);
  setProgress(100, "自動轉檔完成");
  setMessage(
    elements.uploadMessage,
    `影片 ${job.node} 已轉檔並替換完成。牆內 iPad 最晚約 5 分鐘會自動更新。`,
    "success",
  );
}

async function pollPendingJob() {
  const job = state.pendingJob;
  if (!job) {
    return;
  }

  try {
    const [metadata, manifestPending] = await Promise.all([
      loadVideoMetadata(job.node),
      isJobManifestPending(job.id),
    ]);
    if (metadata && (!manifestPending || (metadata.sha && metadata.sha !== job.previousSha))) {
      await finishPendingJob(metadata, job);
      return;
    }

    const run = await findTranscodeRun(job);
    const elapsed = Date.now() - job.startedAt;
    if (run && run.status === "completed" && run.conclusion !== "success") {
      clearPendingJob();
      setProgress(0, "");
      setMessage(elements.uploadMessage, "GitHub 自動轉檔失敗。請重新選擇影片再試一次。", "error");
      return;
    }
    if (elapsed > JOB_TIMEOUT_MS) {
      clearPendingJob();
      setProgress(0, "");
      setMessage(elements.uploadMessage, "轉檔等待超過一小時，請重新上傳或到 GitHub Actions 查看結果。", "error");
      return;
    }

    if (run && run.status === "queued") {
      setProgress(80, "GitHub 已收到轉檔請求，正在排隊…");
      setMessage(elements.uploadMessage, `影片 ${job.node} 已安全上傳，可以關閉此頁。`, "info");
    } else if (run && run.status === "in_progress") {
      const estimated = Math.min(94, 80 + (elapsed / JOB_TIMEOUT_MS) * 14);
      setProgress(estimated, "GitHub 正在自動轉檔，通常需要幾分鐘…");
      setMessage(elements.uploadMessage, `影片 ${job.node} 已安全上傳，可以關閉此頁。`, "info");
    } else if (run && run.status === "completed") {
      setProgress(95, "轉檔完成，正在更新影片預覽…");
    } else {
      setProgress(78, "影片已上傳，正在等待 GitHub 開始轉檔…");
      setMessage(elements.uploadMessage, `影片 ${job.node} 已安全上傳，可以關閉此頁。`, "info");
    }
  } catch (error) {
    if (error.status === 401) {
      if (state.pollTimer) {
        clearTimeout(state.pollTimer);
      }
      forgetToken();
      showTokenScreen(friendlyError(error));
      return;
    }
    setProgress(78, "暫時無法取得進度，稍後會自動重試…");
  }

  if (state.pendingJob && state.pendingJob.id === job.id) {
    scheduleJobPoll();
  }
}

function startPendingJob(job) {
  state.pendingJob = job;
  savePendingJob(job);
  updateControls();
  if (job.dispatchRequested === false) {
    setProgress(76, "影片已上傳，但 GitHub Actions 無法自動啟動");
    setMessage(
      elements.uploadMessage,
      "工作單已安全保留。請確認 Token 的 Actions 權限設為 Read and write，或到 GitHub Actions 手動執行轉檔。",
      "error",
    );
  } else {
    setProgress(76, "GitHub 已收到轉檔請求，正在排隊…");
    setMessage(elements.uploadMessage, `影片 ${job.node} 已安全上傳，可以關閉此頁。`);
  }
  scheduleJobPoll(2500);
}

async function uploadSelectedVideo() {
  if (state.busy || state.pendingJob || !state.selectedFile) {
    return;
  }

  const node = state.node;
  const file = state.selectedFile;

  try {
    validateVideo(file);
    setBusy(true);
    setProgress(2, "正在準備影片…");
    setMessage(elements.uploadMessage, "請保持此頁開啟，直到所有分段上傳完成。");

    const latestMetadata = await loadVideoMetadata(node);
    const job = await queueTranscodeJob(node, file, latestMetadata ? latestMetadata.sha : "");
    clearSelectedFile();
    startPendingJob(job);
  } catch (error) {
    if (error.status === 401) {
      forgetToken();
      showTokenScreen(friendlyError(error));
      return;
    }
    setProgress(0, "");
    setMessage(elements.uploadMessage, friendlyError(error), "error");
  } finally {
    setBusy(false);
  }
}

// ==================== 待機背景圖 ====================

function imageExtension(fileName) {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function validateImage(file) {
  if (!file) {
    throw new Error("請先選擇一張圖片。");
  }
  if (!IMAGE_EXTENSIONS.has(imageExtension(file.name)) && !file.type.startsWith("image/")) {
    throw new Error("請選擇圖片檔案，例如 JPG、PNG 或 WebP。");
  }
  if (file.size <= 0) {
    throw new Error("這張圖片是空的，請重新選擇。");
  }
  if (file.size > MAX_IMAGE_SOURCE_BYTES) {
    throw new Error("圖片超過 50 MB，請先縮小檔案再上傳。");
  }
}

// 在瀏覽器裡縮圖並轉成 JPEG。這樣不管使用者丟什麼格式（PNG、HEIC、
// 手機拍的 4000px 大圖），最後存進 repo 的都是統一的 assets/idle.jpg。
async function shrinkImageToJpegBytes(file) {
  const bitmap = await createImageBitmap(file);

  const scale = Math.min(
    1,
    IMAGE_MAX_WIDTH / bitmap.width,
    IMAGE_MAX_HEIGHT / bitmap.height,
  );
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  // 透明 PNG 轉 JPEG 會變黑底，先鋪白底比較接近使用者預期
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("圖片轉檔失敗，請換一張圖再試。"))),
      "image/jpeg",
      IMAGE_JPEG_QUALITY,
    );
  });

  return { buffer: await blob.arrayBuffer(), width, height, size: blob.size };
}

function idleImageMetadataPath() {
  return `/repos/${OWNER}/${REPOSITORY}/contents/${IDLE_IMAGE_PATH}?ref=${encodeURIComponent(BRANCH)}`;
}

async function loadIdleImageMetadata() {
  try {
    const metadata = await apiRequest(idleImageMetadataPath());
    state.imageMetadata = metadata;
    return metadata;
  } catch (error) {
    if (error.status === 404) {
      state.imageMetadata = null;
      return null;
    }
    throw error;
  }
}

function setCurrentIdleImage(metadata) {
  if (!metadata) {
    elements.currentIdleImage.removeAttribute("src");
    elements.currentIdleImage.hidden = true;
    elements.currentIdleImageMissing.hidden = false;
    elements.currentIdleImageInfo.textContent = "尚未上傳";
    return;
  }

  const encodedPath = IDLE_IMAGE_PATH.split("/").map(encodeURIComponent).join("/");
  elements.currentIdleImage.src =
    `https://raw.githubusercontent.com/${OWNER}/${REPOSITORY}/${encodeURIComponent(BRANCH)}` +
    `/${encodedPath}?v=${encodeURIComponent(metadata.sha)}`;
  elements.currentIdleImage.hidden = false;
  elements.currentIdleImageMissing.hidden = true;
  elements.currentIdleImageInfo.textContent = humanFileSize(metadata.size);
}

function updateImageControls() {
  const locked = state.imageBusy;
  elements.imageFileInput.disabled = locked;
  elements.uploadImageButton.disabled = locked || !state.selectedImage;
  elements.uploadImageButton.textContent = locked ? "正在上傳背景圖…" : "上傳並更換背景圖";
}

function clearSelectedImage() {
  if (state.selectedImagePreviewUrl) {
    URL.revokeObjectURL(state.selectedImagePreviewUrl);
  }
  state.selectedImage = null;
  state.selectedImagePreviewUrl = "";
  elements.imageFileInput.value = "";
  elements.selectedImageName.textContent = "尚未選擇圖片";
  elements.newImage.removeAttribute("src");
  elements.newImagePanel.hidden = true;
  updateImageControls();
}

function chooseImage(file) {
  try {
    validateImage(file);
  } catch (error) {
    clearSelectedImage();
    setMessage(elements.imageMessage, error.message, "error");
    return;
  }

  if (state.selectedImagePreviewUrl) {
    URL.revokeObjectURL(state.selectedImagePreviewUrl);
  }

  state.selectedImage = file;
  state.selectedImagePreviewUrl = URL.createObjectURL(file);
  elements.selectedImageName.textContent = `${file.name} · ${humanFileSize(file.size)}`;
  elements.newImage.src = state.selectedImagePreviewUrl;
  elements.newImagePanel.hidden = false;
  elements.newImageHint.textContent = "圖片會自動縮小並轉成 JPEG；按下方按鈕後才會上傳。";
  setMessage(elements.imageMessage, "");
  updateImageControls();
}

async function uploadSelectedImage() {
  if (state.imageBusy || !state.selectedImage) {
    return;
  }

  const file = state.selectedImage;

  try {
    validateImage(file);
    state.imageBusy = true;
    updateImageControls();
    setMessage(elements.imageMessage, "正在縮小圖片…");

    const shrunk = await shrinkImageToJpegBytes(file);
    setMessage(
      elements.imageMessage,
      `已縮成 ${shrunk.width}×${shrunk.height}（${humanFileSize(shrunk.size)}），正在上傳…`,
    );

    // 重新讀一次 sha —— 別人剛換過圖的話，用舊的 sha 會被 GitHub 擋下（409）
    const latest = await loadIdleImageMetadata();

    const body = {
      message: "Update idle background image",
      content: bytesToBase64(shrunk.buffer),
      branch: BRANCH,
    };
    if (latest && latest.sha) {
      body.sha = latest.sha;
    }

    await apiRequest(`/repos/${OWNER}/${REPOSITORY}/contents/${IDLE_IMAGE_PATH}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });

    clearSelectedImage();
    setCurrentIdleImage(await loadIdleImageMetadata());
    setMessage(
      elements.imageMessage,
      "背景圖已更換。牆內 iPad 最晚約 5 分鐘會自動更新，不用手動重整。",
      "success",
    );
  } catch (error) {
    if (error.status === 401) {
      forgetToken();
      showTokenScreen(friendlyError(error));
      return;
    }
    setMessage(elements.imageMessage, friendlyError(error), "error");
  } finally {
    state.imageBusy = false;
    updateImageControls();
  }
}

function saveTokenLocally(token) {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

function readSavedToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function forgetToken() {
  state.token = "";
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // The in-memory token is still cleared when browser storage is unavailable.
  }
}

function showTokenScreen(message = "") {
  showOnly("token");
  elements.tokenInput.value = "";
  elements.tokenInput.focus();
  setMessage(elements.tokenMessage, message, message ? "error" : "info");
}

async function openManager() {
  const savedJob = state.pendingJob || readPendingJob();
  if (savedJob) {
    state.pendingJob = savedJob;
    state.node = savedJob.node;
    const selectedInput = elements.nodeInputs.find((input) => Number(input.value) === savedJob.node);
    if (selectedInput) {
      selectedInput.checked = true;
    }
  }

  showOnly("manager");
  updateControls();
  await selectNode(state.node);

  // 只預載目前選的那一格。八格全載會一口氣發 16 次 API 請求，
  // 容易撞到 GitHub 的速率限制；其餘的等使用者點到再載。

  elements.currentIdleImageInfo.textContent = "讀取中…";
  updateImageControls();
  loadIdleImageMetadata()
    .then(setCurrentIdleImage)
    .catch((error) => {
      elements.currentIdleImageInfo.textContent = "無法讀取";
      setMessage(elements.imageMessage, friendlyError(error), "error");
    });

  if (state.pendingJob) {
    startPendingJob(state.pendingJob);
  }
}

async function handleTokenSubmit(event) {
  event.preventDefault();
  const token = elements.tokenInput.value.trim();
  if (!token) {
    setMessage(elements.tokenMessage, "請貼上 GitHub Token。", "error");
    return;
  }

  state.token = token;
  elements.saveTokenButton.disabled = true;
  elements.saveTokenButton.textContent = "正在確認…";
  setMessage(elements.tokenMessage, "正在連接 GitHub…");

  try {
    await verifyToken();
    try {
      saveTokenLocally(token);
    } catch {
      setMessage(elements.tokenMessage, "瀏覽器無法記住 Token，但這次仍可繼續使用。", "error");
    }
    await openManager();
  } catch (error) {
    forgetToken();
    setMessage(elements.tokenMessage, friendlyError(error), "error");
  } finally {
    elements.saveTokenButton.disabled = false;
    elements.saveTokenButton.textContent = "儲存並開始";
  }
}

async function initialize() {
  const savedToken = readSavedToken();
  state.pendingJob = readPendingJob();
  if (!savedToken) {
    showTokenScreen();
    return;
  }

  state.token = savedToken;
  showOnly("boot");
  try {
    await verifyToken();
    await openManager();
  } catch (error) {
    forgetToken();
    showTokenScreen(friendlyError(error));
  }
}

elements.tokenForm.addEventListener("submit", handleTokenSubmit);

elements.changeTokenButton.addEventListener("click", () => {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = 0;
  }
  forgetToken();
  clearSelectedFile();
  clearSelectedImage();
  showTokenScreen();
});

elements.nodeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked && !state.pendingJob) {
      selectNode(Number(input.value));
    }
  });
});

elements.videoFileInput.addEventListener("change", () => {
  chooseFile(elements.videoFileInput.files && elements.videoFileInput.files[0]);
});

elements.newVideo.addEventListener("loadedmetadata", () => {
  elements.newVideo.hidden = false;
  elements.newVideoHint.textContent = "影片已準備好；按下方按鈕後才會上傳。";
});

elements.newVideo.addEventListener("error", () => {
  if (state.selectedFile) {
    elements.newVideo.hidden = true;
    elements.newVideoHint.textContent = "此格式無法在瀏覽器預覽，但仍然可以上傳並自動轉檔。";
  }
});

elements.uploadButton.addEventListener("click", uploadSelectedVideo);

elements.imageFileInput.addEventListener("change", () => {
  chooseImage(elements.imageFileInput.files && elements.imageFileInput.files[0]);
});

elements.uploadImageButton.addEventListener("click", uploadSelectedImage);

window.addEventListener("beforeunload", () => {
  if (state.selectedPreviewUrl) {
    URL.revokeObjectURL(state.selectedPreviewUrl);
  }
  if (state.selectedImagePreviewUrl) {
    URL.revokeObjectURL(state.selectedImagePreviewUrl);
  }
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
  }
});

initialize();
