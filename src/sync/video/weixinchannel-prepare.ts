import type { VideoData } from "~sync/common";

export interface WeixinChannelPrepareResult {
  status: "filled" | "needs_attention" | "result_unconfirmed";
  code: string;
  evidence?: Record<string, unknown>;
}

/** Runs inside the platform tab. It never clicks save or publish. */
export async function prepareVideoWeixinChannel(data: VideoData): Promise<WeixinChannelPrepareResult> {
  function find(selector: string, root: Document | ShadowRoot = document): Element | null {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.shadowRoot) {
        const nested = find(selector, element.shadowRoot);
        if (nested) return nested;
      }
    }
    return null;
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

  const input = (await waitFor('input[type="file"]', 20000)) as HTMLInputElement | null;
  if (!input) {
    const pageText = document.body?.innerText || "";
    return {
      status: "needs_attention",
      code: /扫码|登录|登錄/.test(pageText) ? "LOGIN_REQUIRED" : "UPLOAD_PAGE_REQUIRED",
      evidence: { url: location.href },
    };
  }
  if (!data.video?.url || !data.video.name) {
    return { status: "needs_attention", code: "MATERIAL_MISSING" };
  }
  const response = await fetch(data.video.url);
  const blob = await response.blob();
  const file = new File([blob], data.video.name, { type: data.video.type || "video/mp4" });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("input", { bubbles: true }));

  const titleInput = (await waitFor(
    'input[placeholder="填写短标题有机会获得更多流量"], input[placeholder="概括视频主要内容，字数建议6-16个字符"], input[placeholder*="标题"]',
    60000,
  )) as HTMLInputElement | null;
  const descriptionInput = (await waitFor('div[data-placeholder="添加描述"]', 10000)) as HTMLDivElement | null;
  if (!titleInput || !descriptionInput) {
    return {
      status: "result_unconfirmed",
      code: "FIELDS_NOT_READY",
      evidence: { titleFound: !!titleInput, descriptionFound: !!descriptionInput, url: location.href },
    };
  }

  titleInput.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(titleInput, data.title);
  titleInput.dispatchEvent(new InputEvent("input", { bubbles: true, data: data.title }));
  titleInput.dispatchEvent(new Event("change", { bubbles: true }));

  descriptionInput.focus();
  const paste = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: new DataTransfer(),
  });
  paste.clipboardData?.setData("text/plain", data.content);
  descriptionInput.dispatchEvent(paste);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const actualTitle = titleInput.value.trim();
  const actualBody = descriptionInput.innerText.trim();
  let videoPreview = false;
  for (let i = 0; i < 40; i++) {
    const preview = find("video") as HTMLVideoElement | null;
    videoPreview = !!preview?.currentSrc || !!preview?.src || !!preview?.poster;
    if (videoPreview) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const evidence = {
    title: actualTitle,
    body: actualBody,
    videoName: data.video.name,
    videoPreview,
    url: location.href,
  };
  if (actualTitle !== data.title || !actualBody.includes(data.content)) {
    return { status: "result_unconfirmed", code: "FIELDS_NOT_VERIFIED", evidence };
  }
  if (!videoPreview) {
    return { status: "result_unconfirmed", code: "UPLOAD_UNCONFIRMED", evidence };
  }
  return { status: "filled", code: "FIELDS_VERIFIED", evidence };
}
