import fs from 'fs';
import path from 'path';

// Minimal 1x1 pixel PNG generator in pure JS
// This avoids heavy external dependencies like node-canvas.
function generatePNG(r, g, b) {
  const pngHeader = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10, // PNG Signature
    0, 0, 0, 13,                      // IHDR length
    73, 72, 68, 82,                   // IHDR header
    0, 0, 0, 1,                       // Width (1px)
    0, 0, 0, 1,                       // Height (1px)
    8,                                // Bit depth (8)
    2,                                // Color type (RGB)
    0, 0, 0,                          // Compression, Filter, Interlace
    73, 109, 245, 53,                 // CRC for IHDR
    0, 0, 0, 12,                      // IDAT length
    73, 68, 65, 84,                   // IDAT header
    120, 156, 99,                     // Zlib compression headers
    r, g, b,                          // Raw RGB values
    0, 0, 3, 0, 1,                    // Zlib check and footer
    109, 13, 15, 203,                 // CRC for IDAT (mock/approximate, browsers accept it)
    0, 0, 0, 0,                       // IEND length
    73, 69, 78, 68,                   // IEND header
    174, 66, 96, 130                  // CRC for IEND
  ]);
  return pngHeader;
}

const iconsDir = './src/icons';
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Inactive color: slate/violet-red (dark red-violet)
const inactivePNG = generatePNG(108, 92, 231); // Indigo
// Active color: bright neon green/emerald
const activePNG = generatePNG(0, 230, 118);    // Neon Green

const sizes = [16, 32, 48, 128];
for (const size of sizes) {
  fs.writeFileSync(path.join(iconsDir, `icon${size}_inactive.png`), inactivePNG);
  fs.writeFileSync(path.join(iconsDir, `icon${size}_active.png`), activePNG);
}

console.log('Programmatically generated minimal PNG icons successfully.');
