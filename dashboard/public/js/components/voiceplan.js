// Fenêtre de dictée ou saisie de plan d'action (Web Speech API fr-FR ou texte).
// Envoie le message voiceplan.generate et attend voiceplan.created pour relecture.
import { escapeHtml } from "../core/util.js";
import { defaultHost } from "../core/state.js";

const SpeechRec = typeof window !== "undefined"
  ? (window.SpeechRecognition || window.webkitSpeechRecognition || null)
  : null;

let dialog = null;
let activeRecognition = null;
let isRecording = false;
let isGenerating = false;
let unsubHandler = null;

const micSvg = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M10 2.5a2.5 2.5 0 00-2.5 2.5v5a2.5 2.5 0 005 0V5a2.5 2.5 0 00-2.5-2.5z"/>' +
  '<path d="M4.5 9.5a5.5 5.5 0 0011 0M10 15v3M7.5 18h5"/></svg>';

const stopMicSvg = '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true">' +
  '<rect x="5" y="5" width="10" height="10" rx="1.5"/></svg>';

function createDialog() {
  const dlg = document.createElement("dialog");
  dlg.className = "dialog voiceplan-dialog";
  dlg.id = "voiceplan-dialog";
  dlg.setAttribute("aria-labelledby", "voiceplan-dialog-title");

  dlg.innerHTML = `
    <header class="voiceplan-head">
      <div class="voiceplan-title-group">
        <h2 class="voiceplan-title" id="voiceplan-dialog-title">Dicter ou écrire un plan</h2>
        <span class="voiceplan-sub">L'IA structure vos idées en tâches ordonnées à valider</span>
      </div>
      <button type="button" class="icon-btn voiceplan-close-btn" data-close aria-label="Fermer">&times;</button>
    </header>
    <form class="voiceplan-body" id="voiceplan-form">
      <div class="voiceplan-prompt-group">
        <label for="voiceplan-textarea" class="voiceplan-label">Vos instructions ou votre dictée :</label>
        <textarea id="voiceplan-textarea" name="text" class="voiceplan-textarea" rows="6" maxlength="4000"
          placeholder="Ex : Créer un composant d'authentification, ajouter les tests unitaires puis déployer..."
          required></textarea>
        <div class="voiceplan-mic-row">
          <div class="voiceplan-mic-controls">
            <button type="button" class="btn btn-sm voiceplan-mic-btn" id="voiceplan-mic-toggle">
              <span class="voiceplan-mic-icon" aria-hidden="true">${micSvg}</span>
              <span class="voiceplan-mic-text">Dicter</span>
            </button>
            <span class="voiceplan-mic-status" id="voiceplan-mic-status" aria-live="polite"></span>
          </div>
          <span class="voiceplan-char-count" id="voiceplan-char-count">0 / 4000</span>
        </div>
        <div class="voiceplan-speech-note" id="voiceplan-speech-note" hidden></div>
      </div>
      <div class="voiceplan-status-area" id="voiceplan-status-area" aria-live="polite"></div>
      <footer class="voiceplan-foot">
        <button type="button" class="btn voiceplan-cancel-btn" data-close>Annuler</button>
        <button type="submit" class="btn btn-primary voiceplan-submit-btn" id="voiceplan-submit-btn">
          Générer le plan
        </button>
      </footer>
    </form>`;

  document.body.append(dlg);
  return dlg;
}

export function openVoicePlanDialog({ ctx, onCreated, project = "", host = defaultHost() } = {}) {
  if (!dialog) {
    dialog = createDialog();
  }

  const form = dialog.querySelector("#voiceplan-form");
  const textarea = dialog.querySelector("#voiceplan-textarea");
  const micBtn = dialog.querySelector("#voiceplan-mic-toggle");
  const micIcon = dialog.querySelector(".voiceplan-mic-icon");
  const micText = dialog.querySelector(".voiceplan-mic-text");
  const micStatus = dialog.querySelector("#voiceplan-mic-status");
  const speechNote = dialog.querySelector("#voiceplan-speech-note");
  const charCount = dialog.querySelector("#voiceplan-char-count");
  const statusArea = dialog.querySelector("#voiceplan-status-area");
  const submitBtn = dialog.querySelector("#voiceplan-submit-btn");

  // Nettoyage de l'état
  textarea.value = "";
  charCount.textContent = "0 / 4000";
  statusArea.innerHTML = "";
  isGenerating = false;
  submitBtn.disabled = false;
  textarea.disabled = false;

  const updateCharCount = () => {
    const len = textarea.value.length;
    charCount.textContent = `${len} / 4000`;
  };
  textarea.oninput = updateCharCount;

  // Gestion Web Speech API
  const stopSpeech = () => {
    if (activeRecognition) {
      try { activeRecognition.stop(); } catch {}
      activeRecognition = null;
    }
    isRecording = false;
    micBtn.classList.remove("is-recording");
    micIcon.innerHTML = micSvg;
    micText.textContent = "Dicter";
    micStatus.textContent = "";
  };

  if (!SpeechRec) {
    micBtn.disabled = true;
    micBtn.title = "Reconnaissance vocale non supportée par votre navigateur (Web Speech API indisponible)";
    speechNote.hidden = false;
    speechNote.textContent = "Reconnaissance vocale indisponible dans ce navigateur (saisie textuelle active).";
  } else {
    micBtn.disabled = false;
    speechNote.hidden = true;
    micBtn.title = "Démarrer la dictée vocale (français)";

    micBtn.onclick = () => {
      if (isRecording) {
        stopSpeech();
        return;
      }

      try {
        const rec = new SpeechRec();
        rec.lang = "fr-FR";
        rec.continuous = true;
        rec.interimResults = true;

        let baseText = textarea.value;
        if (baseText && !baseText.endsWith(" ")) baseText += " ";

        rec.onstart = () => {
          isRecording = true;
          micBtn.classList.add("is-recording");
          micIcon.innerHTML = stopMicSvg;
          micText.textContent = "Arrêter";
          micStatus.textContent = "Écoute en cours…";
        };

        rec.onresult = (evt) => {
          let interim = "";
          let finalTranscript = "";
          for (let i = evt.resultIndex; i < evt.results.length; i++) {
            const part = evt.results[i][0].transcript;
            if (evt.results[i].isFinal) finalTranscript += part;
            else interim += part;
          }
          if (finalTranscript) {
            baseText += finalTranscript + " ";
          }
          textarea.value = (baseText + interim).slice(0, 4000);
          updateCharCount();
        };

        rec.onerror = (err) => {
          stopSpeech();
          micStatus.textContent = `Erreur micro : ${err.error || "accès refusé"}`;
        };

        rec.onend = () => {
          stopSpeech();
        };

        activeRecognition = rec;
        rec.start();
      } catch (err) {
        stopSpeech();
        micStatus.textContent = "Impossible d'activer le microphone.";
      }
    };
  }

  // Fermeture
  const close = () => {
    stopSpeech();
    if (unsubHandler) {
      unsubHandler();
      unsubHandler = null;
    }
    dialog.close();
  };

  dialog.querySelectorAll("[data-close]").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      close();
    };
  });

  dialog.oncancel = (e) => {
    e.preventDefault();
    close();
  };

  // Soumission
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text || isGenerating) return;

    stopSpeech();
    isGenerating = true;
    submitBtn.disabled = true;
    textarea.disabled = true;

    statusArea.innerHTML = `
      <div class="voiceplan-loading" role="status">
        <span class="voiceplan-spinner" aria-hidden="true"></span>
        <span>Génération du plan en cours avec l'IA…</span>
      </div>`;

    if (unsubHandler) unsubHandler();

    const handleCreated = (msg) => {
      if (msg.type === "voiceplan.created" && msg.itemId) {
        close();
        if (typeof onCreated === "function") {
          onCreated(msg.itemId);
        }
      }
    };

    const handleError = (msg) => {
      if (msg.type === "voiceplan.error" || (msg.type === "error" && isGenerating)) {
        isGenerating = false;
        submitBtn.disabled = false;
        textarea.disabled = false;
        const errText = msg.error || msg.message || "Erreur lors de la génération du plan.";
        statusArea.innerHTML = `
          <div class="voiceplan-error-banner" role="alert">
            ${escapeHtml(errText)}
          </div>`;
      }
    };

    const u1 = ctx.on("voiceplan.created", handleCreated);
    const u2 = ctx.on("voiceplan.error", handleError);
    const u3 = ctx.on("error", handleError);

    unsubHandler = () => {
      u1?.();
      u2?.();
      u3?.();
    };

    ctx.send({
      type: "voiceplan.generate",
      text,
      project,
      host,
    });
  };

  dialog.showModal();
  textarea.focus();
}
