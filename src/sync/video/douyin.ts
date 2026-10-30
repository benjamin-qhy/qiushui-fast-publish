import type { FileData, SyncData, VideoData } from "../common";

export async function VideoDouyin(data: SyncData, coverOnly = false, openOnly = false, horizontalOnly = false) {
  /**
   * Format date to yyyy-MM-dd HH:mm format
   * @param date - Date object to format
   * @returns Formatted date string
   */
  function formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  function waitForElement(selector: string, timeout = 10000): Promise<Element> {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }

      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          resolve(element);
          observer.disconnect();
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element with selector "${selector}" not found within ${timeout}ms`));
      }, timeout);
    });
  }

  async function uploadVideo(file: File): Promise<void> {
    const fileInput = (await waitForElement("input[type=file]")) as HTMLInputElement;

    // 创建一个新的 File 对象，因为某些浏览器可能不允许直接设置 fileInput.files
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInput.files = dataTransfer.files;

    // 触发 change 事件
    const changeEvent = new Event("change", { bubbles: true });
    fileInput.dispatchEvent(changeEvent);

    // 触发 input 事件
    const inputEvent = new Event("input", { bubbles: true });
    fileInput.dispatchEvent(inputEvent);

    console.log("视频上传事件已触发");
  }

  // Each supplied cover updates its own slot; the video aspect does not select a single cover.
  async function uploadCover(cover: FileData, role: "vertical" | "horizontal", openOnly = false): Promise<void> {
    const visible = (node: Element) =>
      Array.from(node.getClientRects()).some((r) => r.width > 0 && r.height > 0) &&
      getComputedStyle(node).display !== "none" &&
      getComputedStyle(node).visibility !== "hidden";
    const enabled = (node: HTMLElement) =>
      !(node as HTMLButtonElement).disabled && node.getAttribute("aria-disabled") !== "true";
    const wait = async <T>(read: () => T | undefined, code: string, timeout = 120000): Promise<T> => {
      const until = Date.now() + timeout;
      while (true) {
        const value = read();
        if (value !== undefined) return value;
        if (Date.now() >= until) throw new Error(code);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    };
    if (!cover.type?.startsWith("image/")) throw new Error("DOUYIN_COVER_INVALID_IMAGE");
    const dialogs = () =>
      Array.from(document.querySelectorAll<HTMLElement>(".dy-creator-content-modal")).filter(visible);
    if (!dialogs().length) {
      const trigger = await wait(() => {
        const roots = Array.from(document.querySelectorAll<HTMLElement>('[class*="coverControl-"]'))
          .filter(visible)
          .filter((node) => (node.textContent || "").includes(role === "vertical" ? "竖封面" : "横封面"));
        const edits = roots
          .flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>("*")))
          .filter((node) => enabled(node) && /^(编辑封面|选择封面)$/.test(node.textContent?.trim() || ""))
          .filter(
            (node) =>
              !Array.from(node.children).some((child) => /^(编辑封面|选择封面)$/.test(child.textContent?.trim() || "")),
          );
        return edits.length === 1 ? edits[0] : undefined;
      }, "DOUYIN_COVER_ENTRY_TIMEOUT");
      trigger.click();
    }
    const modal = await wait(() => {
      const roots = dialogs();
      return roots.length === 1 ? roots[0] : undefined;
    }, "DOUYIN_COVER_DIALOG_TIMEOUT");
    if (openOnly) return;
    const input = await wait(() => {
      const inputs = Array.from(modal.querySelectorAll<HTMLInputElement>('input[type="file"]'))
        .filter(
          (node) =>
            /image|\.png|\.jpe?g|\.webp/i.test(node.accept) && !node.disabled && !/replace/.test(node.className),
        )
        .filter(
          (node) =>
            !!node.parentElement &&
            visible(node.parentElement) &&
            /点击上传文件或拖拽文件到这里/.test(node.parentElement.textContent || ""),
        );
      return inputs.length === 1 ? inputs[0] : undefined;
    }, "DOUYIN_COVER_INPUT_TIMEOUT");
    const response = await fetch(cover.url);
    if (!response.ok) throw new Error("DOUYIN_COVER_FILE_READ_FAILED");
    const transfer = new DataTransfer();
    transfer.items.add(new File([await response.blob()], cover.name, { type: cover.type }));
    const images = () => Array.from(modal.querySelectorAll<HTMLImageElement>("img"));
    const canvases = () => Array.from(modal.querySelectorAll<HTMLCanvasElement>("canvas"));
    const pixels = (canvas: HTMLCanvasElement) => {
      try {
        return canvas.toDataURL();
      } catch {
        return "";
      }
    };
    const oldImages = new Map(images().map((image) => [image, image.currentSrc || image.src]));
    const oldCanvases = new Map(canvases().map((canvas) => [canvas, pixels(canvas)]));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const confirm = await wait(() => {
      const text = Array.from(modal.querySelectorAll<HTMLElement>("span, p, div"))
        .filter((node) => visible(node) && node.children.length === 0)
        .map((node) => node.textContent?.trim() || "");
      if (text.some((value) => /上传失败|图片加载失败|图片处理失败|格式不支持|文件过大/.test(value)))
        throw new Error("DOUYIN_COVER_UPLOAD_FAILED");
      const busy =
        Array.from(modal.querySelectorAll('[role="progressbar"], [aria-busy="true"], .upload-progress')).some(
          visible,
        ) || text.some((value) => /^(上传中|处理中|加载中|检测中)/.test(value));
      const ready =
        images().some(
          (image) =>
            visible(image) &&
            image.complete &&
            image.naturalWidth > 0 &&
            !!(image.currentSrc || image.src) &&
            (!oldImages.has(image) || oldImages.get(image) !== (image.currentSrc || image.src)),
        ) ||
        canvases().some(
          (canvas) =>
            visible(canvas) &&
            canvas.width > 0 &&
            canvas.height > 0 &&
            (!oldCanvases.has(canvas) || (!!pixels(canvas) && pixels(canvas) !== oldCanvases.get(canvas))),
        );
      const buttons = Array.from(modal.querySelectorAll<HTMLButtonElement>('button, [role="button"]')).filter(
        (node) => visible(node) && enabled(node) && /^(完成|确定)$/.test(node.textContent?.trim() || ""),
      );
      return !busy && ready && buttons.length === 1 ? buttons[0] : undefined;
    }, "DOUYIN_COVER_PROCESSING_TIMEOUT");
    confirm.click();
    // Some versions put an image crop confirmation inside the cover editor.
    const clicked = new Set<HTMLElement>([confirm]);
    await wait(() => {
      const roots = dialogs();
      if (!roots.length) return true;
      const buttons = roots
        .flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"]')))
        .filter(
          (node) =>
            visible(node) &&
            enabled(node) &&
            /^(完成|确定)$/.test(node.textContent?.trim() || "") &&
            !clicked.has(node),
        );
      if (buttons.length === 1 && clicked.size < 3) {
        clicked.add(buttons[0]);
        buttons[0].click();
      }
      return undefined;
    }, "DOUYIN_COVER_CONFIRM_TIMEOUT");
  }

  let stage = "video";
  const coverResults: string[] = [];
  const fillCovers = async () => {
    const files = data.data as VideoData;
    for (const [role, file] of [
      ["vertical", files.verticalCover || files.cover],
      ["horizontal", files.horizontalCover],
    ] as const) {
      if (!file) continue;
      stage = `cover_${role}`;
      await uploadCover(file, role);
      coverResults.push(role);
    }
  };
  try {
    if (coverOnly) {
      if (openOnly) {
        const files = data.data as VideoData;
        const cover = files.verticalCover || files.cover;
        if (!cover) throw new Error("DOUYIN_COVER_INVALID_IMAGE");
        stage = "cover_vertical";
        await uploadCover(cover, "vertical", true);
        return { ok: true, details: { coverOpened: true } };
      }
      if (horizontalOnly) {
        const cover = (data.data as VideoData).horizontalCover;
        if (!cover) throw new Error("DOUYIN_COVER_INVALID_IMAGE");
        stage = "cover_horizontal";
        await uploadCover(cover, "horizontal");
        coverResults.push("horizontal");
      } else await fillCovers();
      return { ok: true, coverConfirmed: true, details: { coverResults } };
    }
    const { content, video, title, tags, cover, horizontalCover, verticalCover, scheduledPublishTime } =
      data.data as VideoData;
    // 处理视频上传
    if (video) {
      const response = await fetch(video.url);
      const blob = await response.blob();
      const videoFile = new File([blob], video.name, { type: video.type });
      console.log(`视频文件: ${videoFile.name} ${videoFile.type} ${videoFile.size}`);

      await uploadVideo(videoFile);
      console.log("视频上传已初始化");
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 处理标题输入
    const titleInput = (await waitForElement('input[placeholder*="作品标题"]')) as HTMLInputElement;
    if (titleInput) {
      titleInput.value = title || "";
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
      console.log("标题已填写:", titleInput.value);
    }

    // 填写内容和标签
    const contentEditor = (await waitForElement(
      'div.zone-container.editor-kit-container.editor.editor-comp-publish[contenteditable="true"]',
    )) as HTMLDivElement;
    if (contentEditor) {
      // 填写描述内容
      contentEditor.focus();
      const contentPasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer(),
      });

      contentPasteEvent.clipboardData.setData("text/plain", `${content} `);
      contentEditor.dispatchEvent(contentPasteEvent);

      // 处理标签
      if (tags && tags.length > 0) {
        const tagsToSync = tags.slice(0, 5);
        for (const tag of tagsToSync) {
          console.log("添加标签:", tag);
          contentEditor.focus();

          const pasteEvent = new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: new DataTransfer(),
          });

          pasteEvent.clipboardData.setData("text/plain", ` #${tag}`);
          contentEditor.dispatchEvent(pasteEvent);

          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    await fillCovers();
    stage = "schedule";

    // 处理定时发布
    if (scheduledPublishTime) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const labels = document.querySelectorAll("label");
      console.log("labels -->", labels);
      const scheduledLabel = Array.from(labels).find((label) => label.textContent?.includes("定时发布"));
      console.log("scheduledLabel -->", scheduledLabel);
      if (scheduledLabel) {
        (scheduledLabel as HTMLElement).click();
        await new Promise((resolve) => setTimeout(resolve, 500));

        const publishTimeInput = document.querySelector('input[format="yyyy-MM-dd HH:mm"]') as HTMLInputElement;
        console.log("publishTimeInput -->", publishTimeInput);
        if (publishTimeInput) {
          publishTimeInput.value = formatDate(new Date(scheduledPublishTime));
          publishTimeInput.dispatchEvent(new Event("input", { bubbles: true }));
          publishTimeInput.dispatchEvent(new Event("change", { bubbles: true }));
          console.log("定时发布时间已设置:", publishTimeInput.value);
        }
      }
    }

    if (data.isAutoPublish === true) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const buttons = document.querySelectorAll("button");
      const publishButton = Array.from(buttons).find((button) => button.textContent === "发布");

      if (publishButton) {
        console.log("点击发布按钮");
        publishButton.click();
      } else {
        console.log('未找到"发布"按钮');
      }
    }
    return { ok: true, coverConfirmed: true, details: { coverResults } };
  } catch (error) {
    return {
      ok: false,
      code: String(error).match(/DOUYIN_COVER_[A-Z_]+/)?.[0] || "DOUYIN_STEP_FAILED",
      stage,
      details: { coverResults },
    };
  }
}
