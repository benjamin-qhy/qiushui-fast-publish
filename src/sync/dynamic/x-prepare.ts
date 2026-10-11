import type { DynamicData } from "../common";

export interface XDynamicResult {
  status: "needs_attention" | "result_unconfirmed" | "filled";
  code: string;
  evidence?: Record<string, unknown>;
}

/** Read-only site inspection before adapting the X image composer. */
export async function prepareDynamicX(
  data: DynamicData,
  mode: "inspect" | "fill" | "inspect_upload" | "verify" = "inspect",
): Promise<XDynamicResult> {
  if (mode === "inspect") {
    const deadline = Date.now() + 20000;
    while (
      Date.now() < deadline &&
      !document.querySelector('[data-testid="tweetTextarea_0"][contenteditable="true"]')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const editor = document.querySelector<HTMLElement>('[data-testid="tweetTextarea_0"][contenteditable="true"]');
  const postContent = data.textOnly
    ? data.content
    : `${data.title}\n${data.content}${data.tags?.length ? ` ${data.tags.map((tag) => `#${tag}`).join(" ")}` : ""}`;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const attachedImages = () =>
    Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="attachments"] img')).filter(
      (image) => image.complete && image.naturalWidth > 0,
    );
  if (mode === "verify") {
    const imageCount = attachedImages().length;
    const evidence = {
      url: location.href,
      body: editor?.innerText,
      imageCount,
      imageNames: data.images.map((image) => image.name),
      imageSizes: attachedImages().map((image) => ({ width: image.naturalWidth, height: image.naturalHeight })),
    };
    return editor && normalize(editor.innerText) === normalize(postContent) && imageCount === data.images.length
      ? { status: "filled", code: "FIELDS_VERIFIED", evidence }
      : { status: "result_unconfirmed", code: "RECONCILE_REQUIRED", evidence };
  }
  if (mode === "fill") {
    if (!editor) return { status: "needs_attention", code: "EDITOR_NOT_READY", evidence: { url: location.href } };
    if (data.textOnly && normalize(editor.innerText) === normalize(postContent) && attachedImages().length === 0)
      return {
        status: "filled",
        code: "FIELDS_VERIFIED",
        evidence: { url: location.href, body: editor.innerText, imageCount: 0, textOnly: true, alreadyFilled: true },
      };
    if (editor.innerText.trim() || attachedImages().length)
      return { status: "needs_attention", code: "EDITOR_NOT_EMPTY", evidence: { url: location.href } };
    const transfer = new DataTransfer();
    transfer.setData("text/plain", postContent);
    editor.focus();
    editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (normalize(editor.innerText) !== normalize(postContent))
      return {
        status: "result_unconfirmed",
        code: "FIELDS_NOT_VERIFIED",
        evidence: { body: editor.innerText, url: location.href },
      };
    if (data.textOnly) {
      const imageCount = attachedImages().length;
      return imageCount === 0
        ? {
            status: "filled",
            code: "FIELDS_VERIFIED",
            evidence: { url: location.href, body: editor.innerText, imageCount, textOnly: true },
          }
        : {
            status: "result_unconfirmed",
            code: "RECONCILE_REQUIRED",
            evidence: { url: location.href, body: editor.innerText, imageCount },
          };
    }
    const input = document.querySelector<HTMLInputElement>('input[data-testid="fileInput"][type="file"]');
    if (!input)
      return {
        status: "result_unconfirmed",
        code: "UPLOAD_PAGE_REQUIRED",
        evidence: { body: editor.innerText, url: location.href },
      };
    const files = new DataTransfer();
    for (const image of data.images) {
      const response = await fetch(image.url);
      if (!response.ok) throw new Error(`MATERIAL_FETCH_FAILED: ${image.name}`);
      const blob = await response.blob();
      files.items.add(new File([blob], image.name, { type: image.type || blob.type }));
    }
    input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const imageCount = attachedImages().length;
    if (normalize(editor.innerText) === normalize(postContent) && imageCount === data.images.length)
      return {
        status: "filled",
        code: "FIELDS_VERIFIED",
        evidence: {
          url: location.href,
          body: editor.innerText,
          imageCount,
          imageNames: data.images.map((image) => image.name),
        },
      };
    return {
      status: "result_unconfirmed",
      code: "UPLOAD_INSPECTION_REQUIRED",
      evidence: {
        url: location.href,
        body: editor.innerText,
        attachments: Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-testid*="attachment"], [data-testid*="media"], [data-testid*="removeMedia"]',
          ),
        )
          .slice(0, 25)
          .map((element) => ({ testId: element.getAttribute("data-testid"), text: element.innerText.slice(0, 70) })),
        images: Array.from(document.querySelectorAll<HTMLImageElement>("img"))
          .filter((image) => image.naturalWidth >= 80)
          .slice(-15)
          .map((image) => ({
            className: image.className,
            parentTestId: image.parentElement?.getAttribute("data-testid"),
            width: image.naturalWidth,
            height: image.naturalHeight,
          })),
      },
    };
  }
  if (mode === "inspect_upload") {
    return {
      status: "result_unconfirmed",
      code: "RECONCILE_REQUIRED",
      evidence: {
        url: location.href,
        body: editor?.innerText,
        attachmentNodes: Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-testid*="attachment"], [data-testid*="media"], [data-testid*="removeMedia"]',
          ),
        )
          .slice(0, 30)
          .map((element) => ({ testId: element.getAttribute("data-testid"), outer: element.outerHTML.slice(0, 350) })),
      },
    };
  }
  const editors = Array.from(document.querySelectorAll<HTMLElement>('[contenteditable="true"]'))
    .slice(0, 12)
    .map((element) => ({
      className: element.className,
      role: element.getAttribute("role"),
      testId: element.getAttribute("data-testid"),
      outer: element.outerHTML.slice(0, 500),
      text: element.innerText.slice(0, 200),
    }));
  const fileInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).map((input) => ({
    outer: input.outerHTML.slice(0, 500),
    accept: input.accept,
  }));
  return {
    status: "needs_attention",
    code: "EDITOR_INSPECTION_REQUIRED",
    evidence: {
      url: location.href,
      requestedImageCount: data.images.length,
      editors,
      fileInputs,
      buttons: Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']"))
        .filter((element) => element.getBoundingClientRect().width > 0)
        .slice(0, 35)
        .map((element) => ({
          text: element.innerText.trim().slice(0, 70),
          testId: element.getAttribute("data-testid"),
        })),
      pageText: document.body.innerText.slice(0, 700),
    },
  };
}
