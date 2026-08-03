# 影片上傳與更換指南

## 影片格式

管理頁會自動轉檔，所以可以直接選擇 MP4、MOV、M4V、MKV、AVI、WebM、MPEG 等常見影片，不需要自己改檔名或先學 FFmpeg。來源檔案需小於 1 GB。

GitHub 會自動輸出最高 1920×1080、30 FPS、H.264 影像、AAC 聲音與 `yuv420p` 色彩格式的 MP4，並壓縮到 GitHub Pages 可以發布的大小。

影片支援聲音。因 iPad Safari 的自動播放限制，每次 Web App 開啟或重新載入後，工作人員必須先在畫面上點一次「開啟聲音並開始體驗」。按鈕消失後，同一個頁面收到的 ESP32 訊號都會自動全螢幕、有聲播放。請在 iPad 封入牆面或開啟「引導使用模式」前完成這一步。

## 用簡易管理頁更換影片

1. 開啟 <https://vin836.github.io/Baechhhh/admin.html>。
2. 第一次使用時貼上 GitHub Token；同一台裝置下次會自動記住。
3. 選擇要替換的編號（**影片 1 ~ 影片 8**）。
4. 按「選擇影片」並選取來源檔案。
5. 按「上傳並自動轉檔」。分段上傳完成後即可關閉頁面，GitHub 會繼續處理。
6. 轉檔通常需要幾分鐘；固定 iPad 最晚約五分鐘後會取得新影片，不需要觸控重新整理。

Token 只需要授權 `vin836/Baechhhh`，並給予 `Contents: Read and write` 與 `Actions: Read and write`。前者用來上傳工作單，後者用來立即啟動轉檔；請勿在公用裝置儲存 Token。

八個編號不必全部放滿。沒上傳的編號只是刷到對應標籤時沒反應，不會影響其他影片。

## 更換待機背景圖

管理頁最下方的**步驟 4** 可以更換「沒有板塊放上去時」顯示的那張圖。

圖片會在瀏覽器裡自動縮到最大 2560×1440 並轉成 JPEG，不用等 GitHub 轉檔，通常幾秒完成。

## 配對 NFC 標籤

開 <https://vin836.github.io/Baechhhh/pair.html>：

1. 把標籤靠近讀卡器，畫面會顯示它的 UID
2. 按一個影片編號
3. **把同一張標籤再刷一次**（RC522 只在卡片重新進入感應區時觸發）
4. 標籤表會即時更新，設定自動存進 ESP32

不用接電腦，也不用序列埠。

## 將任意影片轉成 10 秒 Demo

電腦已安裝 FFmpeg，可以在 PowerShell 執行：

```powershell
ffmpeg -i "原始影片.mp4" -t 10 -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k -movflags +faststart "node-1.mp4"
```

要更換其他支，把輸出檔名改成 `node-2.mp4` ~ `node-8.mp4` 即可。

## 修改網站文字

- 貴賓畫面結構：`index.html`（待機時只顯示 `assets/idle.jpg`，沒有文字）
- 顏色、尺寸、全螢幕外觀：`styles.css`
- 節點與影片對應、播放結束行為：`app.js`
- ESP32 測試控制頁：`test.html`、`test.js`、`test.css`
- NFC 標籤配對頁：`pair.html`、`pair.js`、`pair.css`

**影片數量**要改的話，`app.js` / `sw.js` / `admin.js` / `test.js` / `pair.js` 的 `VIDEO_COUNT`、韌體的 `kPuzzleCount`、以及 workflow 的 `^[1-8]$` 都要一起改。

修改完成後 commit 到 `main` 分支，GitHub Pages 會自動重新發布。

## iPad 真正全螢幕安裝

Safari 網頁本身無法在沒有觸控的情況下關閉網址列。封入牆面前需設定一次：

1. 用 Safari 開啟 <https://vin836.github.io/Baechhhh/>。
2. 按 **分享** → **加入主畫面**。
3. 開啟 **作為 Web App 打開**。
4. 按 **加入**。
5. 回到主畫面，從新建立的圖示開啟展示網站。

之後 ESP32 觸發影片時，影片會自動覆蓋整個 Web App 畫面；10 秒 Demo 播放完畢後，畫面會提示貴賓拿起板塊。
