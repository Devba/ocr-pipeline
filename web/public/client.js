(function () {
  const form = document.getElementById('ocr-form');
  const fileInput = document.getElementById('image');
  const profileSelect = document.getElementById('profile');
  const languageSelect = document.getElementById('language');
  const languageFlag = document.getElementById('language-flag');
  const clientPreprocessCheckbox = document.getElementById('client-preprocess');
  const clientPreprocessedInput = document.getElementById('client_preprocessed');
  const faceCheckTokenInput = document.getElementById('face_check_token');
  const testFaceCheckButton = document.getElementById('test-face-check');
  const statusNode = document.getElementById('client-status');
  const paypalButtonsContainer = document.getElementById('paypal-buttons');
  const metamaskButton = document.getElementById('pay-metamask');
  const paypalForm = document.getElementById('unlock-paypal');
  const metamaskForm = document.getElementById('unlock-metamask');
  const paypalOrderIdInput = document.getElementById('paypal_order_id');

  if (!form || !fileInput || !profileSelect || !languageSelect || !clientPreprocessCheckbox || !clientPreprocessedInput || !statusNode) {
    return;
  }

  const ui = window.UI_TRANSLATIONS || {};
  const antiBotConfig = window.ANTI_BOT_CONFIG || {};
  const faceCheckEnabled = antiBotConfig.faceCheckEnabled === true;
  const faceCheckTestMode = antiBotConfig.faceCheckTestMode !== false;
  const faceChallengeEndpoint = antiBotConfig.faceChallengeEndpoint || '/face-check/challenge';
  const faceChallengeTtlMs = Number(antiBotConfig.faceChallengeTtlMs || 2 * 60 * 1000);
  const validatorCore = window.ManuscriptValidationCore;
  function t(key, fallback) {
    return ui[key] || fallback;
  }

  const allowedExtensions = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff']);
  let lastFaceCheckAt = 0;

  const paymentConfig = window.PAYMENT_CONFIG || {};
  const documentIdFromPage = window.DOCUMENT_ID || '';
  const selectedLanguageFromPage = window.SELECTED_LANGUAGE || (languageSelect ? languageSelect.value : 'en');
  const paymentSuccessMessage = window.PAYMENT_SUCCESS_MESSAGE || '';
  const paymentSuccessTitle = window.PAYMENT_SUCCESS_TITLE || '¡Gracias!';

  (function showPaymentSuccessOnce() {
    if (!paymentSuccessMessage) {
      return;
    }
    if (!window.Swal || typeof window.Swal.fire !== 'function') {
      return;
    }
    try {
      const key = `paymentSuccessShown:${documentIdFromPage || 'unknown'}`;
      if (window.sessionStorage && sessionStorage.getItem(key) === '1') {
        return;
      }
      window.Swal.fire({
        icon: 'success',
        title: paymentSuccessTitle,
        text: paymentSuccessMessage,
        confirmButtonText: 'OK',
      });
      if (window.sessionStorage) {
        sessionStorage.setItem(key, '1');
      }
    } catch (_error) {
    }
  })();

  async function requestFaceCheckToken() {
    const url = new URL(faceChallengeEndpoint, window.location.origin);
    if (languageSelect && languageSelect.value) {
      url.searchParams.set('lng', languageSelect.value);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(t('faceCheckChallengeError', 'No se pudo generar un token seguro de verificación.'));
    }

    const payload = await response.json();
    if (!payload || !payload.token) {
      throw new Error(t('faceCheckChallengeError', 'No se pudo generar un token seguro de verificación.'));
    }

    return payload.token;
  }

  function getExtension(name) {
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot).toLowerCase() : '';
  }

  function setStatus(message, isError) {
    statusNode.textContent = message;
    statusNode.style.color = isError ? '#b91c1c' : '#333';
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('No se pudo leer la imagen.'));
      };
      image.src = url;
    });
  }

  async function detectFaceInImage(image) {
    if (typeof window.FaceDetector !== 'function') {
      return { hasFace: false, confidence: 0 };
    }

    try {
      const detector = new window.FaceDetector({ maxDetectedFaces: 3, fastMode: true });
      const faces = await detector.detect(image);
      if (faces && faces.length > 0) {
        const confidence = Math.min(1, 0.75 + faces.length * 0.1);
        return { hasFace: true, confidence };
      }
    } catch (_error) {
    }

    return { hasFace: false, confidence: 0 };
  }

  async function runCameraFaceCheck() {
    setStatus(t('faceCheckStarting', 'Iniciando chequeo facial por cámara...'), false);

    if (!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function')) {
      setStatus(t('faceCheckNoCamera', 'La cámara no está disponible en este navegador o dispositivo.'), true);
      return { ok: false };
    }

    if (typeof window.FaceDetector !== 'function') {
      setStatus(t('faceCheckUnsupported', 'Este navegador no soporta detección facial automática.'), true);
      return { ok: false };
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.playsInline = true;
      await video.play();
      await new Promise((resolve) => setTimeout(resolve, 400));

      const detector = new window.FaceDetector({ maxDetectedFaces: 2, fastMode: true });
      const faces = await detector.detect(video);
      if (!faces || faces.length === 0) {
        setStatus(t('faceCheckNoFace', 'No se detectó rostro en cámara. Intenta nuevamente.'), true);
        return { ok: false };
      }

      const token = await requestFaceCheckToken();
      if (faceCheckTokenInput) {
        faceCheckTokenInput.value = token;
      }
      lastFaceCheckAt = Date.now();
      setStatus(t('faceCheckOk', 'Chequeo facial completado para prueba.'), false);
      return { ok: true, token };
    } catch (_error) {
      setStatus(t('faceCheckError', 'No se pudo completar el chequeo facial.'), true);
      return { ok: false };
    } finally {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    }
  }

  async function detectLikelyPrintedText(file) {
    if (!validatorCore || typeof validatorCore.analyzeImageData !== 'function') {
      return { likelyPrinted: false, confidence: 0 };
    }

    const image = await loadImage(file);
    const faceCheck = await detectFaceInImage(image);
    const maxWidth = 900;
    const scale = image.width > maxWidth ? maxWidth / image.width : 1;
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      return { likelyPrinted: false, confidence: 0 };
    }

    ctx.drawImage(image, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const result = validatorCore.analyzeImageData(imageData.data, width, height);
    const likelyNoText = result.likelyNoText || faceCheck.hasFace;
    const noTextConfidence = Math.max(result.noTextConfidence || 0, faceCheck.confidence || 0);

    return {
      likelyPrinted: result.likelyPrinted,
      confidence: result.confidence,
      likelyNoText,
      noTextConfidence,
      metrics: result.metrics,
      detectorScores: result.detectorScores,
    };
  }

  async function preprocessInBrowser(file, profile) {
    const image = await loadImage(file);
    const scale = profile === 'historico' ? 1.6 : 1;
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('Tu navegador no soporta Canvas 2D.');
    }

    ctx.drawImage(image, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);

      let value = gray;
      if (profile === 'historico') {
        value = gray > 170 ? 255 : 0;
      } else {
        const contrast = 1.2;
        value = Math.max(0, Math.min(255, Math.round((gray - 128) * contrast + 128)));
      }

      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }

    ctx.putImageData(imageData, 0, 0);

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('No se pudo generar imagen preprocesada.'));
          return;
        }
        resolve(blob);
      }, 'image/png');
    });
  }

  form.addEventListener('submit', async (event) => {
    let shouldManualSubmit = false;
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      return;
    }

    if (faceCheckEnabled) {
      const maxAgeMs = faceChallengeTtlMs;
      const hasRecentFaceCheck = Boolean(faceCheckTokenInput && faceCheckTokenInput.value) && (Date.now() - lastFaceCheckAt <= maxAgeMs);
      if (!hasRecentFaceCheck) {
        event.preventDefault();
        shouldManualSubmit = true;
        setStatus(t('faceCheckRequired', 'Chequeo facial requerido antes de enviar.'), false);
        const faceCheckResult = await runCameraFaceCheck();
        if (!faceCheckResult.ok) {
          return;
        }
      }
    }

    const ext = getExtension(file.name);
    if (!allowedExtensions.has(ext)) {
      event.preventDefault();
      setStatus(t('unsupportedFormat', 'Formato no permitido. Usa PNG, JPG, JPEG, TIF o TIFF.'), true);
      return;
    }

    try {
      const check = await detectLikelyPrintedText(file);
      if (check.likelyNoText) {
        event.preventDefault();
        shouldManualSubmit = true;
        const confidencePercent = Math.round((check.noTextConfidence || 0) * 100);
        const warning = `${t('likelyNoTextWarning', 'La imagen parece no contener texto legible para OCR.')} (${confidencePercent}%)`;
        setStatus(warning, true);
        const proceedNoText = window.confirm(t('likelyNoTextConfirm', 'Esta imagen parece una foto sin texto. ¿Quieres continuar igualmente?'));
        if (!proceedNoText) {
          return;
        }
      }

      if (check.likelyPrinted) {
        event.preventDefault();
        shouldManualSubmit = true;
        const confidencePercent = Math.round(check.confidence * 100);
        const warning = `${t('likelyPrintedWarning', 'La imagen parece texto mecánico o digital.')} (${confidencePercent}%)`;
        setStatus(warning, true);
        const proceed = window.confirm(t('likelyPrintedConfirm', 'Parece no manuscrito. ¿Quieres continuar igualmente?'));
        if (!proceed) {
          return;
        }
      }
    } catch (_error) {
    }

    if (!clientPreprocessCheckbox.checked) {
      clientPreprocessedInput.value = '0';
      if (shouldManualSubmit) {
        form.submit();
      }
      return;
    }

    event.preventDefault();
    setStatus(t('preprocessing', 'Preprocesando imagen en navegador...'), false);

    try {
      const processedBlob = await preprocessInBrowser(file, profileSelect.value || 'historico');
      const processedFile = new File([processedBlob], 'preprocesada.png', { type: 'image/png' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(processedFile);
      fileInput.files = dataTransfer.files;
      clientPreprocessedInput.value = '1';
      setStatus(t('preprocessingReady', 'Preprocesado listo. Enviando al servidor...'), false);
      form.submit();
    } catch (error) {
      setStatus(error.message || t('preprocessingError', 'Error en preprocesado local.'), true);
    }
  });

  function simulatePayment(button, targetForm, label) {
    if (!button || !targetForm) {
      return;
    }

    button.addEventListener('click', () => {
      button.disabled = true;
      setStatus(t('connectingPayment', 'Conectando con {{method}} (simulado)...').replace('{{method}}', label), false);
      setTimeout(() => {
        setStatus(t('paymentAuthorized', 'Pago en {{method}} autorizado (simulado).').replace('{{method}}', label), false);
        targetForm.submit();
      }, 900);
    });
  }

  function setupPayPalSmartButtons() {
    const enabled = paymentConfig && paymentConfig.paypalEnabled === true;
    if (!enabled) {
      return;
    }

    if (!paypalButtonsContainer) {
      return;
    }

    if (!window.paypal || typeof window.paypal.Buttons !== 'function') {
      setStatus('PayPal SDK no disponible.', true);
      return;
    }

    window.paypal.Buttons({
      style: {
        layout: 'vertical',
        color: 'gold',
        shape: 'rect',
        label: 'paypal',
      },
      createOrder: async () => {
        const response = await fetch(paymentConfig.paypalCreateOrderEndpoint || '/api/paypal/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            document_id: documentIdFromPage,
            language: selectedLanguageFromPage,
          }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.orderId) {
          throw new Error(data.error || 'No se pudo crear la orden de PayPal.');
        }
        return data.orderId;
      },
      onApprove: async (data) => {
        const orderId = data && data.orderID ? String(data.orderID) : '';
        if (!orderId) {
          setStatus('Orden PayPal inválida.', true);
          return;
        }

        const response = await fetch(paymentConfig.paypalCaptureOrderEndpoint || '/api/paypal/capture-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            order_id: orderId,
            document_id: documentIdFromPage,
            language: selectedLanguageFromPage,
          }),
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
          setStatus(payload.error || 'No se pudo capturar el pago en PayPal.', true);
          return;
        }

        if (paypalOrderIdInput) {
          paypalOrderIdInput.value = orderId;
        }

        if (paypalForm) {
          paypalForm.submit();
        }
      },
      onCancel: () => {
        setStatus('Pago cancelado.', true);
      },
      onError: (err) => {
        const message = err && err.message ? String(err.message) : 'Error PayPal.';
        setStatus(message, true);
      },
    }).render('#paypal-buttons');
  }

  setupPayPalSmartButtons();
  simulatePayment(metamaskButton, metamaskForm, 'MetaMask');

  if (testFaceCheckButton && faceCheckTestMode) {
    testFaceCheckButton.addEventListener('click', async () => {
      testFaceCheckButton.disabled = true;
      await runCameraFaceCheck();
      testFaceCheckButton.disabled = false;
    });
  }

  languageSelect.addEventListener('change', () => {
    if (languageFlag) {
      const rawFlags = languageSelect.dataset.flags;
      if (rawFlags) {
        try {
          const flags = JSON.parse(rawFlags);
          languageFlag.textContent = flags[languageSelect.value] || '🌐';
        } catch (_error) {
        }
      }
    }
    const url = new URL(window.location.href);
    url.searchParams.set('lng', languageSelect.value);
    window.location.href = url.toString();
  });
})();
