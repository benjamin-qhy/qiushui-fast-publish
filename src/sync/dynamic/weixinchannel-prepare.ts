import type { DynamicData } from "../common";

export interface WeixinChannelDynamicResult {
  status: "filled" | "needs_attention" | "result_unconfirmed";
  code: string;
  evidence?: Record<string, unknown>;
  message?: string;
}

/** Runs in the video-channel page. It only fills the image post; it never clicks publish. */
export async function prepareDynamicWeixinChannel(data: DynamicData): Promise<WeixinChannelDynamicResult> {
  function collect(selector: string, root: Document | ShadowRoot = document): Element[] {
    const matches = Array.from(root.querySelectorAll(selector));
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.shadowRoot) matches.push(...collect(selector, element.shadowRoot));
    }
    return matches;
  }
  function find(selector: string): Element | null {
    return collect(selector).find((element) => Boolean(element.getClientRects().length)) || null;
  }
  async function waitFor(selector: string, duration: number): Promise<Element | null> {
    const deadline = Date.now() + duration;
    while (Date.now() < deadline) {
      const element = find(selector);
      if (element) return element;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }
  function imagePreviews(): HTMLImageElement[] {
    return collect("img")
      .filter((item): item is HTMLImageElement => item instanceof HTMLImageElement)
      .filter((image) => image.complete && image.naturalWidth >= 100 && image.naturalHeight >= 100);
  }
  const body = `${data.content}${data.tags?.length ? ` ${data.tags.map((tag) => `#${tag}`).join(" ")}` : ""}`;
  if (
    !data.title ||
    data.title.length > 22 ||
    !body.trim() ||
    body.length > 1000 ||
    !data.images.length ||
    data.images.length > 18 ||
    data.videos?.length
  ) {
    return { status: "needs_attention", code: "INVALID_CONTENT" };
  }
  // The real editor keeps its file input hidden and opens it through a styled button.
  let input = collect('input[type="file"][accept*="image"]')[0] as HTMLInputElement | undefined;
  const inputDeadline = Date.now() + 20000;
  while (!input && Date.now() < inputDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    input = collect('input[type="file"][accept*="image"]')[0] as HTMLInputElement | undefined;
  }
  if (!input) {
    const pageText = document.body?.innerText || "";
    return {
      status: "needs_attention",
      code: /扫码|登录|登錄/.test(pageText) ? "LOGIN_REQUIRED" : "UPLOAD_PAGE_REQUIRED",
      evidence: {
        url: location.href,
        pageText: pageText.slice(0, 1200),
        inputs: collect("input")
          .slice(0, 12)
          .map((element) => ({
            type: element.getAttribute("type"),
            accept: element.getAttribute("accept"),
            outer: element.outerHTML.slice(0, 300),
          })),
        buttons: collect("button")
          .slice(0, 20)
          .map((element) => element.textContent?.trim().slice(0, 60)),
        frames: Array.from(document.querySelectorAll("iframe")).map((frame) => frame.src.slice(0, 150)),
      },
    };
  }
  const titleInput = (await waitFor('input[placeholder*="标题"]', 10000)) as HTMLInputElement | null;
  const editor = (await waitFor('div[data-placeholder*="添加描述"], div.input-editor', 10000)) as HTMLElement | null;
  if (!titleInput || !editor) {
    return {
      status: "needs_attention",
      code: "EDITOR_NOT_READY",
      evidence: { titleFound: !!titleInput, bodyFound: !!editor, url: location.href },
    };
  }
  if (titleInput.value.trim() || editor.innerText.trim()) {
    return { status: "needs_attention", code: "EDITOR_NOT_EMPTY", evidence: { url: location.href } };
  }
  const previewsBefore = new Set(imagePreviews().map((image) => image.currentSrc || image.src));
  try {
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
    const uploadDeadline = Date.now() + 60000;
    let newPreviews: HTMLImageElement[] = [];
    while (Date.now() < uploadDeadline) {
      newPreviews = imagePreviews().filter((image) => !previewsBefore.has(image.currentSrc || image.src));
      if (newPreviews.length >= data.images.length) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    titleInput.focus();
    setter?.call(titleInput, data.title);
    titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    titleInput.dispatchEvent(new Event("change", { bubbles: true }));
    editor.focus();
    const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
    paste.clipboardData?.setData("text/plain", body);
    editor.dispatchEvent(paste);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const actualTitle = titleInput.value.trim();
    const actualBody = editor.innerText.trim();
    const evidence = {
      title: actualTitle,
      body: actualBody,
      imageCount: newPreviews.length,
      imageNames: data.images.map((image) => image.name),
      imageSources: newPreviews.map((image) => image.currentSrc || image.src),
      url: location.href,
    };
    if (actualTitle !== data.title || actualBody !== body.trim()) {
      return { status: "result_unconfirmed", code: "FIELDS_NOT_VERIFIED", evidence };
    }
    if (newPreviews.length !== data.images.length) {
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
