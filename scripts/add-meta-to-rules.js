const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "../packages/email-parser-rules/src");

function walkDir(dir, callback) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walkDir(fullPath, callback);
    } else if (file.endsWith(".ts") && file !== "types.ts") {
      callback(fullPath);
    }
  }
}

walkDir(SRC_DIR, (filePath) => {
  const content = fs.readFileSync(filePath, "utf8");
  if (content.includes("description:") && content.includes("icon_url:")) {
    console.log(`Skipping (already updated): ${path.basename(filePath)}`);
    return;
  }

  // Extract name and id to formulate description
  const idMatch = content.match(/id:\s*"(.*?)"/);
  const nameMatch = content.match(/name:\s*"(.*?)"/);
  if (!idMatch || !nameMatch) {
    console.warn(`No id or name found in ${filePath}`);
    return;
  }

  const id = idMatch[1];
  const name = nameMatch[1];
  const description = `${name} tracking rule`;
  const icon_url = `https://example.com/${id}-icon.png`;

  let updated = content;
  // Insert description and icon_url right after name: "..."
  const nameLineRegex = new RegExp(`name:\\s*"${name}",?`);
  const replacement = `name: "${name}",\n  description: "${description}",\n  icon_url: "${icon_url}",`;
  updated = updated.replace(nameLineRegex, replacement);

  fs.writeFileSync(filePath, updated, "utf8");
  console.log(`Updated ${path.basename(filePath)}`);
});
