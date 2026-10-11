import type { DynamicData } from "../common";

export interface RednotePrepareResult {
  status: "filled" | "needs_attention" | "failed" | "result_unconfirmed";
  code: string;
  evidence?: { title: string; body: string; imageCount: number; imageNames: string[]; url: string };
  message?: string;
}

// Self-contained: chrome.scripting serializes this function into the platform page.
// Uses the existing Rednote uploader's DOM workflow, with bounded waits and verification.
export async function prepareDynamicRednote(
  data: DynamicData,
  inspectOnly = false,
  continueEmptyFields = false,
): Promise<RednotePrepareResult> {
  const visible = (element: Element) => Boolean(element.getClientRects().length);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
  const body = `${data.content}${data.tags?.length ? ` ${data.tags.map((tag) => `#${tag}#`).join(" ")}` : ""}`;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const fields = () => ({
    title: Array.from(document.querySelectorAll<HTMLInputElement>('input[type="text"], input:not([type])')).find(
      (element) => visible(element) && /标题/.test(element.placeholder),
    ),
    editor: Array.from(document.querySelectorAll<HTMLElement>('[contenteditable="true"]')).find(visible),
  });
  const imageCount = () => {
    // Filled in from the creator editor's uploaded-image list, not fileInput.files.
    return Array.from(document.querySelectorAll<HTMLImageElement>(".img-list .img-container img.preview")).filter(
      (image) => image.complete && image.naturalWidth > 0,
    ).length;
  };
  const verify = (): RednotePrepareResult | null => {
    const { title, editor } = fields();
    const count = imageCount();
    if (
      title?.value === data.title &&
      editor &&
      normalize(editor.innerText) === normalize(body) &&
      count === data.images.length
    ) {
      return {
        status: "filled",
        code: "FIELDS_VERIFIED",
        evidence: {
          title: title.value,
          body: editor.innerText,
          imageCount: count,
          imageNames: data.images.map((image) => image.name),
          url: location.href,
        },
      };
    }
    return null;
  };
  try {
    const deadline = Date.now() + 20000;
    while (!document.querySelector('input[type="file"]') && !fields().editor && Date.now() < deadline) {
      if (/登录/.test(document.body.innerText) && /手机号|验证码|扫码/.test(document.body.innerText)) {
        return {
          status: "needs_attention",
          code: "LOGIN_REQUIRED",
        };
      }
      await pause();
    }
    if (inspectOnly && !continueEmptyFields) {
      return (
        verify() || {
          status: "result_unconfirmed",
          code: "RECONCILE_REQUIRED",
        }
      );
    }
    if (fields().editor && !continueEmptyFields) {
      return (
        verify() || {
          status: "needs_attention",
          code: "EDITOR_NOT_EMPTY",
        }
      );
    }
    if (!data.images.length || data.videos?.length) {
      return { status: "failed", code: "INVALID_MEDIA" };
    }
    if (continueEmptyFields) {
      const existing = fields();
      if (verify()) return verify()!;
      if (
        !existing.title ||
        !existing.editor ||
        imageCount() !== data.images.length ||
        existing.title.value ||
        normalize(existing.editor.innerText)
      ) {
        return {
          status: "result_unconfirmed",
          code: "RECONCILE_REQUIRED",
        };
      }
    } else {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input)
        return {
          status: "needs_attention",
          code: "UPLOAD_PAGE_REQUIRED",
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
      const uploadDeadline = Date.now() + 60000;
      while (
        (!fields().title || !fields().editor || imageCount() !== data.images.length) &&
        Date.now() < uploadDeadline
      ) {
        if (/验证码|安全验证/.test(document.body.innerText)) {
          return {
            status: "needs_attention",
            code: "MANUAL_CHECK_REQUIRED",
          };
        }
        await pause();
      }
    }
    const { title, editor } = fields();
    if (!title || !editor || imageCount() !== data.images.length) {
      return {
        status: "result_unconfirmed",
        code: "UPLOAD_UNCONFIRMED",
      };
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(title, data.title);
    title.dispatchEvent(new Event("input", { bubbles: true }));
    editor.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", body);
    editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    editor.blur();
    const checkDeadline = Date.now() + 5000;
    while (Date.now() < checkDeadline) {
      const result = verify();
      if (result) return result;
      await pause();
    }
    return {
      status: "result_unconfirmed",
      code: "FIELDS_NOT_VERIFIED",
    };
  } catch (error) {
    return {
      status: "result_unconfirmed",
      code: "PAGE_ERROR",
      message: String(error instanceof Error ? error.message : error),
    };
  }
}
