import type { DynamicData } from "../common";

export interface ZsxqDynamicData extends DynamicData {
  targetSphere: string;
  replaceExisting?: { sourceTaskId: string; title: string; content: string; tags: string[]; imageCount: number };
}

export interface ZsxqDynamicResult {
  status: "needs_attention" | "result_unconfirmed" | "filled";
  code: string;
  evidence?: Record<string, unknown>;
}

/** Read-only first pass; the target sphere must be identified before any editor changes. */
export async function prepareDynamicZsxq(
  data: ZsxqDynamicData,
  mode: "inspect" | "open_editor" | "fill" | "inspect_upload" | "replace_known" = "inspect",
): Promise<ZsxqDynamicResult> {
  const target = data.targetSphere.trim();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !document.body.innerText.includes(target)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const exactLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/group/"]')).filter(
    (anchor) => anchor.innerText.trim() === target,
  );
  const exactGroupUrl = exactLinks.length === 1 ? new URL(exactLinks[0].href) : null;
  if (mode === "fill" || mode === "inspect_upload" || mode === "replace_known") {
    if (!exactGroupUrl || exactGroupUrl.pathname !== location.pathname)
      return {
        status: "needs_attention",
        code: "TARGET_SPHERE_UNCONFIRMED",
        evidence: { targetSphere: target, url: location.href },
      };
    const editor = document.querySelector<HTMLElement>(".ql-editor");
    if (!editor)
      return {
        status: "needs_attention",
        code: "EDITOR_NOT_READY",
        evidence: { targetSphere: target, url: location.href },
      };
    const postContent = data.textOnly
      ? data.content
      : `${data.title}\n${data.content}${data.tags?.length ? ` ${data.tags.map((tag) => `#${tag}#`).join(" ")}` : ""}`;
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    if (mode === "replace_known") {
      const old = data.replaceExisting;
      const oldBody =
        old &&
        `${old.title}\n${old.content}${old.tags?.length ? ` ${old.tags.map((tag) => `#${tag}#`).join(" ")}` : ""}`;
      const imageCount = Array.from(
        document.querySelectorAll<HTMLImageElement>(".upload-container .image-item img"),
      ).filter((image) => image.complete && image.naturalWidth > 0).length;
      if (
        !old ||
        normalize(editor.innerText) !== normalize(oldBody || "") ||
        (data.textOnly
          ? imageCount !== 0
          : ![0, old.imageCount].includes(imageCount) ||
            (old.imageCount !== 0 && old.imageCount !== data.images.length))
      )
        return {
          status: "result_unconfirmed",
          code: "RECONCILE_REQUIRED",
          evidence: { body: editor.innerText, imageCount, targetSphere: target, url: location.href },
        };
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const transfer = new DataTransfer();
      transfer.setData("text/plain", postContent);
      editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (normalize(editor.innerText) !== normalize(postContent))
        return {
          status: "result_unconfirmed",
          code: "FIELDS_NOT_VERIFIED",
          evidence: { body: editor.innerText, imageCount, targetSphere: target, url: location.href },
        };
      if (imageCount === 0 && !data.textOnly) {
        const input = document.querySelector<HTMLInputElement>('input[type="file"][accept="image/*"]');
        if (!input)
          return {
            status: "result_unconfirmed",
            code: "UPLOAD_PAGE_REQUIRED",
            evidence: { body: editor.innerText, imageCount, targetSphere: target, url: location.href },
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
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      const currentImageCount = Array.from(
        document.querySelectorAll<HTMLImageElement>(".upload-container .image-item img"),
      ).filter((image) => image.complete && image.naturalWidth > 0).length;
      const evidence = {
        targetSphere: target,
        groupUrl: exactGroupUrl.href,
        body: editor.innerText,
        imageCount: currentImageCount,
        imageNames: data.images.map((image) => image.name),
        priorContentTaskId: old.sourceTaskId,
        priorImageCount: imageCount,
      };
      return normalize(editor.innerText) === normalize(postContent) && currentImageCount === data.images.length
        ? { status: "filled", code: "FIELDS_VERIFIED", evidence }
        : { status: "result_unconfirmed", code: "FIELDS_NOT_VERIFIED", evidence };
    }
    if (mode === "fill") {
      if (
        data.textOnly &&
        normalize(editor.innerText) === normalize(postContent) &&
        document.querySelectorAll(".upload-container .image-item img").length === 0
      )
        return {
          status: "filled",
          code: "FIELDS_VERIFIED",
          evidence: {
            targetSphere: target,
            groupUrl: exactGroupUrl.href,
            body: editor.innerText,
            imageCount: 0,
            textOnly: true,
            alreadyFilled: true,
          },
        };
      if (editor.innerText.trim())
        return {
          status: "needs_attention",
          code: "EDITOR_NOT_EMPTY",
          evidence: { targetSphere: target, body: editor.innerText, url: location.href },
        };
      const transfer = new DataTransfer();
      transfer.setData("text/plain", postContent);
      editor.focus();
      editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (normalize(editor.innerText) !== normalize(postContent))
        return {
          status: "result_unconfirmed",
          code: "FIELDS_NOT_VERIFIED",
          evidence: { body: editor.innerText, targetSphere: target, url: location.href },
        };
      if (data.textOnly) {
        const imageCount = document.querySelectorAll(".upload-container .image-item img").length;
        return imageCount === 0
          ? {
              status: "filled",
              code: "FIELDS_VERIFIED",
              evidence: {
                targetSphere: target,
                body: editor.innerText,
                imageCount,
                textOnly: true,
                groupUrl: exactGroupUrl.href,
              },
            }
          : {
              status: "result_unconfirmed",
              code: "RECONCILE_REQUIRED",
              evidence: { targetSphere: target, body: editor.innerText, imageCount },
            };
      }
      const input = document.querySelector<HTMLInputElement>('input[type="file"][accept="image/*"]');
      if (!input)
        return {
          status: "result_unconfirmed",
          code: "UPLOAD_PAGE_REQUIRED",
          evidence: { body: editor.innerText, targetSphere: target, url: location.href },
        };
      const images = Array.from(document.querySelectorAll<HTMLImageElement>("img"));
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
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const newImages = Array.from(document.querySelectorAll<HTMLImageElement>("img")).filter(
        (image) => !images.includes(image),
      );
      const attachedImages = Array.from(
        document.querySelectorAll<HTMLImageElement>(".upload-container .image-item img"),
      ).filter((image) => image.complete && image.naturalWidth > 0);
      if (normalize(editor.innerText) === normalize(postContent) && attachedImages.length === data.images.length)
        return {
          status: "filled",
          code: "FIELDS_VERIFIED",
          evidence: {
            targetSphere: target,
            groupUrl: exactGroupUrl.href,
            body: editor.innerText,
            imageCount: attachedImages.length,
            imageNames: data.images.map((image) => image.name),
          },
        };
      return {
        status: "result_unconfirmed",
        code: "UPLOAD_INSPECTION_REQUIRED",
        evidence: {
          targetSphere: target,
          url: location.href,
          body: editor.innerText,
          newImages: newImages.slice(0, 15).map((image) => ({
            className: image.className,
            parentClassName: image.parentElement?.className,
            width: image.naturalWidth,
            height: image.naturalHeight,
          })),
          mediaElements: Array.from(
            document.querySelectorAll<HTMLElement>('[class*="image"], [class*="picture"], [class*="upload"]'),
          )
            .filter((element) => element.getBoundingClientRect().width > 0)
            .slice(-20)
            .map((element) => ({ className: element.className, text: element.innerText.trim().slice(0, 80) })),
        },
      };
    }
    const attachedImages = Array.from(
      document.querySelectorAll<HTMLImageElement>(".upload-container .image-item img"),
    ).filter((image) => image.complete && image.naturalWidth > 0);
    const evidence = {
      targetSphere: target,
      groupUrl: exactGroupUrl.href,
      body: editor.innerText,
      imageCount: attachedImages.length,
      imageNames: data.images.map((image) => image.name),
      url: location.href,
    };
    return normalize(editor.innerText) === normalize(postContent) && attachedImages.length === data.images.length
      ? { status: "filled", code: "FIELDS_VERIFIED", evidence }
      : { status: "result_unconfirmed", code: "RECONCILE_REQUIRED", evidence };
  }
  if (mode === "open_editor") {
    if (!exactGroupUrl || exactGroupUrl.pathname !== location.pathname)
      return {
        status: "needs_attention",
        code: "TARGET_SPHERE_UNCONFIRMED",
        evidence: { targetSphere: target, url: location.href },
      };
    const triggerDeadline = Date.now() + 20000;
    let trigger = document.querySelector<HTMLElement>(".post-topic-head");
    while (Date.now() < triggerDeadline && !trigger) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      trigger = document.querySelector<HTMLElement>(".post-topic-head");
    }
    if (!trigger)
      return {
        status: "needs_attention",
        code: "EDITOR_NOT_READY",
        evidence: { targetSphere: target, url: location.href },
      };
    trigger.click();
    const editorDeadline = Date.now() + 15000;
    while (Date.now() < editorDeadline && !document.querySelector(".ql-editor")) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const editor = document.querySelector<HTMLElement>(".ql-editor");
    return {
      status: "needs_attention",
      code: "EDITOR_INSPECTION_REQUIRED",
      evidence: {
        targetSphere: target,
        groupUrl: exactGroupUrl.href,
        url: location.href,
        editor: editor?.outerHTML.slice(0, 800),
        fileInputs: Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).map((input) =>
          input.outerHTML.slice(0, 500),
        ),
        buttons: Array.from(document.querySelectorAll<HTMLElement>("button, .submit-btn"))
          .filter((button) => button.getBoundingClientRect().width > 0)
          .slice(-25)
          .map((button) => ({ className: button.className, text: button.innerText.trim().slice(0, 80) })),
      },
    };
  }
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .filter((anchor) => anchor.innerText.includes(target) || anchor.href.includes("/group/"))
    .slice(0, 30)
    .map((anchor) => ({ text: anchor.innerText.trim().slice(0, 120), href: anchor.href }));
  const headings = Array.from(document.querySelectorAll<HTMLElement>("h1, h2, h3, .group-name, .post-topic-head"))
    .slice(0, 30)
    .map((element) => ({ className: element.className, text: element.innerText.trim().slice(0, 120) }));
  const editors = Array.from(document.querySelectorAll<HTMLElement>(".ql-editor, [contenteditable='true']"))
    .slice(0, 8)
    .map((element) => ({ className: element.className, text: element.innerText.trim().slice(0, 200) }));
  const targetNodes = Array.from(document.querySelectorAll<HTMLElement>("body *"))
    .filter((element) => element.children.length === 0 && element.innerText?.trim() === target)
    .slice(0, 8)
    .map((element) => ({
      outer: element.outerHTML.slice(0, 500),
      parent: element.parentElement?.outerHTML.slice(0, 700),
      grandparent: element.parentElement?.parentElement?.outerHTML.slice(0, 700),
    }));
  const evidence = {
    targetSphere: target,
    url: location.href,
    anchors,
    headings,
    editors,
    targetNodes,
    pageText: document.body.innerText.slice(0, 1000),
  };
  return {
    status: "needs_attention",
    code: "SPHERE_INSPECTION_REQUIRED",
    evidence,
  };
}
