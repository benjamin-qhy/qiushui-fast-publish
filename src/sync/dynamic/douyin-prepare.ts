import type { DynamicData } from "../common";

export interface DouyinDynamicResult {
  status: "filled" | "needs_attention" | "result_unconfirmed";
  code: string;
  evidence?: Record<string, unknown>;
  message?: string;
}

/** Runs in Douyin's creator page and stops before save or publish. */
export async function prepareDynamicDouyin(
  data: DynamicData,
  mode: "start" | "inspect" | "finish_text" = "start",
): Promise<DouyinDynamicResult> {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 500));
  const body = `${data.content}${data.tags?.length ? ` ${data.tags.map((tag) => `#${tag}`).join(" ")}` : ""}`;
  const normalize = (value: string) =>
    value
      .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
      .replace(/\s+/g, " ")
      .trim();
  async function waitFor<T extends Element>(selector: string, duration: number): Promise<T | null> {
    const deadline = Date.now() + duration;
    while (Date.now() < deadline) {
      const element = document.querySelector<T>(selector);
      if (element) return element;
      await pause();
    }
    return null;
  }
  function previews() {
    return Array.from(document.querySelectorAll<HTMLImageElement>("img")).filter(
      (image) => image.complete && image.naturalWidth >= 80 && image.naturalHeight >= 80,
    );
  }
  if (!data.title || !body.trim() || !data.images.length || data.videos?.length) {
    return { status: "needs_attention", code: "INVALID_CONTENT" };
  }
  try {
    if (mode === "inspect") {
      const title = await waitFor<HTMLInputElement>('input[placeholder="添加作品标题"]', 10000);
      const editor = await waitFor<HTMLElement>('div.editor-comp-publish[contenteditable="true"]', 10000);
      return {
        status: "result_unconfirmed",
        code: "RECONCILE_REQUIRED",
        evidence: {
          title: title?.value,
          body: editor?.innerText,
          inputImageCount: document.querySelector<HTMLInputElement>('input[type="file"][accept*="image"]')?.files
            ?.length,
          imageCandidates: previews()
            .slice(-12)
            .map((image) => ({
              className: image.className,
              parentClassName: image.parentElement?.className,
              width: image.naturalWidth,
              height: image.naturalHeight,
            })),
          url: location.href,
        },
      };
    }
    if (mode === "finish_text") {
      const title = await waitFor<HTMLInputElement>('input[placeholder="添加作品标题"]', 10000);
      const editor = await waitFor<HTMLElement>('div.editor-comp-publish[contenteditable="true"]', 10000);
      if (!title || !editor || normalize(title.value) || normalize(editor.innerText)) {
        return {
          status: "needs_attention",
          code: "EDITOR_NOT_EMPTY",
          evidence: { title: title?.value, body: editor?.innerText, url: location.href },
        };
      }
      const uploaded = previews().filter((image) => String(image.parentElement?.className || "").startsWith("img-"));
      if (new Set(uploaded.map((image) => image.currentSrc || image.src)).size !== data.images.length) {
        return {
          status: "result_unconfirmed",
          code: "UPLOAD_UNCONFIRMED",
          evidence: { imageCount: uploaded.length, url: location.href },
        };
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      title.focus();
      setter?.call(title, data.title);
      title.dispatchEvent(new Event("input", { bubbles: true }));
      editor.focus();
      const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
      paste.clipboardData?.setData("text/plain", body);
      editor.dispatchEvent(paste);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const evidence = {
        title: title.value,
        body: editor.innerText,
        imageCount: uploaded.length,
        imageNames: data.images.map((image) => image.name),
        url: location.href,
      };
      if (title.value !== data.title || normalize(editor.innerText) !== normalize(body)) {
        return { status: "result_unconfirmed", code: "FIELDS_NOT_VERIFIED", evidence };
      }
      return { status: "filled", code: "FIELDS_VERIFIED", evidence };
    }
    const tab = Array.from(document.querySelectorAll<HTMLElement>("div, button, span")).find(
      (element) => element.textContent?.trim() === "发布图文" && element.children.length === 0,
    );
    tab?.click();
    const input = await waitFor<HTMLInputElement>('input[type="file"][accept*="image"]', 20000);
    if (!input) {
      const pageText = document.body?.innerText || "";
      return {
        status: "needs_attention",
        code: /扫码|登录|登錄/.test(pageText) ? "LOGIN_REQUIRED" : "UPLOAD_PAGE_REQUIRED",
        evidence: { url: location.href, pageText: pageText.slice(0, 800) },
      };
    }
    const before = new Set(previews().map((image) => image.currentSrc || image.src));
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
    const title = await waitFor<HTMLInputElement>('input[placeholder="添加作品标题"]', 60000);
    const editor = await waitFor<HTMLElement>('div.editor-comp-publish[contenteditable="true"]', 10000);
    if (!title || !editor) {
      return {
        status: "result_unconfirmed",
        code: "FIELDS_NOT_READY",
        evidence: { titleFound: !!title, bodyFound: !!editor, url: location.href },
      };
    }
    if (normalize(title.value) || normalize(editor.innerText)) {
      return { status: "needs_attention", code: "EDITOR_NOT_EMPTY", evidence: { url: location.href } };
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    title.focus();
    setter?.call(title, data.title);
    title.dispatchEvent(new Event("input", { bubbles: true }));
    editor.focus();
    const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
    paste.clipboardData?.setData("text/plain", body);
    editor.dispatchEvent(paste);
    const deadline = Date.now() + 60000;
    let uploaded = [] as HTMLImageElement[];
    while (Date.now() < deadline) {
      uploaded = previews().filter(
        (image) =>
          String(image.parentElement?.className || "").startsWith("img-") && !before.has(image.currentSrc || image.src),
      );
      if (
        new Set(uploaded.map((image) => image.currentSrc || image.src)).size >= data.images.length &&
        title.value === data.title &&
        normalize(editor.innerText) === normalize(body)
      ) {
        break;
      }
      await pause();
    }
    const uploadedCount = new Set(uploaded.map((image) => image.currentSrc || image.src)).size;
    const evidence = {
      title: title.value,
      body: editor.innerText,
      imageCount: uploadedCount,
      imageNames: data.images.map((image) => image.name),
      url: location.href,
    };
    if (title.value !== data.title || normalize(editor.innerText) !== normalize(body)) {
      return { status: "result_unconfirmed", code: "FIELDS_NOT_VERIFIED", evidence };
    }
    if (uploadedCount !== data.images.length) {
      return { status: "result_unconfirmed", code: "UPLOAD_UNCONFIRMED", evidence };
    }
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
