// Generate PWA icons — simple PNG without external dependencies
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

function createPNG(width, height, r, g, b) {
  // Build raw image data
  const raw = [];
  for (let y = 0; y < height; y++) {
    raw.push(0); // filter byte
    for (let x = 0; x < width; x++) {
      // Draw a simple kanban-like icon: colored background with white stripes
      const cx = width / 2;
      const cy = height / 2;
      const rx = width * 0.35;
      const ry = height * 0.35;

      // Three columns (kanban board representation)
      const colW = width / 5;
      const colX = x % colW;
      const colIdx = Math.floor(x / colW);

      let pr = r, pg = g, pb = b;
      if (colIdx === 1 || colIdx === 3) {
        // White columns on colored background
        const pad = width * 0.08;
        const gap = width * 0.02;
        const left = colIdx * colW + pad;
        const right = (colIdx + 1) * colW - pad;
        if (x > left && x < right && y > height * 0.08 && y < height * 0.92) {
          pr = 255; pg = 255; pb = 255;
          // Cards inside columns
          const cardH = height * 0.12;
          const cardGap = height * 0.06;
          const startY = height * 0.15;
          for (let c = 0; c < 4; c++) {
            const cardY = startY + c * (cardH + cardGap);
            if (y > cardY && y < cardY + cardH) {
              pr = Math.round(r * 0.7);
              pg = Math.round(g * 0.7);
              pb = Math.round(b * 0.7);
            }
          }
        }
      }
      raw.push(pr, pg, pb, 255);
    }
  }

  const deflated = zlib.deflateSync(Buffer.from(raw));

  // CRC32
  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        if (crc & 1) crc = (crc >>> 1) ^ 0xedb88320;
        else crc >>>= 1;
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([len, typeAndData, crc]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflated),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Generate icons
const icon192 = path.join(__dirname, "public", "icon-192.png");
const icon512 = path.join(__dirname, "public", "icon-512.png");
fs.writeFileSync(icon192, createPNG(192, 192, 79, 70, 229));
fs.writeFileSync(icon512, createPNG(512, 512, 79, 70, 229));
console.log("Icons generated: icon-192.png, icon-512.png");