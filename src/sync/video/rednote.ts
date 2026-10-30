import type { SyncData, VideoData } from "../common";

export async function VideoRednote(data: SyncData, coverOnly = false) {
  const { content, video, title, tags, cover, scheduledPublishTime } = data.data as VideoData;

  // 辅助函数：等待元素出现
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

  // 辅助函数：上传文件
  async function uploadVideo() {
    const fileInput = (await waitForElement('input[type="file"]')) as HTMLInputElement;
    if (!fileInput) {
      console.error("未找到文件输入元素");
      return;
    }

    const dataTransfer = new DataTransfer();

    if (video) {
      try {
        const response = await fetch(video.url);
        if (!response.ok) {
          throw new Error(`HTTP 错误! 状态: ${response.status}`);
        }
        const blob = await response.blob();
        const file = new File([blob], video.name, { type: video.type });
        dataTransfer.items.add(file);
      } catch (error) {
        console.error(`上传视频 ${video.url} 失败:`, error);
      }
    }

    if (dataTransfer.files.length > 0) {
      fileInput.files = dataTransfer.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 2000)); // 等待文件处理
      console.log("文件上传操作完成");
    } else {
      console.error("没有成功添加任何文件");
    }
  }

  /**
   * 设置定时发布时间
   * @param scheduledPublishTime - 定时发布时间戳（毫秒）
   */
  async function setScheduledPublishTime(scheduledPublishTime: number): Promise<void> {
    const labels = document.querySelectorAll("label");
    console.debug("labels -->", labels);

    const scheduledLabel = Array.from(labels).find((label) => label.textContent?.includes("定时发布"));
    console.debug("label -->", scheduledLabel);

    if (scheduledLabel) {
      (scheduledLabel as HTMLElement).click();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const publishTimeInput = document.querySelector('input[placeholder="选择日期和时间"]') as HTMLInputElement;
    console.debug("publishTimeInput -->", publishTimeInput);

    if (publishTimeInput) {
      // 计算时间：添加 8 小时（28800000 毫秒）以调整时区
      const adjustedTime = new Date(scheduledPublishTime + 28800000);
      const formattedTime = adjustedTime.toISOString().slice(0, 16).replace("T", " ");

      publishTimeInput.focus();
      await new Promise((resolve) => setTimeout(resolve, 100));

      publishTimeInput.value = formattedTime;
      publishTimeInput.dispatchEvent(new Event("input", { bubbles: true }));
      publishTimeInput.dispatchEvent(new Event("change", { bubbles: true }));
      publishTimeInput.blur();

      console.debug("定时发布时间已设置:", formattedTime);
    }
  }

  // The platform may already have a video-frame cover. Operate inside its cover editor.
  async function uploadCover(coverFile: NonNullable<VideoData["cover"]>) {
    const visible = (node: Element) =>
      Array.from(node.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0) &&
      getComputedStyle(node).visibility !== "hidden" &&
      getComputedStyle(node).display !== "none";
    const enabled = (node: HTMLElement) =>
      visible(node) && !(node as HTMLButtonElement).disabled && node.getAttribute("aria-disabled") !== "true";
    const wait = async <T>(read: () => T | undefined, code: string, timeout = 60000): Promise<T> => {
      const deadline = Date.now() + timeout;
      while (true) {
        const result = read();
        if (result !== undefined) return result;
        if (Date.now() >= deadline) throw new Error(code);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    };
    const dialogs = () =>
      Array.from(document.querySelectorAll<HTMLElement>(".main-cover-editor-modal")).filter(visible);
    const modal = () => {
      const nodes = dialogs();
      return nodes.length === 1 ? nodes[0] : undefined;
    };
    if (!coverFile.type?.startsWith("image/")) throw new Error("REDNOTE_COVER_INVALID_IMAGE");

    const trigger = await wait(() => {
      const empty = Array.from(document.querySelectorAll<HTMLElement>("div.noCover.uploadCover")).filter(enabled);
      if (empty.length === 1) return empty[0];
      const roots = Array.from(document.querySelectorAll<HTMLElement>(".cover-plugin-preview .cover--column")).filter(
        visible,
      );
      const edits = roots
        .flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>("*")))
        .filter((node) => !node.hasAttribute("disabled") && node.textContent?.trim() === "编辑封面")
        .filter((node) => !Array.from(node.children).some((child) => child.textContent?.trim() === "编辑封面"));
      return edits.length === 1 ? edits[0] : undefined;
    }, "REDNOTE_COVER_ENTRY_TIMEOUT");
    trigger.click();
    const dialog = await wait(modal, "REDNOTE_COVER_DIALOG_TIMEOUT");
    const input = await wait(() => {
      const inputs = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter(
        (node) => /image|\.png|\.jpe?g|\.webp/i.test(node.accept) && !/replace/.test(node.className) && !node.disabled,
      );
      return inputs.length === 1 ? inputs[0] : undefined;
    }, "REDNOTE_COVER_INPUT_TIMEOUT");
    const response = await fetch(coverFile.url);
    if (!response.ok) throw new Error("REDNOTE_COVER_FILE_READ_FAILED");
    const blob = await response.blob();
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], coverFile.name, { type: coverFile.type }));

    const canvases = () => Array.from(dialog.querySelectorAll<HTMLCanvasElement>("canvas"));
    const canvasState = (canvas: HTMLCanvasElement) => {
      try {
        return canvas.toDataURL();
      } catch {
        return "";
      }
    };
    const oldImages = new Map(
      Array.from(dialog.querySelectorAll<HTMLImageElement>("img")).map((image) => [
        image,
        image.currentSrc || image.src,
      ]),
    );
    const oldCanvases = new Map(canvases().map((canvas) => [canvas, canvasState(canvas)]));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const confirm = await wait(
      () => {
        if (!visible(dialog)) throw new Error("REDNOTE_COVER_DIALOG_CLOSED");
        const messages = Array.from(dialog.querySelectorAll<HTMLElement>("span, p, div"))
          .filter((node) => visible(node) && node.children.length === 0)
          .map((node) => node.textContent?.trim() || "");
        if (messages.some((text) => /上传失败|图片加载失败|图片处理失败|格式不支持|文件过大/.test(text)))
          throw new Error("REDNOTE_COVER_UPLOAD_FAILED");
        const busy =
          Array.from(dialog.querySelectorAll('[role="progressbar"], .upload-progress, [aria-busy="true"]')).some(
            visible,
          ) || messages.some((text) => /^(上传中|加载中|处理中|检测中)/.test(text));
        const imageReady = Array.from(dialog.querySelectorAll<HTMLImageElement>("img")).some(
          (image) =>
            visible(image) &&
            image.complete &&
            image.naturalWidth > 0 &&
            !!(image.currentSrc || image.src) &&
            (!oldImages.has(image) || oldImages.get(image) !== (image.currentSrc || image.src)),
        );
        const canvasReady = canvases().some(
          (canvas) =>
            visible(canvas) &&
            canvas.width > 0 &&
            canvas.height > 0 &&
            (!oldCanvases.has(canvas) || (!!canvasState(canvas) && oldCanvases.get(canvas) !== canvasState(canvas))),
        );
        const buttons = Array.from(dialog.querySelectorAll<HTMLElement>('button, [role="button"]')).filter(
          (button) => enabled(button) && /^(确定|完成)$/.test(button.textContent?.trim() || ""),
        );
        return !busy && (imageReady || canvasReady) && buttons.length === 1 ? buttons[0] : undefined;
      },
      "REDNOTE_COVER_PROCESSING_TIMEOUT",
      120000,
    );
    confirm.click();
    await wait(() => (dialogs().length === 0 ? true : undefined), "REDNOTE_COVER_CONFIRM_TIMEOUT");
    console.info("小红书封面图片已处理并确认");
  }

  let stage = "page";
  try {
    if (coverOnly) {
      stage = "cover";
      if (!cover) throw new Error("REDNOTE_COVER_MISSING");
      await uploadCover(cover);
      return { ok: true, coverRequested: true, coverConfirmed: true };
    }
    // 等待页面加载
    await waitForElement('span[class="title"]');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 上传视频
    stage = "video";
    await uploadVideo();

    stage = "fields";
    // 填写内容
    // 等待标题输入框出现
    await waitForElement('input[type="text"]');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 填写标题
    const titleInput = document.querySelector('input[type="text"]') as HTMLInputElement;
    if (titleInput) {
      const finalTitle = title?.slice(0, 20) || "";
      titleInput.value = finalTitle;
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // 填写内容和标签
    const editor = document.querySelector('div[contenteditable="true"]') as HTMLElement;
    if (!editor) {
      throw new Error("REDNOTE_EDITOR_NOT_READY");
    }

    // 填写正文内容
    editor.focus();
    const contentPasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });
    contentPasteEvent.clipboardData.setData("text/plain", `${content}\n` || "");
    editor.dispatchEvent(contentPasteEvent);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    editor.blur();

    // 添加标签
    if (tags && tags.length > 0) {
      for (const tag of tags) {
        editor.focus();
        const tagPasteEvent = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: new DataTransfer(),
        });
        tagPasteEvent.clipboardData.setData("text/plain", `#${tag}`);
        editor.dispatchEvent(tagPasteEvent);
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // 模拟回车键按下以确认标签
        const enterEvent = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
        });
        editor.dispatchEvent(enterEvent);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    stage = "cover";
    // 上传封面
    if (cover) {
      await uploadCover(cover);
    }

    stage = "schedule";
    // 处理定时发布
    if (scheduledPublishTime) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await setScheduledPublishTime(scheduledPublishTime);
    }

    stage = "publish";
    if (data.isAutoPublish === true) {
      // 轮询期间重新查询按钮，避免页面重渲染后持有失效节点；视频处理较慢，最多约 60s
      const findPublishButton = () =>
        Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("发布"));

      let publishButton = findPublishButton();
      for (let i = 0; i < 60; i++) {
        publishButton = findPublishButton();
        if (publishButton && publishButton.getAttribute("aria-disabled") !== "true") break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (publishButton && publishButton.getAttribute("aria-disabled") !== "true") {
        publishButton.dispatchEvent(new Event("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 10000));
        window.location.href = "https://creator.xiaohongshu.com/new/note-manager";
      } else {
        console.debug("小红书：发布按钮仍不可用，跳过自动发布");
      }
    }
    return { ok: true, coverRequested: !!cover, coverConfirmed: !!cover };
  } catch (error) {
    const text = String(error);
    const visible = (node: Element) =>
      Array.from(node.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
    const modals = Array.from(document.querySelectorAll<HTMLElement>(".main-cover-editor-modal")).filter(visible);
    return {
      ok: false,
      code: text.match(/REDNOTE_[A-Z_]+/)?.[0] || "REDNOTE_STEP_FAILED",
      stage,
      // Structural diagnostics only; never return file URLs, account data or page HTML.
      details: {
        emptyCoverEntries: document.querySelectorAll("div.noCover.uploadCover").length,
        currentCoverEntries: document.querySelectorAll(".cover-plugin-preview .cover--column").length,
        coverDialogs: modals.length,
        fileInputs: modals
          .flatMap((modal) => Array.from(modal.querySelectorAll<HTMLInputElement>('input[type="file"]')))
          .map((input) => ({ accept: input.accept, className: input.className, disabled: input.disabled })),
      },
    };
  }
}
