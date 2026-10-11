import type { DynamicData } from "../common";

export interface ToutiaoDynamicResult {
  status: "filled" | "needs_attention" | "result_unconfirmed";
  code: string;
  evidence?: Record<string, unknown>;
  message?: string;
}

export interface KnownEditorContent {
  sourceTaskId: string;
  title: string;
  content: string;
  tags: string[];
  imageCount: number;
}

/** Fills a Toutiao image post without clicking publish. */
export async function prepareDynamicToutiao(
  data: DynamicData & { replaceExisting?: KnownEditorContent },
  mode: "start" | "inspect" | "finish_upload" | "verify" | "replace_known" = "start",
): Promise<ToutiaoDynamicResult> {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 500));
  const body = data.textOnly
    ? data.content
    : `${data.title}\n\n${data.content}${data.tags?.length ? ` ${data.tags.map((tag) => `#${tag}#`).join(" ")}` : ""}`;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  async function waitFor<T extends Element>(selector: string, duration: number): Promise<T | null> {
    const deadline = Date.now() + duration;
    while (Date.now() < deadline) {
      const element = document.querySelector<T>(selector);
      if (element) return element;
      await pause();
    }
    return null;
  }
  if ((!data.textOnly && (!data.title || !data.images.length)) || !data.content?.trim() || data.videos?.length) {
    return { status: "needs_attention", code: "INVALID_CONTENT" };
  }
  try {
    const editor = await waitFor<HTMLElement>('div[contenteditable="true"]', 20000);
    if (!editor) {
      const pageText = document.body?.innerText || "";
      return {
        status: "needs_attention",
        code: /扫码|登录/.test(pageText) ? "LOGIN_REQUIRED" : "EDITOR_NOT_READY",
        evidence: { url: location.href, pageText: pageText.slice(0, 700) },
      };
    }
    if (mode === "inspect") {
      return {
        status: "result_unconfirmed",
        code: "RECONCILE_REQUIRED",
        evidence: {
          editors: Array.from(document.querySelectorAll<HTMLElement>('div[contenteditable="true"]'))
            .slice(0, 8)
            .map((element) => ({
              text: element.innerText.slice(0, 300),
              className: element.className,
              outer: element.outerHTML.slice(0, 300),
            })),
          images: Array.from(document.querySelectorAll<HTMLImageElement>("img"))
            .slice(0, 30)
            .map((image) => ({
              outer: image.outerHTML.slice(0, 400),
              parent: image.parentElement?.outerHTML.slice(0, 500),
            })),
          fileInputs: Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).map((input) => ({
            outer: input.outerHTML.slice(0, 400),
            fileCount: input.files?.length || 0,
          })),
          dialogs: Array.from(
            document.querySelectorAll<HTMLElement>('[role="dialog"], [class*="modal"], [class*="upload"]'),
          )
            .filter((element) => element.getBoundingClientRect().width > 0)
            .slice(0, 12)
            .map((element) => ({
              className: element.className,
              text: element.innerText.slice(0, 500),
              outer: element.outerHTML.slice(0, 1200),
            })),
          url: location.href,
        },
      };
    }
    if (mode === "finish_upload") {
      const uploadPanel = document.querySelector<HTMLElement>(".upload-image-panel");
      const uploadedCount = Number(uploadPanel?.innerText.match(/已上传\s*(\d+)\s*张图片/)?.[1] || 0);
      if (normalize(editor.innerText) !== normalize(body) || uploadedCount !== data.images.length)
        return {
          status: "result_unconfirmed",
          code: "RECONCILE_REQUIRED",
          evidence: { body: editor.innerText, uploadedCount, url: location.href },
        };
      const confirmButton = Array.from(uploadPanel?.querySelectorAll<HTMLButtonElement>("button") || []).find(
        (button) => button.innerText.trim() === "确定",
      );
      if (!confirmButton)
        return {
          status: "result_unconfirmed",
          code: "CONFIRM_BUTTON_MISSING",
          evidence: { uploadedCount, url: location.href },
        };
      confirmButton.click();
      const deadline = Date.now() + 20000;
      let imageCount = 0;
      while (Date.now() < deadline) {
        imageCount = Number(
          document.querySelector<HTMLElement>(".upload-box")?.innerText.match(/共\s*(\d+)\s*张[，,]\s*还能上传/)?.[1] ||
            0,
        );
        if (imageCount === data.images.length) break;
        await pause();
      }
      const evidence = { body: editor.innerText, imageCount, url: location.href };
      return normalize(editor.innerText) === normalize(body) && imageCount === data.images.length
        ? { status: "filled", code: "FIELDS_VERIFIED", evidence }
        : { status: "result_unconfirmed", code: "FIELDS_NOT_VERIFIED", evidence };
    }
    if (mode === "verify") {
      const uploadBox = document.querySelector<HTMLElement>(".upload-box");
      const match = uploadBox?.innerText.match(/共\s*(\d+)\s*张[，,]\s*还能上传\s*(\d+)\s*张/);
      const imageCount = match ? Number(match[1]) : 0;
      const evidence = {
        body: editor.innerText,
        imageCount,
        imageNames: data.images.map((image) => image.name),
        url: location.href,
      };
      return normalize(editor.innerText) === normalize(body) && imageCount === data.images.length
        ? { status: "filled", code: "FIELDS_VERIFIED", evidence }
        : { status: "result_unconfirmed", code: "FIELDS_NOT_VERIFIED", evidence };
    }
    if (mode === "replace_known") {
      const old = data.replaceExisting;
      const oldBody =
        old &&
        `${old.title}\n\n${old.content}${old.tags?.length ? ` ${old.tags.map((tag) => `#${tag}#`).join(" ")}` : ""}`;
      const uploadBox = document.querySelector<HTMLElement>(".upload-box");
      const oldImageCount = Number(uploadBox?.innerText.match(/共\s*(\d+)\s*张[，,]\s*还能上传/)?.[1] || 0);
      if (
        !old ||
        normalize(editor.innerText) !== normalize(oldBody || "") ||
        oldImageCount !== old.imageCount ||
        (!data.textOnly && old.imageCount !== 0 && old.imageCount !== data.images.length)
      )
        return {
          status: "result_unconfirmed",
          code: "RECONCILE_REQUIRED",
          evidence: { body: editor.innerText, imageCount: oldImageCount, url: location.href },
        };
      if (data.textOnly) {
        const items = Array.from(document.querySelectorAll<HTMLElement>(".upload-list .img-box-item"));
        if (
          items.length !== old.imageCount ||
          items.some((item) => item.querySelectorAll(".image-remove-btn").length !== 1)
        )
          return {
            status: "result_unconfirmed",
            code: "RECONCILE_REQUIRED",
            evidence: { body: editor.innerText, imageCount: oldImageCount, url: location.href },
          };
        for (const item of items) item.querySelector<HTMLElement>(".image-remove-btn")?.click();
        await pause();
        const remaining = document.querySelectorAll(".upload-list .img-box-item").length;
        if (remaining !== 0)
          return {
            status: "result_unconfirmed",
            code: "RECONCILE_REQUIRED",
            evidence: { body: editor.innerText, imageCount: remaining, url: location.href },
          };
      }
      editor.focus();
      editor.innerText = body;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await pause();
      if (!data.textOnly && old.imageCount === 0) {
        const uploadButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button.syl-toolbar-button")).find(
          (button) => button.textContent?.includes("图片"),
        );
        if (!uploadButton)
          return {
            status: "result_unconfirmed",
            code: "UPLOAD_PAGE_REQUIRED",
            evidence: { body: editor.innerText, url: location.href },
          };
        uploadButton.click();
        const input = await waitFor<HTMLInputElement>('input[type="file"]', 10000);
        if (!input)
          return {
            status: "result_unconfirmed",
            code: "UPLOAD_PAGE_REQUIRED",
            evidence: { body: editor.innerText, url: location.href },
          };
        const transfer = new DataTransfer();
        for (const image of data.images) {
          const response = await fetch(image.url);
          if (!response.ok) throw new Error(`MATERIAL_FETCH_FAILED: ${image.name}`);
          const blob = await response.blob();
          transfer.items.add(new File([blob], image.name, { type: image.type || blob.type }));
        }
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const deadline = Date.now() + 60000;
        let uploaded = 0;
        while (Date.now() < deadline) {
          uploaded = Number(
            document
              .querySelector<HTMLElement>(".upload-image-panel")
              ?.innerText.match(/已上传\s*(\d+)\s*张图片/)?.[1] || 0,
          );
          if (uploaded >= data.images.length) break;
          await pause();
        }
        if (uploaded !== data.images.length)
          return {
            status: "result_unconfirmed",
            code: "UPLOAD_UNCONFIRMED",
            evidence: { body: editor.innerText, uploaded, url: location.href },
          };
        const panel = document.querySelector<HTMLElement>(".upload-image-panel");
        const confirm = Array.from(panel?.querySelectorAll<HTMLButtonElement>("button") || []).find(
          (button) => button.innerText.trim() === "确定",
        );
        if (!confirm)
          return {
            status: "result_unconfirmed",
            code: "CONFIRM_BUTTON_MISSING",
            evidence: { body: editor.innerText, uploaded, url: location.href },
          };
        confirm.click();
        const deadlineVerify = Date.now() + 20000;
        while (Date.now() < deadlineVerify) {
          const current = Number(
            document
              .querySelector<HTMLElement>(".upload-box")
              ?.innerText.match(/共\s*(\d+)\s*张[，,]\s*还能上传/)?.[1] || 0,
          );
          if (current === data.images.length) break;
          await pause();
        }
      }
      const imageCount = Number(
        document.querySelector<HTMLElement>(".upload-box")?.innerText.match(/共\s*(\d+)\s*张[，,]\s*还能上传/)?.[1] ||
          0,
      );
      const evidence = {
        body: editor.innerText,
        imageCount,
        imageNames: data.images.map((image) => image.name),
        priorContentTaskId: old.sourceTaskId,
        priorImageCount: oldImageCount,
        url: location.href,
      };
      return normalize(editor.innerText) === normalize(body) && imageCount === data.images.length
        ? { status: "filled", code: "FIELDS_VERIFIED", evidence }
        : { status: "result_unconfirmed", code: "FIELDS_NOT_VERIFIED", evidence };
    }
    const hasUserContent = Array.from(editor.childNodes).some((node) => {
      if (node.nodeType === Node.TEXT_NODE) return Boolean(node.textContent?.trim());
      if (!(node instanceof Element)) return false;
      const copy = node.cloneNode(true) as Element;
      copy
        .querySelectorAll('.syl-placeholder.ProseMirror-widget, [ignoreel="true"]')
        .forEach((placeholder) => placeholder.remove());
      return Boolean(copy.textContent?.trim() || copy.querySelector("img, video, audio"));
    });
    if (
      data.textOnly &&
      normalize(editor.innerText) === normalize(body) &&
      Number(
        document.querySelector<HTMLElement>(".upload-box")?.innerText.match(/共\s*(\d+)\s*张[，,]\s*还能上传/)?.[1] ||
          0,
      ) === 0
    )
      return {
        status: "filled",
        code: "FIELDS_VERIFIED",
        evidence: { body: editor.innerText, imageCount: 0, textOnly: true, alreadyFilled: true, url: location.href },
      };
    if (hasUserContent) {
      return { status: "needs_attention", code: "EDITOR_NOT_EMPTY", evidence: { url: location.href } };
    }
    editor.focus();
    editor.innerText = body;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    if (data.textOnly) {
      await pause();
      const imageCount = Number(
        document.querySelector<HTMLElement>(".upload-box")?.innerText.match(/共\s*(\d+)\s*张[，,]\s*还能上传/)?.[1] ||
          0,
      );
      const evidence = { body: editor.innerText, imageCount, textOnly: true, url: location.href };
      return normalize(editor.innerText) === normalize(body) && imageCount === 0
        ? { status: "filled", code: "FIELDS_VERIFIED", evidence }
        : { status: "result_unconfirmed", code: "FIELDS_NOT_VERIFIED", evidence };
    }
    const uploadButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button.syl-toolbar-button")).find(
      (button) => button.textContent?.includes("图片"),
    );
    uploadButton?.click();
    const input = await waitFor<HTMLInputElement>('input[type="file"]', 10000);
    if (!input)
      return {
        status: "result_unconfirmed",
        code: "UPLOAD_PAGE_REQUIRED",
        evidence: { body: editor.innerText, url: location.href },
      };
    const transfer = new DataTransfer();
    for (const image of data.images) {
      const response = await fetch(image.url);
      if (!response.ok) throw new Error(`MATERIAL_FETCH_FAILED: ${image.name}`);
      const blob = await response.blob();
      transfer.items.add(new File([blob], image.name, { type: image.type || blob.type }));
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const deadline = Date.now() + 60000;
    let uploadedCount = 0;
    while (Date.now() < deadline) {
      uploadedCount = Number(
        document.querySelector<HTMLElement>(".upload-image-panel")?.innerText.match(/已上传\s*(\d+)\s*张图片/)?.[1] ||
          0,
      );
      if (uploadedCount >= data.images.length) break;
      await pause();
    }
    if (uploadedCount !== data.images.length)
      return {
        status: "result_unconfirmed",
        code: "UPLOAD_UNCONFIRMED",
        evidence: { body: editor.innerText, uploadedCount, url: location.href },
      };
    const uploadPanel = document.querySelector<HTMLElement>(".upload-image-panel");
    const confirm = Array.from(uploadPanel?.querySelectorAll<HTMLButtonElement>("button") || []).find(
      (button) => button.innerText.trim() === "确定",
    );
    if (!confirm)
      return {
        status: "result_unconfirmed",
        code: "CONFIRM_BUTTON_MISSING",
        evidence: { body: editor.innerText, uploadedCount, url: location.href },
      };
    confirm.click();
    const verifyDeadline = Date.now() + 20000;
    let imageCount = 0;
    while (Date.now() < verifyDeadline) {
      imageCount = Number(
        document.querySelector<HTMLElement>(".upload-box")?.innerText.match(/共\s*(\d+)\s*张[，,]\s*还能上传/)?.[1] ||
          0,
      );
      if (imageCount === data.images.length) break;
      await pause();
    }
    const evidence = {
      body: editor.innerText,
      imageCount,
      imageNames: data.images.map((image) => image.name),
      url: location.href,
    };
    if (normalize(editor.innerText) !== normalize(body))
      return { status: "result_unconfirmed", code: "FIELDS_NOT_VERIFIED", evidence };
    if (imageCount !== data.images.length)
      return { status: "result_unconfirmed", code: "UPLOAD_UNCONFIRMED", evidence };
    return { status: "filled", code: "FIELDS_VERIFIED", evidence };
  } catch (error) {
    return {
      status: "result_unconfirmed",
      code: "PAGE_ERROR",
      message: String(error instanceof Error ? error.message : error),
      evidence: { url: location.href },
    };
  }
}
