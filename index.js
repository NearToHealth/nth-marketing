// Vercel 進入點：匯出 Express app（Vercel 會把它包成一個 Function）。
// 本機或自架主機請用 `npm start`（會啟動常駐伺服器與內建排程）。
module.exports = require('./server/server.js');
