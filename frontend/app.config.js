cat > app.config.js << 'EOF'
require('dotenv').config();

const { withStringsXml } = require("expo/config-plugins");

const MAPBOX_TOKEN = process.env.MAPBOX_ACCESS_TOKEN || "";
const MAPBOX_DOWNLOADS_TOKEN = process.env.MAPBOX_DOWNLOADS_TOKEN || "";

console.log("\n🔍 VERIFYING MAPBOX CONFIGURATION:");
console.log(`   Access Token present: ${MAPBOX_TOKEN ? "✅ YES" : "❌ NO"}`);
console.log(`   Access Token length: ${MAPBOX_TOKEN.length} characters`);
console.log(`   Downloads Token present: ${MAPBOX_DOWNLOADS_TOKEN ? "✅ YES" : "❌ NO"}`);
console.log(`   Downloads Token length: ${MAPBOX_DOWNLOADS_TOKEN.length} characters`);
console.log(`   EAS Build: ${process.env.EAS_BUILD ? "✅ YES" : "❌ NO"}`);

if (!MAPBOX_TOKEN && process.env.EAS_BUILD === "true") {
  throw new Error("❌ FATAL: MAPBOX_ACCESS_TOKEN is required for EAS Build!");
}

const withMapboxToken = (config) => {
  console.log("📝 Running withMapboxToken plugin...");
  return withStringsXml(config, (mod) => {
    const strings = mod.modResults.resources.string || [];
    const filtered = strings.filter(
      (item) => item.$ && item.$.name !== "mapbox_access_token"
    );
    filtered.push({
      $: { name: "mapbox_access_token", translatable: "false" },
      _: MAPBOX_TOKEN || "TOKEN_MISSING_CHECK_EAS_CONFIG",
    });
    mod.modResults.resources.string = filtered;
    console.log(`✅ Injected Mapbox token into strings.xml (length: ${MAPBOX_TOKEN.length})`);
    return mod;
  });
};

module.exports = {
  expo: {
    name: "Se-Q",
    slug: "se-q",
    version: "2.1.9",
    owner: "dontonero",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "safeguard",
    userInterfaceStyle: "dark",
    newArchEnabled: true,
    splash: {
      image: "./assets/images/splash-image.png",
      resizeMode: "contain",
      backgroundColor: "#0F172A"
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.seq.app"
    },
    android: {
      adaptiveIcon: {
        foregroundImage: "./assets/images/adaptive-icon.png",
        backgroundColor: "#0F172A"
      },
      package: "com.seq.app",
      permissions: [
        "ACCESS_FINE_LOCATION",
        "ACCESS_COARSE_LOCATION",
        "ACCESS_BACKGROUND_LOCATION",
        "CAMERA",
        "RECORD_AUDIO",
        "SEND_SMS",
        "READ_PHONE_STATE",
        "RECEIVE_BOOT_COMPLETED",
        "VIBRATE",
        "WAKE_LOCK",
        "FOREGROUND_SERVICE",
        "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"
      ]
    },
    extra: {
      eas: {
        projectId: "a4513a14-613a-4f0c-b4e1-2987e9f619f4"
      },
      backendUrl: "https://se-q-production.up.railway.app",
      mapboxAccessToken: MAPBOX_TOKEN,
      mapboxDownloadsToken: MAPBOX_DOWNLOADS_TOKEN
    },
    plugins: [withMapboxToken]
  }
};
EOF
