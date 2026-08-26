// settings.js
module.exports = {
    // Bot Configuration
    BOT_NAME: "KING-XD Bot Mini",
    PREFIX: ".",
    OWNER_NUMBER: "233535502036@s.whatsapp.net", // Replace with your number
    SESSION_ID: "king-xd-session", // Name for auth folder
    BOT_IMAGE_URL: "https://i.ibb.co/SXQ0JCYX/jawadmd.jpg", // Displayed in menu/alive

    // Auto-Channel Join (Channel ID or Invite Link)
    AUTO_CHANNEL_JOIN: "https://whatsapp.com/channel/0029Vb6zdPc5vKAAAY0imG2R", // Set to null to disable
    CUSTOM_CHANNEL_REACT: true, // React to channel messages with ✅

    // Protection Defaults (can be toggled per chat)
    DEFAULT_SETTINGS: {
        antidelete: true,
        antilink: false,
        anticall: true,
        autostatus: true,
        autoreact: true,
        antibadword: true,
    },

    // Dashboard Web Server
    WEB_PORT: process.env.PORT || 3000,
    WEB_USER: "admin", // Basic auth for dashboard (optional)
    WEB_PASS: "kingxd2024",
};
