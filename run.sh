const { spawn, execSync } = require("child_process");

try {
  execSync("chmod +x ./cloudflared");
  console.log("✅ cloudflared permissions fixed");
} catch (err) {
  console.error("❌ Failed to chmod cloudflared:", err);
}

const cloudflared = spawn("./cloudflared", [
  "tunnel",
  "run",
  "--token",
  "eyJhIjoiN2YyMjUzNmU4YTk1ZGI4ZDcxM2U2ZTRmYWU4ZDUzMzIiLCJ0IjoiZmU3YzIxZWYtNWIzOS00MTE4LTg3OGYtNjUyZjZjOTQyZWNkIiwicyI6Ik1XTTFNVFUyWm1RdFpERmhaUzAwWXpBd0xXSmlOalV0T0dSbU5EaGtaRFZqTkdNeCJ9" 
]);


const bot = spawn("node", ["index.js"], {
  stdio: ["pipe", "inherit", "inherit"]
});

cloudflared.stdout.pipe(bot.stdin);

cloudflared.stderr.on("data", (data) => {
  console.error(`[cloudflared ERROR] ${data}`);
});

cloudflared.on("close", (code) => {
  console.log(`❌ cloudflared exited with code ${code}`);
  bot.stdin.end();
});

bot.on("close", (code) => {
  console.log(`❌ Bot exited with code ${code}`);
});
