import { rgbaToGifBlob } from "./gif.js";

const fileInput = document.querySelector("#file-input");
const convertButton = document.querySelector("#convert-button");
const clearButton = document.querySelector("#clear-button");
const dropPanel = document.querySelector("#drop-panel");
const results = document.querySelector("#results");
const statusText = document.querySelector("#status-text");
const template = document.querySelector("#result-template");

const selectedFiles = new Map();
const itemViews = new Map();

fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});

convertButton.addEventListener("click", () => {
  convertAll().catch((error) => {
    console.error(error);
    setStatus("予期しないエラーが発生しました。ページを再読み込みしてもう一度試してください。");
  });
});

clearButton.addEventListener("click", () => {
  selectedFiles.clear();
  itemViews.clear();
  results.textContent = "";
  syncButtons();
  setStatus("選択をクリアしました。");
});

["dragenter", "dragover"].forEach((eventName) => {
  dropPanel.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropPanel.classList.add("is-targeted");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropPanel.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (eventName === "drop") {
      addFiles(event.dataTransfer.files);
    }
    dropPanel.classList.remove("is-targeted");
  });
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Offline support is optional.
    });
  });
}

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => file.type === "image/webp" || file.name.toLowerCase().endsWith(".webp"));
  if (!files.length) {
    setStatus("WebP ファイルだけを追加できます。");
    return;
  }

  for (const file of files) {
    const key = `${file.name}-${file.size}-${file.lastModified}`;
    if (!selectedFiles.has(key)) {
      selectedFiles.set(key, file);
      createCard(key, file);
    }
  }

  syncButtons();
  setStatus(`${selectedFiles.size} 件の WebP を準備しました。`);
}

function createCard(key, file) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.key = key;
  node.querySelector(".file-name").textContent = file.name;
  node.querySelector(".file-note").textContent = `${formatBytes(file.size)} / 未変換`;
  node.querySelector(".file-state").textContent = "待機中";
  const download = node.querySelector(".download-button");
  download.removeAttribute("href");
  download.classList.remove("ready");
  download.textContent = "GIF を保存";
  results.append(node);
  itemViews.set(key, {
    root: node,
    note: node.querySelector(".file-note"),
    state: node.querySelector(".file-state"),
    bar: node.querySelector(".progress-bar"),
    download
  });
}

async function convertAll() {
  if (!selectedFiles.size) {
    return;
  }

  convertButton.disabled = true;
  clearButton.disabled = true;
  fileInput.disabled = true;
  setStatus("変換を開始しました。iPhone では大きい画像ほど少し時間がかかります。");

  let completed = 0;
  let failed = 0;
  const entries = Array.from(selectedFiles.entries());

  for (const [key, file] of entries) {
    const view = itemViews.get(key);
    setCardState(view, "変換中", "is-working");
    updateProgress(view, 0.04);
    view.note.textContent = `${formatBytes(file.size)} / 読み込み中`;

    try {
      const gifBlob = await convertWebPToGif(file, (progress, label) => {
        updateProgress(view, progress);
        view.note.textContent = `${formatBytes(file.size)} / ${label}`;
        view.state.textContent = `${Math.round(progress * 100)}%`;
      });

      const downloadURL = URL.createObjectURL(gifBlob);
      view.download.href = downloadURL;
      view.download.download = replaceExtension(file.name, "gif");
      view.download.classList.add("ready");
      view.note.textContent = `${formatBytes(gifBlob.size)} / 変換済み`;
      updateProgress(view, 1);
      setCardState(view, "完了", "is-success");
      completed += 1;
    } catch (error) {
      console.error(error);
      updateProgress(view, 1);
      view.note.textContent = error.message || "変換に失敗しました。";
      setCardState(view, "失敗", "is-error");
      failed += 1;
    }

    await nextFrame();
  }

  fileInput.disabled = false;
  clearButton.disabled = false;
  syncButtons();
  setStatus(failed ? `${completed} 件成功、${failed} 件失敗しました。` : `${completed} 件すべて GIF に変換しました。`);
}

async function convertWebPToGif(file, onProgress) {
  onProgress(0.08, "画像を開いています");
  const bitmap = await loadBitmap(file);
  await nextFrame();

  onProgress(0.18, "ピクセルを取り出しています");
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  if (typeof bitmap.close === "function") {
    bitmap.close();
  }
  await nextFrame();

  return rgbaToGifBlob(
    { data: imageData.data, width: canvas.width, height: canvas.height },
    onProgress
  );
}

async function loadBitmap(file) {
  if ("createImageBitmap" in window) {
    return createImageBitmap(file);
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像を読み込めませんでした。"));
    };
    image.src = url;
  });
}

function setCardState(view, text, stateClass) {
  view.root.classList.remove("is-working", "is-success", "is-error");
  if (stateClass) {
    view.root.classList.add(stateClass);
  }
  view.state.textContent = text;
}

function updateProgress(view, progress) {
  view.bar.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
}

function setStatus(text) {
  statusText.textContent = text;
}

function syncButtons() {
  const hasFiles = selectedFiles.size > 0;
  convertButton.disabled = !hasFiles;
  clearButton.disabled = !hasFiles;
}

function replaceExtension(name, extension) {
  return name.replace(/\.[^/.]+$/, "") + `.${extension}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
