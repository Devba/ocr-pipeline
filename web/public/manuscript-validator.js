(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.ManuscriptValidationCore = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const defaultConfig = {
    downsampleMaxWidth: 900,
    edgeMagnitudeThreshold: 55,
    printedDecisionThreshold: 0.66,
  };

  const detectors = [];

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function mean(values) {
    if (!values.length) {
      return 0;
    }
    return values.reduce((acc, current) => acc + current, 0) / values.length;
  }

  function std(values, valuesMean) {
    if (!values.length) {
      return 0;
    }
    const variance = values.reduce((acc, current) => {
      const diff = current - valuesMean;
      return acc + diff * diff;
    }, 0) / values.length;
    return Math.sqrt(variance);
  }

  function getGrayAt(gray, width, x, y) {
    return gray[y * width + x];
  }

  function toGray(rgba, width, height) {
    const gray = new Uint8Array(width * height);
    let total = 0;
    for (let i = 0, pixel = 0; i < rgba.length; i += 4, pixel += 1) {
      const g = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
      gray[pixel] = g;
      total += g;
    }
    return { gray, meanGray: total / gray.length };
  }

  function computeMetrics(rgba, width, height, config) {
    const { gray, meanGray } = toGray(rgba, width, height);
    const threshold = clamp(Math.round(meanGray - 15), 70, 200);
    let darkPixels = 0;

    const rowDarkRatio = new Float32Array(height);
    for (let y = 0; y < height; y += 1) {
      let darkCount = 0;
      for (let x = 0; x < width; x += 1) {
        if (gray[y * width + x] < threshold) {
          darkCount += 1;
          darkPixels += 1;
        }
      }
      rowDarkRatio[y] = darkCount / width;
    }

    const rowValues = Array.from(rowDarkRatio);
    const rowMean = mean(rowValues);
    const rowStd = std(rowValues, rowMean);
    const peakThreshold = rowMean + rowStd;

    const peaks = [];
    for (let y = 0; y < height; y += 1) {
      if (rowDarkRatio[y] > peakThreshold) {
        peaks.push(y);
      }
    }

    const spacings = [];
    for (let i = 1; i < peaks.length; i += 1) {
      const distance = peaks[i] - peaks[i - 1];
      if (distance > 2) {
        spacings.push(distance);
      }
    }

    const spacingMean = mean(spacings);
    const spacingStd = std(spacings, spacingMean);
    const spacingCv = spacingMean > 0 ? spacingStd / spacingMean : 1;

    let strongEdges = 0;
    let axisAlignedEdges = 0;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const left = getGrayAt(gray, width, x - 1, y);
        const right = getGrayAt(gray, width, x + 1, y);
        const up = getGrayAt(gray, width, x, y - 1);
        const down = getGrayAt(gray, width, x, y + 1);
        const gx = right - left;
        const gy = down - up;
        const magnitude = Math.abs(gx) + Math.abs(gy);
        if (magnitude > config.edgeMagnitudeThreshold) {
          strongEdges += 1;
          if (Math.abs(gx) > Math.abs(gy) * 2 || Math.abs(gy) > Math.abs(gx) * 2) {
            axisAlignedEdges += 1;
          }
        }
      }
    }

    const axisRatio = strongEdges > 0 ? axisAlignedEdges / strongEdges : 0;
    const edgeDensity = strongEdges / Math.max(1, (width - 2) * (height - 2));
    const darkPixelRatio = darkPixels / Math.max(1, width * height);

    return {
      width,
      height,
      threshold,
      peakCount: peaks.length,
      spacingCv,
      axisRatio,
      edgeDensity,
      darkPixelRatio,
    };
  }

  function registerDetector(detector) {
    if (!detector || typeof detector.id !== 'string' || typeof detector.evaluate !== 'function') {
      throw new Error('Detector inválido. Requiere id y evaluate(metrics).');
    }
    detectors.push(detector);
  }

  function resetDetectors() {
    detectors.length = 0;
  }

  function analyzeImageData(rgbaData, width, height, partialConfig) {
    const config = { ...defaultConfig, ...(partialConfig || {}) };
    const metrics = computeMetrics(rgbaData, width, height, config);

    const scores = [];
    let weightedSum = 0;
    let weightSum = 0;

    for (const detector of detectors) {
      const weight = typeof detector.weight === 'number' ? detector.weight : 1;
      const score = clamp(detector.evaluate(metrics), 0, 1);
      scores.push({ id: detector.id, score, weight });
      weightedSum += score * weight;
      weightSum += weight;
    }

    const confidence = weightSum > 0 ? weightedSum / weightSum : 0;
    const likelyPrinted = confidence >= config.printedDecisionThreshold;

    let noTextScore = 0;
    if (metrics.peakCount < 6) {
      noTextScore += 0.5;
    }
    if (metrics.spacingCv > 1.2) {
      noTextScore += 0.2;
    }
    if (metrics.axisRatio < 0.45) {
      noTextScore += 0.2;
    }
    if (metrics.darkPixelRatio < 0.015 || metrics.darkPixelRatio > 0.85) {
      noTextScore += 0.1;
    }

    const likelyNoText = noTextScore >= 0.6;
    const noTextConfidence = clamp(noTextScore, 0, 1);

    return {
      likelyPrinted,
      confidence,
      likelyNoText,
      noTextConfidence,
      metrics,
      detectorScores: scores,
      config,
    };
  }

  registerDetector({
    id: 'peak_density',
    weight: 0.34,
    evaluate(metrics) {
      return clamp((metrics.peakCount - 4) / 12, 0, 1);
    },
  });

  registerDetector({
    id: 'line_spacing_regularity',
    weight: 0.33,
    evaluate(metrics) {
      return clamp((0.9 - metrics.spacingCv) / 0.9, 0, 1);
    },
  });

  registerDetector({
    id: 'axis_aligned_edges',
    weight: 0.33,
    evaluate(metrics) {
      return clamp((metrics.axisRatio - 0.35) / 0.55, 0, 1);
    },
  });

  return {
    defaultConfig,
    registerDetector,
    resetDetectors,
    analyzeImageData,
  };
}));
