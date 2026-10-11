import type { DynamicData } from "../common";

export interface MaimaiDynamicResult {
  status: "filled" | "needs_attention" | "result_unconfirmed";
  code: string;
  evidence?: Record<string, unknown>;
  message?: string;
}

/** Fills a Maimai image post without clicking send. */
export async function prepareDynamicMaimai(
  data: DynamicData,
  mode: "start" | "inspect" | "verify" = "start",
): Promise<MaimaiDynamicResult> {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 500));
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const attachedPreviews = () =>
    Array.from(document.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')).filter(
      (image) => image.closest(".flex.flex-row.gap-1") && image.complete && image.naturalWidth > 0,
    );
  async function waitFor<T extends Element>(selector: string, duration: number): Promise<T | null> {
    const deadline = Date.now() + duration;
    while (Date.now() < deadline) {
      const element = document.querySelector<T>(selector);
      if (element) return element;
      await pause();
    }
    return null;
  }
  const tags = data.tags?.length ? ` ${data.tags.map((tag) => `#${tag}`).join(" ")}` : "";
  if ((!data.textOnly && (!data.title || !data.images.length)) || !data.content?.trim() || data.videos?.length) {
    return { status: "needs_attention", code: "INVALID_CONTENT" };
  }
  try {
    if (mode === "inspect") {
      return {
        status: "result_unconfirmed",
        code: "RECONCILE_REQUIRED",
        evidence: {
          url: location.href,
          inputs: Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).map((input) =>
            input.outerHTML.slice(0, 300),
          ),
          images: Array.from(document.querySelectorAll<HTMLImageElement>("img"))
            .filter((image) => image.naturalWidth >= 80)
            .slice(-25)
            .map((image) => ({
              className: image.className,
              parentClassName: image.parentElement?.className,
              grandparentClassName: image.parentElement?.parentElement?.className,
              width: image.naturalWidth,
              height: image.naturalHeight,
              srcStart: (image.currentSrc || image.src).slice(0, 80),
            })),
          editors: Array.from(document.querySelectorAll<HTMLElement>("div[contenteditable]")).map((element) => ({
            className: element.className,
            body: element.innerText.slice(0, 300),
          })),
          uploadNodes: Array.from(
            document.querySelectorAll<HTMLElement>('[class*="picture"], [class*="image"], [class*="upload"]'),
          )
            .filter((element) => element.getBoundingClientRect().width > 0)
            .slice(-30)
            .map((element) => ({ className: element.className, text: element.innerText.slice(0, 80) })),
        },
      };
    }
    const editor = await waitFor<HTMLElement>("div[contenteditable]", 20000);
    if (!editor) {
      const pageText = document.body?.innerText || "";
      return {
        status: "needs_attention",
        code: /扫码|登录/.test(pageText) ? "LOGIN_REQUIRED" : "EDITOR_NOT_READY",
        evidence: { url: location.href },
      };
    }
    const titleInput = document.querySelector<HTMLInputElement>("input[placeholder='输入标题会更受欢迎（选填）']");
    const body = data.textOnly ? data.content : `${titleInput ? "" : `${data.title}\n\n`}${data.content}${tags}`;
    if (
      mode === "start" &&
      data.textOnly &&
      normalize(editor.innerText) === normalize(body) &&
      !titleInput?.value.trim() &&
      attachedPreviews().length === 0
    )
      return {
        status: "filled",
        code: "FIELDS_VERIFIED",
        evidence: {
          title: titleInput?.value,
          body: editor.innerText,
          imageCount: 0,
          textOnly: true,
          alreadyFilled: true,
          url: location.href,
        },
      };
    if (mode === "verify") {
      const imageCount = attachedPreviews().length;
      const evidence = {
        title: titleInput?.value,
        body: editor.innerText,
        imageCount,
        imageNames: data.images.map((image) => image.name),
        url: location.href,
      };
      return (data.textOnly ? !titleInput?.value.trim() : !titleInput || titleInput.value === data.title) &&
        normalize(editor.innerText) === normalize(body) &&
        imageCount === data.images.length
        ? { status: "filled", code: "FIELDS_VERIFIED", evidence }
        : { status: "result_unconfirmed", code: "RECONCILE_REQUIRED", evidence };
    }
    if (editor.innerText.trim() || titleInput?.value.trim() || attachedPreviews().length) {
      return { status: "needs_attention", code: "EDITOR_NOT_EMPTY", evidence: { url: location.href } };
    }
    if (titleInput && !data.textOnly) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(titleInput, data.title);
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
      titleInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
    editor.focus();
    editor.innerText = body;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    if (data.textOnly) {
      await pause();
      const imageCount = attachedPreviews().length;
      const evidence = {
        title: titleInput?.value,
        body: editor.innerText,
        imageCount,
        textOnly: true,
        url: location.href,
      };
      return normalize(editor.innerText) === normalize(body) && imageCount === 0 && !titleInput?.value.trim()
        ? { status: "filled", code: "FIELDS_VERIFIED", evidence }
        : { status: "result_unconfirmed", code: "FIELDS_NOT_VERIFIED", evidence };
    }
    const input = await waitFor<HTMLInputElement>('input[type="file"][id="picture"]', 10000);
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
    let imageCount = 0;
    while (Date.now() < deadline) {
      imageCount = attachedPreviews().length;
      if (imageCount >= data.images.length) break;
      await pause();
    }
    const evidence = {
      title: titleInput?.value,
      body: editor.innerText,
      imageCount,
      imageNames: data.images.map((image) => image.name),
      url: location.href,
    };
    if ((titleInput && titleInput.value !== data.title) || normalize(editor.innerText) !== normalize(body)) {
      return { status: "result_unconfirmed", code: "FIELDS_NOT_VERIFIED", evidence };
    }
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
