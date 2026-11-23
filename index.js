// Vercel 進入點：Vercel 會在這個檔案偵測到 express，並把 app 包成一個 Function。
// 本機或自架主機請用 `npm start`（會啟動常駐伺服器與內建排程）。
const express = require('express'); // eslint-disable-line no-unused-vars -- 供 Vercel 偵測 Express
const app = require('./server/server.js');

module.exports = app;
