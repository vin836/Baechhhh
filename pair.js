const MQTT_URL = "wss://broker.hivemq.com:8884/mqtt";

// 三個配對用主題，和韌體 Config 區塊的 kScanTopic / kCommandTopic / kTagsTopic 對應
const SCAN_TOPIC = "axoled-student/baechhhh/20260721/nfc/scan/v1";
const COMMAND_TOPIC = "axoled-student/baechhhh/20260721/nfc/command/v1";
const TAGS_TOPIC = "axoled-student/baechhhh/20260721/nfc/tags/v1";
const STATUS_TOPIC = "axoled-student/baechhhh/20260721/device/status/v1";

// 和 app.js 的 VIDEO_COUNT、韌體的 kPuzzleCount 要一致
const VIDEO_COUNT = 8;

// 按下編號後等 ESP32 回傳新標籤表的時限。逾時就提示使用者重刷。
const ASSIGN_TIMEOUT_MS = 8000;

const connection = document.querySelector("#connection");
const connectionText = document.querySelector("#connectionText");
const lastUid = document.querySelector("#lastUid");
const lastUidStatus = document.querySelector("#lastUidStatus");
const assignHint = document.querySelector("#assignHint");
const assignGrid = document.querySelector("#assignGrid");
const tagTable = document.querySelector("#tagTable");
const refreshButton = document.querySelector("#refreshButton");
const clearAllButton = document.querySelector("#clearAllButton");
const eventLog = document.querySelector("#eventLog");

let client = null;
let ready = false;
// 最近刷到的 UID。按編號時要確認確實有刷過卡，否則 ESP32 會空等。
let pendingUid = "";
let assignTimer = 0;
let assigningNode = 0;
let tags = new Map();

function setConnected(isReady, label, isError = false) {
  ready = isReady;
  connection.classList.toggle("ready", isReady);
  connection.classList.toggle("error", isError);
  connectionText.textContent = label;
  refreshButton.disabled = !isReady;
  clearAllButton.disabled = !isReady;
  updateAssignButtons();
}

function addLog(message) {
  const first = eventLog.firstElementChild;
  if (eventLog.children.length === 1 && first && first.textContent.includes("等待")) {
    eventLog.replaceChildren();
  }

  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString("zh-TW", { hour12: false });
  item.append(time, `　${message}`);
  eventLog.prepend(item);

  while (eventLog.children.length > 8) eventLog.lastElementChild.remove();
}

// UID 在 MQTT 上是連續十六進位（04A23B91），顯示時每兩位加空格比較好對照
function prettyUid(rawUid) {
  return rawUid.replace(/(.{2})/g, "$1 ").trim();
}

function publish(message) {
  if (!client || !client.connected) return false;
  client.publish(COMMAND_TOPIC, message, { qos: 0, retain: false });
  return true;
}

// ---------------- 標籤表 ----------------

// 韌體送來的格式：1:04A23B91;2:-;3:047C1E55;...
function parseTagTable(payload) {
  const parsed = new Map();

  for (const chunk of payload.split(";")) {
    const [rawNode, rawUid] = chunk.split(":");
    const node = Number(rawNode);
    if (!Number.isInteger(node) || node < 1 || node > VIDEO_COUNT) continue;
    parsed.set(node, rawUid && rawUid !== "-" ? rawUid : "");
  }

  return parsed;
}

function renderTagTable() {
  const rows = [];

  for (let node = 1; node <= VIDEO_COUNT; node += 1) {
    const uid = tags.get(node) || "";
    const row = document.createElement("li");
    row.className = uid ? "tag-row" : "tag-row empty";

    const number = document.createElement("span");
    number.className = "tag-number";
    number.textContent = String(node);

    const value = document.createElement("code");
    value.textContent = uid ? prettyUid(uid) : "未配對";

    row.append(number, value);

    if (uid) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "clear-button";
      clear.textContent = "清除";
      clear.disabled = !ready;
      clear.addEventListener("click", () => clearNode(node));
      row.append(clear);
    }

    rows.push(row);
  }

  tagTable.replaceChildren(...rows);
}

// ---------------- 配對 ----------------

function updateAssignButtons() {
  const buttons = assignGrid.querySelectorAll("button");
  buttons.forEach((button) => {
    button.disabled = !ready || !pendingUid || assigningNode !== 0;
  });
}

function buildAssignGrid() {
  const buttons = [];

  for (let node = 1; node <= VIDEO_COUNT; node += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `assign-button node-${node}`;
    button.disabled = true;

    const number = document.createElement("span");
    number.textContent = String(node);
    const label = document.createElement("strong");
    label.textContent = `影片 ${node}`;

    button.append(number, label);
    button.addEventListener("click", () => assignToNode(node));
    buttons.push(button);
  }

  assignGrid.replaceChildren(...buttons);
}

function finishAssign(message, isError = false) {
  window.clearTimeout(assignTimer);
  assignTimer = 0;
  assigningNode = 0;
  assignHint.textContent = message;
  assignHint.classList.toggle("error", isError);
  updateAssignButtons();
}

function assignToNode(node) {
  if (!ready || !pendingUid || assigningNode !== 0) return;

  assigningNode = node;
  assignHint.classList.remove("error");
  assignHint.textContent = `正在把 ${prettyUid(pendingUid)} 配給影片 ${node}…`;
  updateAssignButtons();

  // ESP32 收到 LEARN 後會等下一張刷到的卡。使用者剛才刷的那張已經離開感應區，
  // 所以要請他們再刷一次 —— 這是 RC522 的限制，卡片必須重新進入感應區。
  if (!publish(`LEARN|${node}`)) {
    finishAssign("送不出指令，請確認連線後再試。", true);
    return;
  }

  assignHint.textContent = `請把標籤「${prettyUid(pendingUid)}」再靠近讀卡器一次，完成配對。`;
  addLog(`要求配對：影片 ${node} ← ${prettyUid(pendingUid)}`);

  assignTimer = window.setTimeout(() => {
    publish("LEARN|0");
    finishAssign("等太久了，配對已取消。請重刷標籤再試一次。", true);
    addLog(`配對逾時：影片 ${node}`);
  }, ASSIGN_TIMEOUT_MS);
}

function clearNode(node) {
  if (!ready) return;
  if (!window.confirm(`確定要清除影片 ${node} 的標籤嗎？`)) return;

  publish(`CLEAR|${node}`);
  addLog(`清除影片 ${node} 的標籤`);
}

function clearAllTags() {
  if (!ready) return;
  if (!window.confirm("確定要清除全部 8 個標籤嗎？這個動作無法復原。")) return;

  publish("CLEARALL");
  addLog("清除全部標籤");
}

// ---------------- MQTT ----------------

function handleScanMessage(payload) {
  // 格式：UID|已登記為第幾號（0 = 未登記）
  const [rawUid, rawMatched] = payload.split("|");
  if (!rawUid) return;

  pendingUid = rawUid;
  const matched = Number(rawMatched) || 0;

  lastUid.textContent = prettyUid(rawUid);
  lastUidStatus.textContent = matched
    ? `目前已配給影片 ${matched}`
    : "尚未配對";
  lastUidStatus.classList.toggle("assigned", matched > 0);

  addLog(`刷到標籤 ${prettyUid(rawUid)}${matched ? `（影片 ${matched}）` : ""}`);

  if (assigningNode === 0) {
    assignHint.classList.remove("error");
    assignHint.textContent = "選一個編號，把這張標籤配給該影片。";
  }

  updateAssignButtons();
}

function handleTagsMessage(payload) {
  tags = parseTagTable(payload);
  renderTagTable();

  // 標籤表更新代表 ESP32 已經處理完配對
  if (assigningNode !== 0) {
    const node = assigningNode;
    const uid = tags.get(node);
    if (uid && uid === pendingUid) {
      finishAssign(`完成！影片 ${node} ← ${prettyUid(uid)}`);
      addLog(`配對成功：影片 ${node} = ${prettyUid(uid)}`);
    }
  }
}

buildAssignGrid();
renderTagTable();

refreshButton.addEventListener("click", () => {
  publish("QUERY");
  addLog("重新讀取標籤表");
});

clearAllButton.addEventListener("click", clearAllTags);

if (!window.mqtt) {
  setConnected(false, "連線元件載入失敗", true);
} else {
  const randomId = crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10);

  client = mqtt.connect(MQTT_URL, {
    clientId: `baechhhh-pair-${randomId}`,
    clean: true,
    connectTimeout: 8000,
    reconnectPeriod: 2500,
    keepalive: 30,
  });

  client.on("connect", () => {
    setConnected(true, "已連線");
    client.subscribe([SCAN_TOPIC, TAGS_TOPIC, STATUS_TOPIC], { qos: 0 });
    // 標籤表是 retained，訂閱後 broker 會立刻推一份過來。
    // 但保險起見主動要一次 —— ESP32 剛開機還沒發過的話 retained 會是空的。
    publish("QUERY");
  });

  client.on("message", (topic, payload) => {
    const text = payload.toString();

    if (topic === SCAN_TOPIC) {
      handleScanMessage(text);
      return;
    }
    if (topic === TAGS_TOPIC) {
      handleTagsMessage(text);
      return;
    }
    if (topic === STATUS_TOPIC && text === "offline") {
      // ESP32 斷線了。網頁對 broker 仍是連著的，但指令送出去沒人收。
      setConnected(false, "ESP32 離線", true);
    }
    if (topic === STATUS_TOPIC && text === "online") {
      setConnected(true, "已連線");
      publish("QUERY");
    }
  });

  client.on("reconnect", () => setConnected(false, "重新連線中…"));
  client.on("offline", () => setConnected(false, "連線中斷", true));
  client.on("error", () => setConnected(false, "連線錯誤", true));
}
