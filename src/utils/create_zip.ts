import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import AdmZip from "adm-zip";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function createExtensionZip() {
  // Current dir: .../backend/src/utils
  // Needed: .../fake-detect/extension
  const extensionDir = path.resolve(__dirname, "../../../extension");
  const outputDir = path.resolve(__dirname, "../../../frontend/public");
  const outputPath = path.join(outputDir, "extension.zip");

  console.log(`[Zip] Zipping extension from: ${extensionDir}`);
  console.log(`[Zip] Output path: ${outputPath}`);

  if (!fs.existsSync(extensionDir)) {
    console.error(`[Zip] Error: Extension directory not found at ${extensionDir}`);
    process.exit(1);
  }

  if (!fs.existsSync(outputDir)) {
    console.log(`[Zip] Creating output directory: ${outputDir}`);
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    const zip = new AdmZip();
    // Add local folder
    zip.addLocalFolder(extensionDir);

    // Write file
    zip.writeZip(outputPath);
    console.log(`[Zip] Success! Created extension.zip at ${outputPath}`);
  } catch (error) {
    console.error("[Zip] Failed to create zip:", error);
    process.exit(1);
  }
}

createExtensionZip();
