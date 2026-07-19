const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const srcDir = path.join(root, "src", "renderer");
const destDir = path.join(root, "dist", "renderer");

fs.mkdirSync(destDir, { recursive: true });

for (const file of ["index.html", "unlock.html"]) {
  const srcFile = path.join(srcDir, file);
  const destFile = path.join(destDir, file);
  fs.copyFileSync(srcFile, destFile);
}

console.log("Renderer assets copied to dist/renderer");
