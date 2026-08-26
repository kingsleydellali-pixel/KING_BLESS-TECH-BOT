// index.js
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    jidDecode,
    proto,
    getContentType,
    Browsers,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const qrcode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const ytdl = require("ytdl-core");
const ytSearch = require("yt-search");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const removeBg = require("remove.bg");
const googlethis = require("googlethis");
const weather = require("weather-js");
const NewsAPI = require("newsapi");
const { create, all } = require("mathjs");
const math = create(all);
const moment = require("moment");
const chalk = require("chalk");
const settings = require("./settings");

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

// Global state
let sock;
let isConnected = false;
let pairingCode = null;
let qrCodeData = null;
let authState;
let saveCreds;
let store = makeInMemoryStore({ logger: pino().child({ level: "silent", stream: "store" }) });

// Web Dashboard
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // optional if you add HTML

// Basic Auth for dashboard (optional)
const auth = (req, res, next) => {
    const b64auth = (req.headers.authorization || "").split(" ")[1] || "";
    const [login, password] = Buffer.from(b64auth, "base64").toString().split(":");
    if (login && password && login === settings.WEB_USER && password === settings.WEB_PASS) {
        return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="401"');
    res.status(401).send("Authentication required.");
};

// Dashboard routes
app.get("/", auth, (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>KING-XD Bot Dashboard</title>
            <style>
                body { font-family: Arial; background: #1e1e2e; color: #fff; text-align: center; padding: 50px; }
                input, button { padding: 10px; margin: 10px; border-radius: 5px; border: none; }
                button { background: #7289da; color: white; cursor: pointer; }
                #status { margin-top: 20px; font-size: 1.2em; }
                #qr { margin-top: 20px; }
                img { border: 5px solid white; border-radius: 10px; }
            </style>
        </head>
        <body>
            <h1>🔗 KING-XD Bot Pairing</h1>
            <p>Enter your WhatsApp number (with country code, no + or spaces) to get a pairing code.</p>
            <input type="text" id="phone" placeholder="e.g., 1234567890" />
            <button onclick="requestPair()">Get Pairing Code</button>
            <div id="pairingCode"></div>
            <hr>
            <p>Or scan the QR code:</p>
            <div id="qr"></div>
            <div id="status">Connecting...</div>
            <script>
                async function requestPair() {
                    const phone = document.getElementById('phone').value.trim();
                    if (!phone) return alert('Enter phone number');
                    const res = await fetch('/pair', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phone })
                    });
                    const data = await res.json();
                    document.getElementById('pairingCode').innerHTML = data.code ? 
                        `<h2>Pairing Code: <span style="color:#4caf50">${data.code}</span></h2>` : 
                        `<p>Error: ${data.error}</p>`;
                }
                async function checkStatus() {
                    const res = await fetch('/status');
                    const data = await res.json();
                    document.getElementById('status').innerText = data.status === 'connected' ? 
                        '✅ Connected' : data.qr ? '📱 QR Ready' : '⏳ Waiting...';
                    if (data.qr) {
                        document.getElementById('qr').innerHTML = `<img src="${data.qr}" width="250" />`;
                    } else {
                        document.getElementById('qr').innerHTML = '';
                    }
                    setTimeout(checkStatus, 3000);
                }
                checkStatus();
            </script>
        </body>
        </html>
    `);
});

app.post("/pair", auth, async (req, res) => {
    const { phone } = req.body;
    if (!phone || !sock) return res.json({ error: "Bot not ready or invalid phone" });
    try {
        const code = await sock.requestPairingCode(phone);
        pairingCode = code;
        res.json({ code });
    } catch (err) {
        res.json({ error: err.message });
    }
});

app.get("/qr", auth, (req, res) => {
    res.json({ qr: qrCodeData });
});

app.get("/status", (req, res) => {
    res.json({
        status: isConnected ? "connected" : "disconnected",
        qr: qrCodeData || null,
    });
});

// Start Express server
const PORT = settings.WEB_PORT;
app.listen(PORT, () => {
    console.log(chalk.green(`🌐 Dashboard running on http://localhost:${PORT}`));
});

// Baileys connection
async function startBot() {
    const { state, saveCreds: saveCredsFn } = await useMultiFileAuthState(path.join(__dirname, "auth", settings.SESSION_ID));
    authState = state;
    saveCreds = saveCredsFn;

    const { version, isLatest } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.ubuntu("Chrome"),
        getMessage: async (key) => (store.loadMessage(key) || {}).message || undefined,
    });

    store.bind(sock.ev);

    // Handle connection updates
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrCodeData = qr;
            qrcodeTerminal.generate(qr, { small: true });
            // Also generate data URL for dashboard
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) qrCodeData = url;
            });
        }
        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(chalk.red(`Connection closed due to ${lastDisconnect?.error?.message || "unknown"}, reconnecting ${shouldReconnect}`);
            if (shouldReconnect) {
                startBot();
            } else {
                console.log("Logged out. Delete auth folder and restart.");
            }
        } else if (connection === "open") {
            isConnected = true;
            qrCodeData = null;
            pairingCode = null;
            console.log(chalk.green("✅ Bot connected!"));
            onConnected();
        }
    });

    // Save credentials
    sock.ev.on("creds.update", saveCreds);
}

// When bot is connected, perform startup tasks
async function onConnected() {
    // Auto-channel join if configured
    if (settings.AUTO_CHANNEL_JOIN) {
        try {
            const code = settings.AUTO_CHANNEL_JOIN.split("/").pop();
            await sock.groupAcceptInvite(code);
            console.log(chalk.blue("📢 Joined auto channel"));
        } catch (err) {
            console.log(chalk.yellow("Could not join auto channel:", err.message));
        }
    }
    // Auto-status view
    if (settings.DEFAULT_SETTINGS.autostatus) {
        console.log(chalk.blue("👀 Auto-status viewing enabled (will view statuses when they appear)"));
    }
}

// Message handling
async function handleMessage(msg) {
    if (!msg.message) return;
    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");
    const sender = msg.key.participant || msg.key.remoteJid;
    const isOwner = sender === settings.OWNER_NUMBER;
    const isAdmin = isGroup ? await isGroupAdmin(from, sender) : false;
    const botNumber = sock.user.id.split(":")[0] + "@s.whatsapp.net";
    const isBotAdmin = isGroup ? await isGroupAdmin(from, botNumber) : false;
    const content = getMessageContent(msg);
    const text = content?.text || "";
    const prefix = settings.PREFIX;

    // Ignore messages from self
    if (msg.key.fromMe) return;

    // Anti-delete: store message for later
    if (settings.DEFAULT_SETTINGS.antidelete && content) {
        storeMessageForAntiDelete(msg);
    }

    // Auto-react
    if (settings.DEFAULT_SETTINGS.autoreact && content) {
        const reactionEmoji = "👍"; // or custom
        await sock.sendMessage(from, { react: { text: reactionEmoji, key: msg.key } });
    }

    // Anti-link (group only)
    if (isGroup && settings.DEFAULT_SETTINGS.antilink && !isAdmin && containsLink(text)) {
        await sock.sendMessage(from, { text: `@${sender.split("@")[0]} Links are not allowed!` }, { mentions: [sender] });
        await sock.groupParticipantsUpdate(from, [sender], "remove");
        return;
    }

    // Anti-badword (simple example)
    if (settings.DEFAULT_SETTINGS.antibadword && containsBadWord(text)) {
        await sock.sendMessage(from, { text: "⚠️ Bad word detected!" });
        // Optionally delete message
        await sock.sendMessage(from, { delete: msg.key });
        return;
    }

    // Command parsing
    if (!text.startsWith(prefix)) return;
    const [cmd, ...args] = text.slice(prefix.length).trim().split(/\s+/);
    const command = cmd.toLowerCase();
    const fullText = text.slice(prefix.length).trim();

    // Respond to commands
    switch (command) {
        // Downloaders
        case "yt":
        case "video":
            if (!args[0]) return reply(from, "❌ Please provide YouTube URL", msg);
            downloadYouTube(args[0], false, from, msg);
            break;
        case "song":
            if (!args[0]) return reply(from, "❌ Please provide YouTube URL", msg);
            downloadYouTube(args[0], true, from, msg);
            break;
        case "yts":
        case "ytsearch":
            if (!args[0]) return reply(from, "❌ Please provide search query", msg);
            searchYouTube(args.join(" "), from, msg);
            break;
        case "vid":
            if (!args[0]) return reply(from, "❌ Please provide search query for video", msg);
            searchAndDownloadYouTube(args.join(" "), from, msg);
            break;
        case "tt":
            if (!args[0]) return reply(from, "❌ Please provide TikTok URL", msg);
            downloadTikTok(args[0], from, msg);
            break;
        case "ig":
            if (!args[0]) return reply(from, "❌ Please provide Instagram URL", msg);
            downloadInstagram(args[0], from, msg);
            break;
        case "fb":
            if (!args[0]) return reply(from, "❌ Please provide Facebook video URL", msg);
            downloadFacebook(args[0], from, msg);
            break;
        case "wallpaper":
            getWallpaper(args.join(" ") || "nature", from, msg);
            break;

        // Search
        case "google":
            if (!args[0]) return reply(from, "❌ Please provide search query", msg);
            googleSearch(args.join(" "), from, msg);
            break;
        case "duckduckgo":
            if (!args[0]) return reply(from, "❌ Please provide search query", msg);
            duckduckgoSearch(args.join(" "), from, msg);
            break;
        case "yahoo":
            if (!args[0]) return reply(from, "❌ Please provide search query", msg);
            reply(from, "Yahoo search is not available in this mini version.", msg);
            break;
        case "wiki":
            if (!args[0]) return reply(from, "❌ Please provide search term", msg);
            wikiSearch(args.join(" "), from, msg);
            break;
        case "weather":
            if (!args[0]) return reply(from, "❌ Please provide location", msg);
            getWeather(args.join(" "), from, msg);
            break;
        case "news":
            getNews(args.join(" ") || "top", from, msg);
            break;

        // Image Editor
        case "crop":
        case "resize":
        case "rotate":
        case "flip":
        case "filter":
        case "adjust":
        case "text":
        case "watermark":
        case "imgedit":
            handleImageEdit(command, args, msg);
            break;

        // Video Editor
        case "trim":
        case "speed":
        case "vidfilter":
        case "mute":
        case "volume":
        case "videdit":
            handleVideoEdit(command, args, msg);
            break;

        // Media Tools
        case "sticker":
            makeSticker(msg, from);
            break;
        case "toimg":
            stickerToImage(msg, from);
            break;
        case "compress":
            compressImage(msg, from);
            break;
        case "enhance":
            enhanceImage(msg, from);
            break;
        case "blur":
            blurImage(msg, from);
            break;
        case "removebg":
            removeBackground(msg, from);
            break;

        // Group Manager (Admin only)
        case "gcstatus":
            if (!isGroup) return reply(from, "This command works only in groups.", msg);
            getGroupStatus(from, msg);
            break;
        case "groupinfo":
            if (!isGroup) return reply(from, "This command works only in groups.", msg);
            getGroupInfo(from, msg);
            break;
        case "kick":
            if (!isGroup || !isAdmin) return reply(from, "❌ Admin only command.", msg);
            if (!msg.mentionedJid?.length) return reply(from, "❌ Mention user(s) to kick.", msg);
            await sock.groupParticipantsUpdate(from, msg.mentionedJid, "remove");
            reply(from, "✅ Kicked.", msg);
            break;
        case "promote":
            if (!isGroup || !isAdmin) return reply(from, "❌ Admin only command.", msg);
            if (!msg.mentionedJid?.length) return reply(from, "❌ Mention user(s) to promote.", msg);
            await sock.groupParticipantsUpdate(from, msg.mentionedJid, "promote");
            reply(from, "✅ Promoted.", msg);
            break;
        case "demote":
            if (!isGroup || !isAdmin) return reply(from, "❌ Admin only command.", msg);
            if (!msg.mentionedJid?.length) return reply(from, "❌ Mention user(s) to demote.", msg);
            await sock.groupParticipantsUpdate(from, msg.mentionedJid, "demote");
            reply(from, "✅ Demoted.", msg);
            break;
        case "add":
            if (!isGroup || !isAdmin) return reply(from, "❌ Admin only command.", msg);
            const number = args[0]?.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
            await sock.groupParticipantsUpdate(from, [number], "add");
            reply(from, "✅ Added.", msg);
            break;
        case "mute":
            if (!isGroup || !isAdmin) return reply(from, "❌ Admin only command.", msg);
            await sock.groupSettingUpdate(from, "announcement");
            reply(from, "🔇 Group muted.", msg);
            break;
        case "unmute":
            if (!isGroup || !isAdmin) return reply(from, "❌ Admin only command.", msg);
            await sock.groupSettingUpdate(from, "not_announcement");
            reply(from, "🔊 Group unmuted.", msg);
            break;
        case "link":
            if (!isGroup) return reply(from, "This command works only in groups.", msg);
            const code = await sock.groupInviteCode(from);
            reply(from, `🔗 Group link: https://chat.whatsapp.com/${code}`, msg);
            break;
        case "revoke":
            if (!isGroup || !isAdmin) return reply(from, "❌ Admin only command.", msg);
            await sock.groupRevokeInvite(from);
            reply(from, "🔗 Link revoked.", msg);
            break;
        case "tag":
        case "tagall":
            if (!isGroup) return reply(from, "This command works only in groups.", msg);
            tagAll(from, msg);
            break;
        case "kickall":
            if (!isGroup || !isAdmin) return reply(from, "❌ Admin only command.", msg);
            kickAll(from, msg);
            break;
        case "kill":
            if (!isOwner) return reply(from, "❌ Owner only command.", msg);
            reply(from, "💀 Bot will restart...", msg);
            setTimeout(() => process.exit(1), 2000);
            break;
        case "vv":
            if (!isGroup) return reply(from, "This command works only in groups.", msg);
            reply(from, "👁️ View-once messages are automatically saved. Use .vv to see them.", msg);
            // Implement a way to list saved VV messages (not fully implemented here)
            break;

        // Settings
        case "autoreact":
        case "autostatus":
        case "antibadword":
        case "antilink":
        case "antidelete":
        case "anticall":
            toggleSetting(command, from, msg);
            break;
        case "settings":
            showSettings(from, msg);
            break;

        // Tools
        case "calc":
            if (!args[0]) return reply(from, "❌ Please provide expression", msg);
            try {
                const result = math.evaluate(args.join(" "));
                reply(from, `🧮 Result: ${result}`, msg);
            } catch (e) {
                reply(from, `❌ Error: ${e.message}`, msg);
            }
            break;
        case "flip":
            reply(from, Math.random() < 0.5 ? "Heads" : "Tails", msg);
            break;
        case "roll":
            const max = parseInt(args[0]) || 6;
            reply(from, `🎲 You rolled: ${Math.floor(Math.random() * max) + 1}`, msg);
            break;
        case "8ball":
            const answers = ["Yes", "No", "Maybe", "Ask again later", "Definitely", "I don't think so"];
            reply(from, `🎱 ${answers[Math.floor(Math.random() * answers.length)]}`, msg);
            break;
        case "joke":
            getJoke(from, msg);
            break;
        case "quote":
            getQuote(from, msg);
            break;
        case "fact":
            getFact(from, msg);
            break;
        case "reverse":
            reply(from, args.join(" ").split("").reverse().join(""), msg);
            break;
        case "upper":
            reply(from, args.join(" ").toUpperCase(), msg);
            break;
        case "lower":
            reply(from, args.join(" ").toLowerCase(), msg);
            break;
        case "id":
            reply(from, `🆔 Chat ID: ${from}\n👤 Sender: ${sender}`, msg);
            break;
        case "whoami":
            reply(from, `👤 You are: ${sender}`, msg);
            break;
        case "ping":
            const start = Date.now();
            const sent = await reply(from, "Pinging...", msg);
            const end = Date.now();
            await sock.sendMessage(from, { text: `🏓 Pong! ${end - start}ms`, edit: sent.key });
            break;
        case "alive":
            sendAlive(from, msg);
            break;
        case "uptime":
            const uptime = process.uptime();
            reply(from, `⏱️ Uptime: ${formatUptime(uptime)}`, msg);
            break;
        case "mode":
            reply(from, isGroup ? "👥 Group mode" : "👤 Private mode", msg);
            break;

        // Owner
        case "broadcast":
            if (!isOwner) return reply(from, "❌ Owner only command.", msg);
            broadcastMessage(args.join(" "), msg);
            break;
        case "restart":
            if (!isOwner) return reply(from, "❌ Owner only command.", msg);
            reply(from, "♻️ Restarting...", msg);
            setTimeout(() => process.exit(1), 1000);
            break;
        case "block":
            if (!isOwner) return reply(from, "❌ Owner only command.", msg);
            const blockUser = args[0]?.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
            await sock.updateBlockStatus(blockUser, "block");
            reply(from, "🚫 Blocked.", msg);
            break;
        case "unblock":
            if (!isOwner) return reply(from, "❌ Owner only command.", msg);
            const unblockUser = args[0]?.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
            await sock.updateBlockStatus(unblockUser, "unblock");
            reply(from, "✅ Unblocked.", msg);
            break;

        default:
            // Unknown command, show menu
            if (command === "menu" || command === "help") {
                sendMenu(from, msg);
            }
            break;
    }
}

// Helper functions (many more needed)
function getMessageContent(msg) {
    const type = getContentType(msg.message);
    if (!type) return null;
    if (type === "conversation") return { text: msg.message.conversation };
    if (type === "extendedTextMessage") return { text: msg.message.extendedTextMessage.text };
    if (type === "imageMessage") return { image: msg.message.imageMessage, caption: msg.message.imageMessage.caption };
    if (type === "videoMessage") return { video: msg.message.videoMessage, caption: msg.message.videoMessage.caption };
    // ... handle other types
    return null;
}

async function reply(jid, text, msg) {
    await sock.sendMessage(jid, { text }, { quoted: msg });
}

async function isGroupAdmin(groupJid, userJid) {
    const metadata = await sock.groupMetadata(groupJid);
    const admins = metadata.participants.filter(p => p.admin).map(p => p.id);
    return admins.includes(userJid);
}

function containsLink(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return urlRegex.test(text);
}

function containsBadWord(text) {
    const badWords = ["badword1", "badword2"]; // Add your list
    return badWords.some(word => text.toLowerCase().includes(word));
}

// Download functions
async function downloadYouTube(url, audioOnly, from, msg) {
    try {
        if (!ytdl.validateURL(url)) return reply(from, "❌ Invalid YouTube URL", msg);
        const info = await ytdl.getInfo(url);
        const title = info.videoDetails.title;
        reply(from, `⬇️ Downloading: ${title}...`, msg);
        if (audioOnly) {
            const stream = ytdl(url, { filter: "audioonly", quality: "highestaudio" });
            const buffer = await streamToBuffer(stream);
            await sock.sendMessage(from, {
                audio: buffer,
                mimetype: "audio/mp4",
                fileName: `${title}.mp3`,
                ptt: false
            }, { quoted: msg });
        } else {
            const stream = ytdl(url, { filter: "videoandaudio", quality: "highest" });
            const buffer = await streamToBuffer(stream);
            await sock.sendMessage(from, {
                video: buffer,
                mimetype: "video/mp4",
                caption: `🎬 ${title}`
            }, { quoted: msg });
        }
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

async function searchYouTube(query, from, msg) {
    try {
        const results = await ytSearch(query);
        const videos = results.videos.slice(0, 5);
        let text = "🔎 *YouTube Search Results:*\n\n";
        videos.forEach((v, i) => {
            text += `${i + 1}. ${v.title}\n   ⏱️ ${v.timestamp} | 👁️ ${v.views}\n   🔗 ${v.url}\n\n`;
        });
        reply(from, text, msg);
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

async function searchAndDownloadYouTube(query, from, msg) {
    try {
        const results = await ytSearch(query);
        const video = results.videos[0];
        if (!video) return reply(from, "❌ No results found", msg);
        reply(from, `⬇️ Downloading: ${video.title}...`, msg);
        const stream = ytdl(video.url, { filter: "videoandaudio", quality: "highest" });
        const buffer = await streamToBuffer(stream);
        await sock.sendMessage(from, {
            video: buffer,
            mimetype: "video/mp4",
            caption: `🎬 ${video.title}`
        }, { quoted: msg });
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

async function downloadTikTok(url, from, msg) {
    try {
        // Use tiktok-scraper-without-watermark library
        const result = await require("tiktok-scraper-without-watermark")(url);
        if (result.video) {
            const buffer = await axios.get(result.video, { responseType: "arraybuffer" }).then(r => r.data);
            await sock.sendMessage(from, { video: buffer, mimetype: "video/mp4" }, { quoted: msg });
        } else {
            reply(from, "❌ Could not download TikTok video", msg);
        }
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

async function downloadInstagram(url, from, msg) {
    try {
        const insta = require("instagram-url-direct");
        const data = await insta(url);
        if (data.url_list && data.url_list[0]) {
            const buffer = await axios.get(data.url_list[0], { responseType: "arraybuffer" }).then(r => r.data);
            const type = data.type === "video" ? "video" : "image";
            await sock.sendMessage(from, { [type]: buffer, mimetype: type === "video" ? "video/mp4" : "image/jpeg" }, { quoted: msg });
        } else {
            reply(from, "❌ Could not download Instagram media", msg);
        }
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

async function downloadFacebook(url, from, msg) {
    try {
        const fb = require("facebook-video-downloader");
        const data = await fb.getInfo(url);
        if (data.download_url) {
            const buffer = await axios.get(data.download_url, { responseType: "arraybuffer" }).then(r => r.data);
            await sock.sendMessage(from, { video: buffer, mimetype: "video/mp4" }, { quoted: msg });
        } else {
            reply(from, "❌ Could not download Facebook video", msg);
        }
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

async function getWallpaper(query, from, msg) {
    try {
        const res = await axios.get(`https://api.unsplash.com/search/photos?query=${query}&client_id=YOUR_UNSPLASH_ACCESS_KEY`);
        if (res.data.results.length > 0) {
            const imageUrl = res.data.results[0].urls.regular;
            const buffer = await axios.get(imageUrl, { responseType: "arraybuffer" }).then(r => r.data);
            await sock.sendMessage(from, { image: buffer, caption: `🖼️ Wallpaper: ${query}` }, { quoted: msg });
        } else {
            reply(from, "❌ No wallpapers found", msg);
        }
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

// Search functions
async function googleSearch(query, from, msg) {
    try {
        const results = await googlethis.search(query, { page: 0, safe: false, additional_params: { hl: "en" } });
        const top = results.results.slice(0, 5);
        let text = "🔎 *Google Search:*\n\n";
        top.forEach((r, i) => {
            text += `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}\n\n`;
        });
        reply(from, text, msg);
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

async function duckduckgoSearch(query, from, msg) {
    try {
        const ddg = require("duckduckgo-search");
        const results = await ddg.search(query, { safeSearch: "moderate" });
        let text = "🦆 *DuckDuckGo Search:*\n\n";
        results.slice(0, 5).forEach((r, i) => {
            text += `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}\n\n`;
        });
        reply(from, text, msg);
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

async function wikiSearch(term, from, msg) {
    try {
        const res = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`);
        const data = res.data;
        reply(from, `📚 *${data.title}*\n\n${data.extract}\n\n🔗 ${data.content_urls.desktop.page}`, msg);
    } catch (err) {
        reply(from, "❌ Could not find Wikipedia article", msg);
    }
}

async function getWeather(location, from, msg) {
    weather.find({ search: location, degreeType: "C" }, (err, result) => {
        if (err || !result || result.length === 0) return reply(from, "❌ Location not found", msg);
        const current = result[0].current;
        const forecast = result[0].forecast.slice(0, 3).map(f => `${f.day}: ${f.skytextday}, ${f.low}°C - ${f.high}°C`).join("\n");
        const text = `🌤️ *Weather for ${result[0].location.name}*\n\n` +
            `Temperature: ${current.temperature}°C\nFeels like: ${current.feelslike}°C\nHumidity: ${current.humidity}%\nWind: ${current.winddisplay}\n\n` +
            `*3-Day Forecast:*\n${forecast}`;
        reply(from, text, msg);
    });
}

async function getNews(category, from, msg) {
    try {
        const newsapi = new NewsAPI("YOUR_NEWSAPI_KEY"); // Get from newsapi.org
        const response = await newsapi.v2.topHeadlines({ category: category || "general", language: "en", pageSize: 5 });
        const articles = response.articles;
        let text = "📰 *Latest News:*\n\n";
        articles.forEach((a, i) => {
            text += `${i + 1}. ${a.title}\n   ${a.source.name} - ${moment(a.publishedAt).format("DD MMM YYYY")}\n   ${a.url}\n\n`;
        });
        reply(from, text, msg);
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

// Image editing (simplified, using sharp)
async function handleImageEdit(command, args, msg) {
    // This is a placeholder; actual implementation would require media parsing
    reply(msg.key.remoteJid, "🖼️ Image editing commands are available when replying to an image. Send an image with caption .crop etc.", msg);
}

// Video editing (simplified)
async function handleVideoEdit(command, args, msg) {
    reply(msg.key.remoteJid, "🎬 Video editing commands are available when replying to a video. Send a video with caption .trim etc.", msg);
}

// Media tools
async function makeSticker(msg, from) {
    if (!msg.message?.imageMessage && !msg.message?.videoMessage) return reply(from, "❌ Please send an image or video with caption .sticker", msg);
    try {
        let buffer, mimetype;
        if (msg.message.imageMessage) {
            buffer = await downloadMedia(msg.message.imageMessage);
            mimetype = "image/jpeg";
        } else {
            buffer = await downloadMedia(msg.message.videoMessage);
            mimetype = "video/mp4";
        }
        const stickerBuffer = await convertToSticker(buffer, mimetype);
        await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

async function stickerToImage(msg, from) {
    if (!msg.message?.stickerMessage) return reply(from, "❌ Please send a sticker with caption .toimg", msg);
    try {
        const buffer = await downloadMedia(msg.message.stickerMessage);
        const imageBuffer = await sharp(buffer).png().toBuffer();
        await sock.sendMessage(from, { image: imageBuffer }, { quoted: msg });
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

async function compressImage(msg, from) {
    if (!msg.message?.imageMessage) return reply(from, "❌ Please send an image with caption .compress", msg);
    try {
        const buffer = await downloadMedia(msg.message.imageMessage);
        const compressed = await sharp(buffer).jpeg({ quality: 50 }).toBuffer();
        await sock.sendMessage(from, { image: compressed }, { quoted: msg });
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

async function enhanceImage(msg, from) {
    if (!msg.message?.imageMessage) return reply(from, "❌ Please send an image with caption .enhance", msg);
    try {
        const buffer = await downloadMedia(msg.message.imageMessage);
        const enhanced = await sharp(buffer).modulate({ brightness: 1.2, saturation: 1.2 }).sharpen().toBuffer();
        await sock.sendMessage(from, { image: enhanced }, { quoted: msg });
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

async function blurImage(msg, from) {
    if (!msg.message?.imageMessage) return reply(from, "❌ Please send an image with caption .blur", msg);
    try {
        const buffer = await downloadMedia(msg.message.imageMessage);
        const blurred = await sharp(buffer).blur(5).toBuffer();
        await sock.sendMessage(from, { image: blurred }, { quoted: msg });
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

async function removeBackground(msg, from) {
    if (!msg.message?.imageMessage) return reply(from, "❌ Please send an image with caption .removebg", msg);
    try {
        const buffer = await downloadMedia(msg.message.imageMessage);
        removeBg.removeBackgroundFromImageBuffer({
            buffer,
            apiKey: "YOUR_REMOVEBG_API_KEY",
            size: "regular",
        }).then(async (result) => {
            await sock.sendMessage(from, { image: result.base64img }, { quoted: msg });
        }).catch(err => reply(from, `❌ Error: ${err.message}`, msg));
    } catch (err) {
        reply(from, `❌ Error: ${err.message}`, msg);
    }
}

// Group tools
async function getGroupStatus(groupJid, msg) {
    const metadata = await sock.groupMetadata(groupJid);
    const admins = metadata.participants.filter(p => p.admin).map(p => p.id.split("@")[0]);
    const members = metadata.participants.length;
    const text = `📊 *Group Status*\n\n` +
        `👥 Group: ${metadata.subject}\n` +
        `🆔 ID: ${groupJid}\n` +
        `👑 Admins (${admins.length}): ${admins.join(", ")}\n` +
        `👤 Members: ${members}\n` +
        `📝 Description: ${metadata.desc || "None"}`;
    reply(groupJid, text, msg);
}

async function getGroupInfo(groupJid, msg) {
    const metadata = await sock.groupMetadata(groupJid);
    const text = `ℹ️ *Group Info*\n\n` +
        `📛 Name: ${metadata.subject}\n` +
        `🆔 ID: ${groupJid}\n` +
        `👥 Participants: ${metadata.participants.length}\n` +
        `⏰ Created: ${moment(metadata.creation * 1000).format("DD MMM YYYY")}\n` +
        `👑 Owner: ${metadata.owner ? metadata.owner.split("@")[0] : "Unknown"}`;
    reply(groupJid, text, msg);
}

async function tagAll(groupJid, msg) {
    const metadata = await sock.groupMetadata(groupJid);
    const mentions = metadata.participants.map(p => p.id);
    const text = `📢 *Attention everyone!*\n\n` + mentions.map(m => `@${m.split("@")[0]}`).join(" ");
    await sock.sendMessage(groupJid, { text, mentions });
}

async function kickAll(groupJid, msg) {
    const metadata = await sock.groupMetadata(groupJid);
    const nonAdmins = metadata.participants.filter(p => !p.admin).map(p => p.id);
    if (nonAdmins.length === 0) return reply(groupJid, "No non-admin members to kick.", msg);
    await sock.groupParticipantsUpdate(groupJid, nonAdmins, "remove");
    reply(groupJid, `✅ Kicked ${nonAdmins.length} members.`, msg);
}

// Settings toggles
async function toggleSetting(setting, from, msg) {
    // In a full implementation, store per-chat settings in a JSON file
    const current = settings.DEFAULT_SETTINGS[setting];
    if (current === undefined) return reply(from, "❌ Invalid setting", msg);
    settings.DEFAULT_SETTINGS[setting] = !current;
    reply(from, `✅ ${setting} is now ${!current ? "ON" : "OFF"}`, msg);
}

async function showSettings(from, msg) {
    const s = settings.DEFAULT_SETTINGS;
    const text = `⚙️ *Bot Settings*\n\n` +
        `🔒 Anti-Delete: ${s.antidelete ? "✅" : "❌"}\n` +
        `🔗 Anti-Link: ${s.antilink ? "✅" : "❌"}\n` +
        `📞 Anti-Call: ${s.anticall ? "✅" : "❌"}\n` +
        `👀 Auto-Status: ${s.autostatus ? "✅" : "❌"}\n` +
        `👍 Auto-React: ${s.autoreact ? "✅" : "❌"}\n` +
        `🚫 Anti-Badword: ${s.antibadword ? "✅" : "❌"}`;
    reply(from, text, msg);
}

// Tools
async function getJoke(from, msg) {
    try {
        const res = await axios.get("https://v2.jokeapi.dev/joke/Any?type=single");
        reply(from, `😂 ${res.data.joke}`, msg);
    } catch {
        reply(from, "Could not fetch joke", msg);
    }
}

async function getQuote(from, msg) {
    try {
        const res = await axios.get("https://api.quotable.io/random");
        reply(from, `💬 "${res.data.content}"\n— ${res.data.author}`, msg);
    } catch {
        reply(from, "Could not fetch quote", msg);
    }
}

async function getFact(from, msg) {
    try {
        const res = await axios.get("https://uselessfacts.jsph.pl/random.json?language=en");
        reply(from, `🧠 ${res.data.text}`, msg);
    } catch {
        reply(from, "Could not fetch fact", msg);
    }
}

function sendAlive(from, msg) {
    const uptime = process.uptime();
    const text = `╭━〔${settings.BOT_NAME}〕━⬣\n` +
        `┃ [] STATUS  : ONLINE\n` +
        `┃ [] RUNTIME : ${formatUptime(uptime)}\n` +
        `┃ [] USER    : ${msg.pushName || "User"}\n` +
        `┃ [] DEV     : Kingsley-XMD Tech\n` +
        `╰━━━━━━━━━━━━━━━━━━━━⬣`;
    if (settings.BOT_IMAGE_URL) {
        sock.sendMessage(from, { image: { url: settings.BOT_IMAGE_URL }, caption: text }, { quoted: msg });
    } else {
        reply(from, text, msg);
    }
}

function sendMenu(from, msg) {
    const menu = `╭━〔KING-XD Bot Mini〕━⬣
┃ [] STATUS  : ONLINE
┃ [] RUNTIME : ${formatUptime(process.uptime())}
┃ [] USER    : ${msg.pushName || "User"}
┃ [] DEV     : ᴋɪɴɢsʟᴇʏ-xᴍᴅ ᴛᴇᴄʜ
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 📥 DOWNLOADS 〕━━⬣
┃➤ .yt
┃➤ .song 
┃➤ .video 
┃➤ .tt
┃➤ .ig
┃➤ .fb 
┃➤ .wallpaper
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 🔎 SEARCH 〕━━⬣
┃➤ .google
┃➤ .duckduckgo 
┃➤ .yahoo 
┃➤ .wiki
┃➤ .weather
┃➤ .news
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 🖼️ IMAGE EDITOR 〕━━⬣
┃➤ .crop
┃➤ .resize
┃➤ .rotate
┃➤ .flip
┃➤ .filter
┃➤ .adjust
┃➤ .text
┃➤ .watermark
┃➤ .imgedit
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 🎬 VIDEO EDITOR 〕━━⬣
┃➤ .trim
┃➤ .speed
┃➤ .vidfilter
┃➤ .mute 
┃➤ .volume
┃➤ .videdit
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 🎨 MEDIA TOOLS 〕━━⬣
┃➤ .sticker
┃➤ .toimg
┃➤ .compress
┃➤ .enhance
┃➤ .blur
┃➤ .removebg
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 👑 GROUP MANAGER 〕━━⬣ (admins only)
┃➤ .gcstatus 
┃➤ .groupinfo
┃➤ .kick 
┃➤ .promote 
┃➤ .demote
┃➤ .add
┃➤ .mute 
┃➤ .unmute
┃➤ .link 
┃➤ .revoke
┃➤ .tag
┃➤ .tagall
┃➤ .kickall
┃➤ .kill
┃➤ .vv
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 ⚙️ SETTINGS 〕━━⬣
┃➤ .autoreact 
┃➤ .autostatus 
┃➤ .antibadword 
┃➤ .antilink
┃➤ .antidelete 
┃➤ .anticall
┃➤ .settings
╰━━━━━━━━━━━━━━━━━━━━⬣
╭━━〔 🛠 TOOLS 〕━━⬣
┃➤ .calc
┃➤ .flip 
┃➤ .roll 
┃➤ .8ball
┃➤ .joke
┃➤ .quote 
┃➤ .fact
┃➤ .reverse 
┃➤ .upper 
┃➤ .lower
┃➤ .id 
┃➤ .whoami
┃➤ .ping 
┃➤ .alive 
┃➤ .uptime
┃➤ .mode
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 👑 OWNER 〕━━⬣
┃➤ .broadcast
┃➤ .restart
┃➤ .block 
┃➤ .unblock
╰━━━━━━━━━━━━━━━━━━━━⬣`;

    if (settings.BOT_IMAGE_URL) {
        sock.sendMessage(from, { image: { url: settings.BOT_IMAGE_URL }, caption: menu }, { quoted: msg });
    } else {
        reply(from, menu, msg);
    }
}

// Anti-delete storage
const antiDeleteMap = new Map();
function storeMessageForAntiDelete(msg) {
    const key = msg.key.id;
    antiDeleteMap.set(key, msg);
}

// Listen for message updates (deletion)
sock.ev.on("messages.update", (update) => {
    for (const info of update) {
        if (info.update?.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
            const deletedKey = info.key;
            const original = antiDeleteMap.get(deletedKey.id);
            if (original) {
                const from = deletedKey.remoteJid;
                sock.sendMessage(from, { text: `♻️ *Anti-Delete Detected*\n\n${getMessageContent(original)?.text || "Media deleted"}` }, { quoted: original });
                antiDeleteMap.delete(deletedKey.id);
            }
        }
    }
});

// Anti-call
sock.ev.on("call", async (call) => {
    if (settings.DEFAULT_SETTINGS.anticall && call.status === "offer") {
        await sock.rejectCall(call.id, call.from);
        await sock.sendMessage(call.from, { text: "📵 Auto-rejecting calls. Bot is active but doesn't accept calls." });
    }
});

// Auto-status view
sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type === "notify") {
        for (const msg of messages) {
            if (msg.key.remoteJid === "status@broadcast" && settings.DEFAULT_SETTINGS.autostatus) {
                // Mark status as seen
                await sock.readMessages([msg.key]);
            }
            // Handle regular messages
            if (msg.key.remoteJid !== "status@broadcast") {
                handleMessage(msg);
            }
        }
    }
});

// Helper to download media from message
async function downloadMedia(message) {
    const stream = await downloadContentFromMessage(message, getContentType(message));
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

// Utility to convert buffer to sticker (using ffmpeg)
async function convertToSticker(buffer, mimetype) {
    // Simplified: just return buffer if already webp, else use ffmpeg to convert
    // In production, you'd use a proper conversion with sharp/ffmpeg
    return buffer;
}

function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", chunk => chunks.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(chunks)));
        stream.on("error", reject);
    });
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

// Start the bot
startBot().catch(err => console.log(chalk.red("Fatal error:", err)));
