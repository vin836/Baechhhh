# Baechhhh ESP32 影片節點

ESP32 辨識放上感應區的板塊，透過 Wi-Fi/MQTT 將節點狀態即時送到 GitHub Pages。平板只要保持網頁開啟，就會依照 `ON|1` ~ `ON|8` 自動切換影片；回到無節點狀態時顯示待機背景圖。

## 三種辨識方式

| 資料夾 | 辨識依據 | 說明 |
|---|---|---|
| `Baechhhh/` | GPIO34 的 ADC 原始值 | 原版，區間寫死在程式裡 |
| `BaechhhhResistor/` | 換算後的電阻值 | 可用序列埠校準，跨板子通用 |
| **`BaechhhhNFC/`** | **NFC 標籤 UID** | **無類比誤差，可用網頁配對** |

三者發出的 MQTT 訊息格式完全相同，**網頁端不用改任何東西**。

目前展示使用 **NFC 版**，最多 8 張卡片。

## 線上頁面

| 用途 | 網址 |
|---|---|
| 展示畫面（iPad） | <https://vin836.github.io/Baechhhh/> |
| NFC 標籤配對 | <https://vin836.github.io/Baechhhh/pair.html> |
| 影片與背景圖管理 | <https://vin836.github.io/Baechhhh/admin.html> |
| ESP32 訊號模擬器 | <https://vin836.github.io/Baechhhh/test.html> |

## 第一次連 Wi-Fi

1. 將韌體上傳至 ESP32（NFC 版是 `BaechhhhNFC/BaechhhhNFC.ino`）。
2. ESP32 第一次開機會建立名為 `ESP32-Video-Setup` 的 Wi-Fi。
3. 用手機或平板連上這個 Wi-Fi，設定頁會自動出現；若沒有，開啟 `http://192.168.4.1`。
4. 一般家用 Wi-Fi：取消勾選「使用 eduroam / WPA2-Enterprise」，選擇 Wi-Fi 並在上方 Password 輸入密碼。
5. eduroam：選擇 `eduroam`，保留 Enterprise 勾選，將上方一般 Password 留空，再填寫下方的外部身分、完整校園帳號、校園密碼與學校提供的 RADIUS 伺服器網域。

eduroam 帳號通常需要完整 realm，例如 `學號@學校網域`。外部身分可能是同一帳號，也可能是 `anonymous@學校網域`；請以學校資訊中心的說明或 [eduroam CAT](https://cat.eduroam.org/) 設定檔為準。帳號與密碼只儲存在 ESP32 的 NVS，不會寫入 GitHub 或輸出到序列埠。

目前韌體支援 eduroam 常見的 **PEAP / EAP-MSCHAPv2**。學校若使用 EAP-TLS、TTLS 或裝置註冊制度，仍需依該校規格調整。正式展出前也必須把學校提供的 CA PEM 憑證放進 `Config::kEduroamCaPem`，並填入正確 RADIUS 網域；否則雖然可能連得上，卻無法安全確認登入伺服器真偽。

若要更換 Wi-Fi 或 eduroam 帳號，可清除 ESP32 的 Wi-Fi/NVS 設定後重新啟動，再進行一次上述流程。

## Arduino 需要的程式庫

- ESP32 Arduino core 3.3.10
- WiFiManager 2.0.17
- PubSubClient 2.8.0
- MFRC522 1.4.12（僅 NFC 版需要）

Arduino CLI 編譯範例：

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32 .
```

## 辨識板塊

**NFC 版**（目前使用）：每張板塊貼一張 NFC 標籤，用 UID 辨識。接線與配對方式見 [`BaechhhhNFC/README.md`](BaechhhhNFC/README.md)。

配對標籤最簡單的方式是開 [`pair.html`](https://vin836.github.io/Baechhhh/pair.html) —— 刷卡後選編號即可，不用接電腦。

<details>
<summary>原版的 ADC 區間（已不使用）</summary>

| 節點 | GPIO 34 ADC |
| --- | --- |
| 無 | 其他範圍 |
| 1 | 200–999 |
| 2 | 1200–2199 |
| 3 | 2400–3399 |

</details>

## 更換影片

用管理頁上傳最方便，也可以直接覆蓋這些檔案：

```
assets/videos/node-1.mp4  ~  assets/videos/node-8.mp4
```

八個編號不必全部放滿 —— 缺的只是刷到對應標籤時沒反應，不會影響其他影片。

待機背景圖是 `assets/idle.jpg`，同樣可從管理頁更換。

建議使用 H.264 MP4、相同畫面比例，並控制檔案大小，平板切換會比較快。

完整的 GitHub 上傳、FFmpeg 轉檔、網站文字修改與 iPad 全螢幕設定，請見 [`VIDEO_GUIDE.md`](VIDEO_GUIDE.md)。

每次 iPad Web App 開啟或重新載入後，工作人員需先點一次「開啟聲音並開始體驗」。這個使用者手勢會解鎖瀏覽器的有聲播放權限；之後 ESP32 觸發不需再碰螢幕。

網站第一次在 iPad Safari 開啟時，會在背景把影片與待機背景圖存進裝置快取。固定展示期間不需要觸控操作；網頁每五分鐘檢查網站、影片與背景圖是否更新。

## 待機畫面

沒有板塊放上去時，整個畫面顯示 `assets/idle.jpg` 這張背景圖，沒有文字或操作提示。可從管理頁的步驟 4 更換。

MQTT 斷線時右上角會浮出紅色提示，連線正常則完全隱藏。

## 即時連線說明

GitHub Pages 只負責公開靜態網站；ESP32 與網頁之間使用 HiveMQ 公開測試 MQTT broker。這適合目前 Demo，不提供私密性或服務保證。正式展出時建議改成有帳號密碼的專用 MQTT broker，並同步更換韌體和 `app.js` / `pair.js` / `test.js` 裡的 broker 與 topic。

> topic 開頭的 `axoled-student` 只是 broker 上的命名空間字串，和 GitHub 帳號無關。改它必須韌體與網頁同時更新，否則兩邊會完全斷線。

## NFC 標籤配對頁

開啟 `pair.html` 可以不接電腦就配對標籤：刷卡 → 畫面顯示 UID → 按影片編號 → 再刷同一張 → 完成。設定自動存進 ESP32 的 NVS。

配對用的三個 MQTT topic 定義在 [`BaechhhhNFC/README.md`](BaechhhhNFC/README.md)。沒有硬體時可跑 `BaechhhhNFC/fake_esp32.py` 模擬一台 ESP32 來測介面。

## ESP32 訊號模擬器

開啟 `test.html` 可從手機或電腦模擬 ESP32 的 `ON|1` ~ `ON|8`、`OFF|0` 訊號，也能自動輪流測試八個節點。測試頁與牆內 iPad 使用同一個 MQTT topic，因此按下後展示畫面會即時切換。

模擬器使用非保留 MQTT 訊號；重新整理展示頁時不會重播最後一次測試節點。展示頁也會忽略 broker 在訂閱瞬間送來的 retained 舊狀態，只處理頁面已連線後收到的新事件。

## 影片上傳管理頁

開啟 `admin.html` 後，只需要選擇編號（**影片 1 ~ 影片 8**）、挑選影片，再按「上傳並自動轉檔」。Repository、分支、路徑與 commit 都已固定，不需要手動設定。最下方的步驟 4 可以更換待機背景圖。

第一次使用時，請貼上只授權 `vin836/Baechhhh`、具備 `Contents: Read and write` 的 fine-grained Personal Access Token。管理頁會把 Token 保存在目前裝置的瀏覽器 `localStorage`，下次開啟時自動使用；按「更換 Token」即可清除。Token 不會寫進 HTML、JavaScript 或 GitHub repository。因為瀏覽器會記住 Token，請勿在公用或共用裝置使用管理頁。

管理頁接受 MP4、MOV、M4V、MKV、AVI、WebM、MPEG 等常見影片，來源檔案上限為 1 GB。瀏覽器會把大檔切成 12 MB 暫存區塊，GitHub Actions 再使用 FFmpeg 轉成最高 1080p／30 FPS 的 H.264、AAC、`yuv420p` MP4，並壓縮到 GitHub Pages 可發布的 100 MB 以內。暫存區塊不會加入 `main` 的 commit 歷史。

自動轉檔工作定義在 `.github/workflows/transcode-video.yml`。管理頁提交 `.video-jobs/*.json` 工作單後會自動啟動；轉檔完成時覆蓋對應的 `assets/videos/node-N.mp4`、移除工作單並要求 GitHub Pages 重新建置。
