#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const validator = require('../public/manuscript-validator.js');

const samplesDir = path.join(__dirname, '..', 'test_samples');

async function analyzeFile(filePath) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const result = validator.analyzeImageData(data, info.width, info.height);
  return {
    file: path.basename(filePath),
    likelyPrinted: result.likelyPrinted,
    confidence: result.confidence,
    peakCount: result.metrics.peakCount,
    spacingCv: result.metrics.spacingCv,
    axisRatio: result.metrics.axisRatio,
  };
}

function expectedForFile(fileName) {
  if (fileName.startsWith('printed_')) {
    return true;
  }
  if (fileName.startsWith('hand_')) {
    return false;
  }
  return null;
}

async function main() {
  if (!fs.existsSync(samplesDir)) {
    console.error('Missing test samples. Run: python3 web/scripts/generate_validation_samples.py');
    process.exit(1);
  }

  const files = fs.readdirSync(samplesDir)
    .filter((name) => name.endsWith('.png'))
    .sort();

  if (!files.length) {
    console.error('No .png samples found in web/test_samples');
    process.exit(1);
  }

  const rows = [];
  let checked = 0;
  let correct = 0;

  for (const file of files) {
    const row = await analyzeFile(path.join(samplesDir, file));
    const expected = expectedForFile(file);
    let verdict = 'n/a';

    if (expected !== null) {
      checked += 1;
      const ok = expected === row.likelyPrinted;
      if (ok) {
        correct += 1;
      }
      verdict = ok ? 'ok' : 'fail';
    }

    rows.push({
      file: row.file,
      predicted: row.likelyPrinted ? 'printed' : 'handwritten',
      confidence: row.confidence.toFixed(3),
      peakCount: row.peakCount,
      spacingCv: row.spacingCv.toFixed(3),
      axisRatio: row.axisRatio.toFixed(3),
      verdict,
    });
  }

  console.table(rows);

  if (checked > 0) {
    const accuracy = correct / checked;
    console.log(`Accuracy on labeled synthetic samples: ${(accuracy * 100).toFixed(1)}% (${correct}/${checked})`);
    if (accuracy < 0.5) {
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
