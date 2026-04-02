const { default: pngToIco } = require('png-to-ico');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const os = require('os');

const input = path.join(__dirname, 'assets', 'icon.png');
const output = path.join(__dirname, 'assets', 'icon.ico');
const sizes = [16, 32, 48, 64, 128, 256];

async function build() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-'));
  const tmpFiles = [];
  for (const s of sizes) {
    const tmp = path.join(tmpDir, `icon-${s}.png`);
    await sharp(input).resize(s, s).png().toFile(tmp);
    tmpFiles.push(tmp);
  }
  const ico = await pngToIco(tmpFiles);
  fs.writeFileSync(output, ico);
  for (const f of tmpFiles) fs.unlinkSync(f);
  fs.rmdirSync(tmpDir);
  console.log(`Created assets/icon.ico with sizes: ${sizes.join(', ')}`);
}

build().catch(err => { console.error(err); process.exit(1); });
